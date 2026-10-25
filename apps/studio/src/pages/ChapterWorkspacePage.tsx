import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.ts'
import type { ContextMeta, ChapterRevision, ReviewIssue } from '../lib/types.ts'
import type { ChapterPageProps } from '../app/types.ts'
import { confirmDialog, toast, useResource } from '../lib/hooks.ts'
import { countWords, formatTime, label, safeJson, severityTone, truncate } from '../lib/format.ts'
import { Badge, Card, CopyButton, Empty, ErrorBox, Field, Kv, Loading, Modal, StatusBadge } from '../components/ui.tsx'

interface OutlineFields { summary: string; goal: string; conflict: string; hook: string }

function parseOutline(content: string | null | undefined): OutlineFields | null {
  if (!content) return null
  const parsed = safeJson<Partial<OutlineFields>>(content, {})
  if (typeof parsed !== 'object' || parsed === null) return null
  const pick = (value: unknown): string => (typeof value === 'string' ? value : '')
  return { summary: pick(parsed.summary), goal: pick(parsed.goal), conflict: pick(parsed.conflict), hook: pick(parsed.hook) }
}

export function ChapterWorkspacePage({ projectId, chapterId, navigate }: ChapterPageProps) {
  const detail = useResource(() => api.getChapterDetail(chapterId), [chapterId])
  const health = useResource(() => api.health(), [])
  const [draft, setDraft] = useState('')
  const [baseline, setBaseline] = useState('')
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [selectedIssues, setSelectedIssues] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [instruction, setInstruction] = useState('')
  const [rewriteOpen, setRewriteOpen] = useState(false)
  const [continueOpen, setContinueOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [context, setContext] = useState<ContextMeta | null>(null)

  const data = detail.data
  const latest = data?.latestRevision ?? null
  const viewing: ChapterRevision | null = useMemo(
    () => (viewingId ? data?.revisions.find(item => item.id === viewingId) ?? null : null),
    [data, viewingId],
  )

  useEffect(() => {
    const content = data?.latestRevision?.content ?? ''
    setDraft(content)
    setBaseline(content)
    setViewingId(null)
    setSelectedIssues([])
  }, [data?.latestRevision?.id, data?.chapter.id])

  const dirty = viewing === null && draft !== baseline
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const aiReady = health.data?.hasApiKey === true
  const issues = data?.latestReview?.issues ?? []
  const openIssues = issues.filter(issue => issue.resolutionStatus === 'open')
  const blockers = openIssues.filter(issue => issue.severity !== 'minor')

  const refresh = (): void => { detail.reload() }

  const run = async (key: string, action: () => Promise<unknown>, okMessage: string): Promise<void> => {
    setBusy(key)
    try {
      await action()
      toast.ok(okMessage)
      refresh()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const saveManual = async (): Promise<void> => {
    if (!draft.trim()) {
      toast.error('正文为空，未保存。')
      return
    }
    await run('save', () => api.saveManualRevision(chapterId, draft), '已保存为新的正文版本')
  }

  const finalize = async (): Promise<void> => {
    if (!latest) return
    const confirmed = await confirmDialog({
      title: '定稿这一版？',
      message: `定稿后第 ${data?.chapter.chapterNo} 章会指向版本 #${latest.revisionNo}，导出 Markdown 才会包含它。历史版本仍然保留。${data?.latestReview ? '' : '\n\n注意：这一版没有模型审查记录，定稿会记为人工定稿（chapter.finalize_manual）。'}`,
      confirmLabel: '确认定稿',
    })
    if (!confirmed) return
    await run('finalize', () => api.finalize(latest.id), '已定稿')
  }

  const rollback = async (revision: ChapterRevision): Promise<void> => {
    const confirmed = await confirmDialog({
      title: '回滚为新草稿？',
      message: `会以 #${revision.revisionNo} 的内容新建一个草稿版本，历史版本不会被删除或覆盖。`,
      confirmLabel: '新建回滚草稿',
    })
    if (!confirmed) return
    await run('rollback', () => api.rollback(revision.id), '已创建回滚草稿')
  }

  const showContext = async (): Promise<void> => {
    setContextOpen(true)
    setBusy('context')
    try {
      const pack = await api.getContext(chapterId)
      setContext({ ...pack })
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
      setContextOpen(false)
    } finally {
      setBusy(null)
    }
  }

  if (detail.loading && !data) return <Loading text="正在读取章节…" />
  if (detail.error) return <ErrorBox error={detail.error} onRetry={refresh} />
  if (!data) return <Empty title="章节不存在" hint="它可能已经被删除，回到章节列表重新选择。" />

  const outline = parseOutline(data.outline?.content)
  const shownContent = viewing ? viewing.content : draft
  const words = countWords(shownContent)

  return (
    <div className="stack">
      <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="row-wrap">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate(`/p/${encodeURIComponent(projectId)}/chapters`)}>← 章节列表</button>
            <span className="mono muted">第 {data.chapter.chapterNo} 章</span>
            <StatusBadge status={data.chapter.status} />
            {latest && <span className="tiny muted">最新版本 #{latest.revisionNo}</span>}
          </div>
          <h1 style={{ fontFamily: 'var(--serif)', marginTop: 6 }}>{data.chapter.title}</h1>
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={showContext} disabled={busy === 'context'}>查看上下文包</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void saveManual()}
            disabled={!dirty || busy === 'save'}
            title={dirty ? '保存为新版本' : '没有改动'}
          >
            {busy === 'save' ? '保存中…' : dirty ? '保存为新版本' : '已保存'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => void finalize()}
            disabled={!latest || busy === 'finalize' || blockers.length > 0 || viewing !== null}
            title={blockers.length ? `还有 ${blockers.length} 个阻断问题` : '定稿需要作者确认'}
          >
            定稿
          </button>
        </div>
      </div>

      {blockers.length > 0 && (
        <div className="error-box">
          还有 {blockers.length} 个 major/critical 审查问题未解决，定稿会被拒绝。请在右侧勾选问题后点「按所选问题修订」。
        </div>
      )}
      {viewing && (
        <div className="notice">
          正在查看历史版本 #{viewing.revisionNo}（{label(viewing.kind)} · {label(viewing.status)} · {formatTime(viewing.createdAt)}）。此视图只读。
          <button type="button" className="btn btn-sm" style={{ marginLeft: 10 }} onClick={() => setViewingId(null)}>回到最新</button>
        </div>
      )}
      {dirty && (
        <div className="hint-box">有未保存的修改。保存会新建版本 #{latest ? latest.revisionNo + 1 : 1}，不会覆盖任何历史。</div>
      )}

      <div className="split">
        <div className="stack">
          <div className="editor-wrap">
            <div className="editor-tools">
              <span className="small muted">{words.toLocaleString()} 字</span>
              <span className="small muted">· {draft.length.toLocaleString()} 字符</span>
              {dirty && <Badge tone="warn" dot>未保存</Badge>}
              <div className="spacer" />
              {viewing ? (
                <span className="tiny muted">只读查看</span>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => { setRewriteOpen(true); setInstruction('') }}
                    disabled={!latest || !aiReady || busy !== null}
                    title={aiReady ? '让模型按要求完整改写' : '需要模型凭据'}
                  >
                    改写
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => { setContinueOpen(true); setInstruction('') }}
                    disabled={!latest || !aiReady || busy !== null}
                    title={aiReady ? '在当前版本基础上续写' : '需要模型凭据'}
                  >
                    续写
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!latest || !aiReady || busy !== null}
                    onClick={() => latest && void run('review', () => api.review(latest.id), '审查完成')}
                  >
                    {busy === 'review' ? '审查中…' : '审查最新版本'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={!aiReady || busy !== null}
                    onClick={() => void run('draft', () => api.writeDraft(chapterId), '草稿已生成')}
                    title={aiReady ? '读取上下文生成整章初稿' : '需要模型凭据'}
                  >
                    {busy === 'draft' ? '生成中…' : 'AI 生成草稿'}
                  </button>
                </>
              )}
            </div>
            <div className="editor-body">
              {viewing ? (
                <div className="prose">{viewing.content}</div>
              ) : (
                <textarea
                  className="textarea prose-input"
                  style={{ border: 'none', background: 'transparent', padding: 0, outline: 'none' }}
                  value={draft}
                  onChange={event => setDraft(event.target.value)}
                  placeholder={latest ? '继续修改正文…' : '这一章还没有正文。可以直接在这里写，或让模型生成初稿。'}
                  spellCheck={false}
                />
              )}
            </div>
          </div>

          <Card title="章级大纲" subtitle="章纲是计划，不是已发生事实" actions={
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate(`/p/${encodeURIComponent(projectId)}/outline`)}>去编辑</button>
          }>
            {outline ? (
              <div className="stack-sm">
                {([['摘要', outline.summary], ['目标', outline.goal], ['冲突', outline.conflict], ['章末钩子', outline.hook]] as const).map(([key, value]) => (
                  <div key={key}>
                    <div className="field-label">{key}</div>
                    <div className="small dim">{value || '（未填写）'}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="small muted">这一章没有关联章级大纲。</div>
            )}
          </Card>
        </div>

        <div className="stack">
          <Card title="审查问题" subtitle={data.latestReview ? `${issues.length} 条，未解决 ${openIssues.length} 条` : '尚未审查'} actions={
            openIssues.length > 0 && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={!aiReady || !latest || selectedIssues.length === 0 || busy !== null}
                onClick={() => latest && void run('revise', () => api.revise(latest.id, selectedIssues), '已修订并自动复检')}
              >
                {busy === 'revise' ? '修订中…' : `按所选修订 (${selectedIssues.length})`}
              </button>
            )
          }>
            {openIssues.length ? (
              <div className="stack-sm">
                {openIssues.map((issue: ReviewIssue) => {
                  const checked = selectedIssues.includes(issue.id)
                  return (
                    <label key={issue.id} className={`issue-card ${issue.severity}`} style={{ display: 'block', cursor: 'pointer' }}>
                      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
                        <span className="row" style={{ gap: 6 }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => setSelectedIssues(previous => (checked ? previous.filter(id => id !== issue.id) : [...previous, issue.id]))}
                          />
                          <Badge tone={severityTone(issue.severity)}>{label(issue.severity)}</Badge>
                          <Badge tone="muted">{label(issue.category)}</Badge>
                        </span>
                        {issue.locationStart !== null && issue.locationEnd !== null && (
                          <span className="issue-loc">{issue.locationStart}–{issue.locationEnd}</span>
                        )}
                      </div>
                      <div className="small" style={{ marginTop: 5 }}>{issue.issue}</div>
                      {issue.suggestedFix && <div className="tiny muted" style={{ marginTop: 4 }}>建议：{issue.suggestedFix}</div>}
                    </label>
                  )
                })}
              </div>
            ) : data.latestReview ? (
              <div className="small muted">最新审查没有未解决的问题。</div>
            ) : (
              <Empty title="还没有审查记录" hint={aiReady ? '点编辑器上方的「审查最新版本」跑六维审查。' : '配置模型凭据后才能跑模型审查。'} />
            )}
          </Card>

          <Card title="版本历史" subtitle={`${data.revisions.length} 个版本，只追加不覆盖`} actions={
            latest && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => navigate(`/p/${encodeURIComponent(projectId)}/compare`)}
              >
                比较
              </button>
            )
          }>
            {data.revisions.length ? (
              <div className="list scroll-y">
                {data.revisions.map(revision => (
                  <div
                    key={revision.id}
                    className={`list-item${viewingId === revision.id ? ' selected' : ''}`}
                    onClick={() => setViewingId(viewingId === revision.id ? null : revision.id)}
                  >
                    <div className="list-item-main">
                      <div className="list-item-title">
                        <span className="mono">#{revision.revisionNo}</span>
                        <Badge tone="muted">{label(revision.kind)}</Badge>
                        <StatusBadge status={revision.status} />
                        {latest?.id === revision.id && <Badge tone="accent">最新</Badge>}
                      </div>
                      <div className="list-item-meta">{revision.contentLength ?? revision.content.length} 字符 · {formatTime(revision.createdAt)}</div>
                    </div>
                    <div className="list-item-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={(event) => { event.stopPropagation(); void rollback(revision) }}
                        disabled={busy !== null}
                        title="以该版本内容新建草稿"
                      >
                        回滚
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="还没有正文版本" hint="写第一段或生成草稿后，这里会出现可追溯的历史。" />
            )}
          </Card>

          <Card title="章节信息">
            <Kv rows={[
              { key: '章节 ID', value: <span className="mono tiny break">{data.chapter.id}</span> },
              { key: '状态', value: <StatusBadge status={data.chapter.status} /> },
              { key: '正式版本', value: data.chapter.currentRevisionId ? <span className="mono tiny break">{data.chapter.currentRevisionId}</span> : '未定稿' },
              { key: '版本号', value: <span className="mono">{data.chapter.version}</span> },
              { key: '更新时间', value: formatTime(data.chapter.updatedAt) },
              { key: '大纲 ID', value: data.outline ? <span className="mono tiny break">{data.outline.id}</span> : '—' },
            ]} />
          </Card>
        </div>
      </div>

      <Modal
        open={rewriteOpen}
        title="完整改写最新版本"
        onClose={() => setRewriteOpen(false)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setRewriteOpen(false)}>取消</button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!instruction.trim() || busy !== null || !latest}
              onClick={() => {
                if (!latest) return
                setRewriteOpen(false)
                void run('rewrite', () => api.rewrite(latest.id, instruction.trim()), '改写完成，已生成新版本')
              }}
            >
              开始改写
            </button>
          </>
        }
      >
        <Field label="改写要求" hint="会生成一个新版本，原版本保留">
          <textarea className="textarea" rows={4} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="例如：去掉解释性旁白，把结尾改成开放式；保持冷硬口吻。" autoFocus />
        </Field>
      </Modal>

      <Modal
        open={continueOpen}
        title="续写"
        onClose={() => setContinueOpen(false)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setContinueOpen(false)}>取消</button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy !== null || !latest}
              onClick={() => {
                if (!latest) return
                setContinueOpen(false)
                void run('continue', () => api.continueWriting(latest.id, instruction.trim()), '续写完成，已生成新版本')
              }}
            >
              开始续写
            </button>
          </>
        }
      >
        <Field label="续写方向（可留空）">
          <textarea className="textarea" rows={3} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="例如：接一段雨夜对峙，别急着揭底。" />
        </Field>
      </Modal>

      <Modal open={contextOpen} title="本章上下文包" wide onClose={() => setContextOpen(false)}>
        {busy === 'context' && <Loading text="正在组装上下文…" />}
        {context && (
          <div className="stack-sm">
            <div className="row-wrap">
              <Badge tone="info">估算 {context.estimatedTokens.toLocaleString()} tokens</Badge>
              <Badge tone="muted">预算 {context.budgetTokens.toLocaleString()}</Badge>
              {context.truncated && <Badge tone="warn">已截断</Badge>}
              <span className="spacer" />
              {context.text && <CopyButton text={context.text} label="复制全文" />}
            </div>
            {context.omittedSections.length > 0 && (
              <div className="hint-box">因预算被省略：{context.omittedSections.join('、')}</div>
            )}
            <div>
              <div className="field-label">来源（{context.sources.length}）</div>
              <div className="row-wrap" style={{ marginTop: 4 }}>
                {context.sources.slice(0, 30).map(source => (
                  <Badge key={source.id} tone="muted">{source.type}:{source.status}</Badge>
                ))}
              </div>
            </div>
            {context.preview && (
              <div>
                <div className="field-label">内容预览</div>
                <pre className="mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto', background: 'var(--bg-soft)', padding: 10, borderRadius: 8 }}>
                  {truncate(context.preview, 4000)}
                </pre>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
