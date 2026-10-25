import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.ts'
import { confirmDialog, toast, useResource } from '../lib/hooks.ts'
import type { PageProps } from '../app/types.ts'
import type { ChapterRevision, CompareResult } from '../lib/types.ts'
import { Card, Empty, ErrorBox, Field, Loading, SectionTitle, StatusBadge } from '../components/ui.tsx'
import { formatTime, label, toDiffLines, truncate } from '../lib/format.ts'

function toMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 列表接口返回的版本不含正文，只用 contentLength 展示字符数。 */
function revisionLabel(revision: ChapterRevision): string {
  const words = revision.contentLength === undefined ? '…' : `${revision.contentLength} 字`
  return `#${revision.revisionNo} · ${label(revision.kind)} · ${label(revision.status)} · ${words}`
}

export function ComparePage({ projectId, navigate }: PageProps) {
  const chapters = useResource(() => api.listChapters(projectId), [projectId])
  const [chapterId, setChapterId] = useState<string | null>(null)
  const [leftId, setLeftId] = useState<string | null>(null)
  const [rightId, setRightId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const revisions = useResource<ChapterRevision[]>(
    () => (chapterId ? api.listRevisions(chapterId, false) : Promise.resolve([])),
    [chapterId],
  )

  useEffect(() => {
    setChapterId(null)
    setLeftId(null)
    setRightId(null)
  }, [projectId])

  useEffect(() => {
    const list = chapters.data
    if (!list || list.length === 0) return
    setChapterId(previous => {
      if (previous && list.some(chapter => chapter.id === previous)) return previous
      return list.find(chapter => chapter.currentRevisionId !== null)?.id ?? list[0]?.id ?? null
    })
  }, [chapters.data])

  useEffect(() => {
    const list = revisions.data
    if (!list) return
    setLeftId(previous => (previous && list.some(item => item.id === previous) ? previous : list[1]?.id ?? list[0]?.id ?? null))
    setRightId(previous => (previous && list.some(item => item.id === previous) ? previous : list[0]?.id ?? null))
  }, [revisions.data])

  const comparison = useResource<CompareResult | null>(() => {
    if (!leftId || !rightId || leftId === rightId) return Promise.resolve(null)
    return api.compare(leftId, rightId)
  }, [leftId, rightId])

  const lines = useMemo(
    () => (comparison.data ? toDiffLines(comparison.data.changes) : []),
    [comparison.data],
  )
  const stats = useMemo(() => lines.reduce(
    (acc, line) => ({
      added: acc.added + (line.kind === 'added' ? 1 : 0),
      removed: acc.removed + (line.kind === 'removed' ? 1 : 0),
      context: acc.context + (line.kind === 'context' ? 1 : 0),
    }),
    { added: 0, removed: 0, context: 0 },
  ), [lines])
  const diffText = useMemo(
    () => lines.map(line => `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}${line.text}`).join('\n'),
    [lines],
  )

  const chapterList = chapters.data ?? []
  const revisionList = revisions.data ?? []
  const leftRevision = revisionList.find(revision => revision.id === leftId) ?? null
  const rightRevision = revisionList.find(revision => revision.id === rightId) ?? null

  function chooseChapter(nextId: string): void {
    setChapterId(nextId === '' ? null : nextId)
    setLeftId(null)
    setRightId(null)
  }

  async function copyDiff(): Promise<void> {
    try {
      await navigator.clipboard.writeText(diffText)
      toast.ok('差异文本已复制到剪贴板。')
    } catch {
      toast.error('浏览器拒绝了剪贴板访问。')
    }
  }

  async function rollbackLeft(): Promise<void> {
    if (!leftId) {
      toast.error('请先选择左侧要回滚的版本。')
      return
    }
    const confirmed = await confirmDialog({
      title: '回滚为新草稿？',
      message: '会新建一个草稿版本，历史不删除。\n\n新草稿的正文取自左侧选中的版本；章节的正式版本指针不会改变，仍需要你之后定稿。',
      confirmLabel: '回滚为新草稿',
    })
    if (!confirmed) return
    setBusy(true)
    try {
      const created = await api.rollback(leftId)
      toast.ok(`已新建草稿 #${created.revisionNo}，正文来自 #${leftRevision?.revisionNo ?? '?'}。`)
      revisions.reload()
      chapters.reload()
    } catch (cause) {
      toast.error(toMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <SectionTitle
        title="版本比较"
        hint="逐行对照两个正文版本；回滚只追加新草稿，永不覆盖历史。"
        actions={(
          <button
            type="button"
            className="btn btn-sm"
            disabled={chapters.loading || revisions.loading}
            onClick={() => { chapters.reload(); revisions.reload() }}
          >
            刷新
          </button>
        )}
      />

      {chapters.error && <ErrorBox error={chapters.error} onRetry={chapters.reload} />}

      {chapters.loading && !chapters.data ? (
        <Card><Loading text="正在载入章节…" /></Card>
      ) : chapterList.length === 0 ? (
        <Empty
          title="还没有可比较的章节"
          hint="先到大纲页规划章节，再到章节工作台生成草稿，之后就能在这里比较版本。"
          action={<button type="button" className="btn btn-primary" onClick={() => navigate(`/p/${encodeURIComponent(projectId)}/outlines`)}>去规划大纲</button>}
        />
      ) : (
        <>
          <Card title="选择对照版本" subtitle="左侧当作旧版本，右侧当作新版本；新增显示为绿色，删除显示为红色。">
            <div className="grid-2">
              <Field label="章节">
                <select className="select" value={chapterId ?? ''} onChange={event => chooseChapter(event.target.value)}>
                  <option value="">选择章节…</option>
                  {chapterList.map(chapter => (
                    <option key={chapter.id} value={chapter.id}>
                      {truncate(`第 ${chapter.chapterNo} 章 · ${chapter.title}`, 46)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="左侧（旧）">
                <select
                  className="select"
                  value={leftId ?? ''}
                  onChange={event => setLeftId(event.target.value === '' ? null : event.target.value)}
                  disabled={revisionList.length === 0}
                >
                  <option value="">选择版本…</option>
                  {revisionList.map(revision => (
                    <option key={revision.id} value={revision.id}>{truncate(revisionLabel(revision), 52)}</option>
                  ))}
                </select>
              </Field>
              <Field label="右侧（新）">
                <select
                  className="select"
                  value={rightId ?? ''}
                  onChange={event => setRightId(event.target.value === '' ? null : event.target.value)}
                  disabled={revisionList.length === 0}
                >
                  <option value="">选择版本…</option>
                  {revisionList.map(revision => (
                    <option key={revision.id} value={revision.id}>{truncate(revisionLabel(revision), 52)}</option>
                  ))}
                </select>
              </Field>
            </div>

            {revisions.error && <div style={{ marginTop: 12 }}><ErrorBox error={revisions.error} onRetry={revisions.reload} /></div>}
            {revisions.loading && <div style={{ marginTop: 12 }}><Loading text="正在载入版本列表…" /></div>}

            <div className="btn-row" style={{ marginTop: 14 }}>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!leftId || !rightId || leftId === rightId}
                onClick={() => { setLeftId(rightId); setRightId(leftId) }}
              >
                交换左右
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy || !leftId}
                onClick={() => { void rollbackLeft() }}
              >
                回滚为新草稿
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={lines.length === 0}
                onClick={() => { void copyDiff() }}
              >
                复制差异文本
              </button>
            </div>

            {(leftRevision || rightRevision) && (
              <div className="grid-2" style={{ marginTop: 14 }}>
                <div className="hint-box">
                  <div className="small muted">左侧（旧）</div>
                  {leftRevision ? (
                    <>
                      <div className="mono small">#{leftRevision.revisionNo} · {label(leftRevision.kind)}</div>
                      <div className="btn-row" style={{ gap: 8 }}>
                        <StatusBadge status={leftRevision.status} />
                        <span className="tiny muted">{formatTime(leftRevision.createdAt)}</span>
                      </div>
                      {leftRevision.summary && <div className="small dim" style={{ marginTop: 4 }}>{truncate(leftRevision.summary, 180)}</div>}
                    </>
                  ) : <div className="small muted">未选择</div>}
                </div>
                <div className="hint-box">
                  <div className="small muted">右侧（新）</div>
                  {rightRevision ? (
                    <>
                      <div className="mono small">#{rightRevision.revisionNo} · {label(rightRevision.kind)}</div>
                      <div className="btn-row" style={{ gap: 8 }}>
                        <StatusBadge status={rightRevision.status} />
                        <span className="tiny muted">{formatTime(rightRevision.createdAt)}</span>
                      </div>
                      {rightRevision.summary && <div className="small dim" style={{ marginTop: 4 }}>{truncate(rightRevision.summary, 180)}</div>}
                    </>
                  ) : <div className="small muted">未选择</div>}
                </div>
              </div>
            )}
          </Card>

          {revisionList.length === 0 ? (
            <Empty
              title="这个章节还没有正文版本"
              hint="到章节工作台生成草稿后，这里就能比较不同版本之间的逐行差异。"
              action={<button type="button" className="btn btn-primary" onClick={() => navigate(`/p/${encodeURIComponent(projectId)}/chapters`)}>去章节工作台</button>}
            />
          ) : revisionList.length < 2 ? (
            <Empty title="至少需要两个版本才能比较" hint="再生成一次草稿、续写或修订，就会多出一个可比对的版本。" />
          ) : !leftId || !rightId ? (
            <Card><Loading text="正在选择默认版本…" /></Card>
          ) : leftId === rightId ? (
            <div className="notice">左右选择了同一个版本，换一个版本再比较。</div>
          ) : comparison.loading ? (
            <Card><Loading text="正在计算逐行差异…" /></Card>
          ) : comparison.error ? (
            <ErrorBox error={comparison.error} onRetry={comparison.reload} />
          ) : comparison.data && lines.length > 0 ? (
            <Card
              title="逐行差异"
              subtitle={`新增 ${stats.added} 行 · 删除 ${stats.removed} 行 · 相同 ${stats.context} 行`}
            >
              <div className="diff">
                {lines.map((line, index) => (
                  <div key={index} className={`diff-line ${line.kind}`}>
                    <span className="no">{line.leftNo ?? ''}</span>
                    <span className="no">{line.rightNo ?? ''}</span>
                    <span className="txt">{line.text === '' ? '\u00a0' : line.text}</span>
                  </div>
                ))}
              </div>
            </Card>
          ) : comparison.data ? (
            <Empty title="两个版本正文完全一致" hint="没有逐行差异；可能是复制或人工保存产生的相同内容。" />
          ) : null}
        </>
      )}
    </div>
  )
}
