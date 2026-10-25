import { useMemo, useState } from 'react'
import type { PageProps } from '../app/types.ts'
import { api, ApiError } from '../lib/api.ts'
import { toast, useResource } from '../lib/hooks.ts'
import { relativeTime, truncate } from '../lib/format.ts'
import { Card, Empty, ErrorBox, Loading, SectionTitle, StatusBadge } from '../components/ui.tsx'
import type { Chapter, Outline } from '../lib/types.ts'

// 章级大纲的 content 是 JSON 字符串：{"summary","goal","conflict","hook"}。
interface ChapterFields {
  summary: string
  goal: string
  conflict: string
  hook: string
}

interface VolumeDraft {
  kind: 'volume'
  id: string
  title: string
  content: string
  version: number
}

interface ChapterDraft {
  kind: 'chapter'
  id: string
  version: number
  /** content 能解析成上述结构时为 true，否则退化为纯文本编辑 */
  structured: boolean
  fields: ChapterFields
  raw: string
}

type OutlineDraft = VolumeDraft | ChapterDraft

function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'CONFLICT' || error.message.includes('版本已变化'))
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return JSON.stringify(value) ?? String(value)
}

function parseChapterContent(content: string): ChapterFields | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  return {
    summary: toText(record['summary']),
    goal: toText(record['goal']),
    conflict: toText(record['conflict']),
    hook: toText(record['hook']),
  }
}

function compareChapterOutlines(left: Outline, right: Outline): number {
  const leftNo = left.chapterNo ?? Number.MAX_SAFE_INTEGER
  const rightNo = right.chapterNo ?? Number.MAX_SAFE_INTEGER
  if (leftNo !== rightNo) return leftNo - rightNo
  return left.createdAt.localeCompare(right.createdAt)
}

function TextField({ fieldLabel, value, onChange, multiline = false }: {
  fieldLabel: string
  value: string
  onChange: (next: string) => void
  multiline?: boolean
}) {
  return (
    <label className="field">
      <span className="field-label">{fieldLabel}</span>
      {multiline ? (
        <textarea className="textarea" rows={3} value={value} onChange={event => onChange(event.target.value)} />
      ) : (
        <input className="input" value={value} onChange={event => onChange(event.target.value)} />
      )}
    </label>
  )
}

function VolumeEditor({ draft, saving, onChange, onSave, onCancel }: {
  draft: VolumeDraft
  saving: boolean
  onChange: (next: VolumeDraft) => void
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <div className="stack-sm">
      <TextField fieldLabel="卷标题" value={draft.title} onChange={title => onChange({ ...draft, title })} />
      <TextField
        fieldLabel="卷摘要（纯文本）"
        multiline
        value={draft.content}
        onChange={content => onChange({ ...draft, content })}
      />
      <div className="btn-row">
        <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={onSave}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>取消</button>
      </div>
    </div>
  )
}

function ChapterEditor({ draft, saving, onChange, onSave, onCancel }: {
  draft: ChapterDraft
  saving: boolean
  onChange: (next: ChapterDraft) => void
  onSave: () => void
  onCancel: () => void
}) {
  const footer = (
    <div className="btn-row">
      <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={onSave}>
        {saving ? '保存中…' : '保存'}
      </button>
      <button type="button" className="btn btn-sm" onClick={onCancel}>取消</button>
    </div>
  )

  if (!draft.structured) {
    return (
      <div className="stack-sm" style={{ marginTop: 8 }}>
        <div className="hint-box">
          当前内容不是可解析的 JSON（summary / goal / conflict / hook），已退化为纯文本编辑；保存时会原样写回纯文本。
        </div>
        <TextField fieldLabel="内容（纯文本）" multiline value={draft.raw} onChange={raw => onChange({ ...draft, raw })} />
        {footer}
      </div>
    )
  }

  return (
    <div className="stack-sm" style={{ marginTop: 8 }}>
      <TextField
        fieldLabel="章节摘要 summary"
        multiline
        value={draft.fields.summary}
        onChange={summary => onChange({ ...draft, fields: { ...draft.fields, summary } })}
      />
      <TextField
        fieldLabel="本章目标 goal"
        value={draft.fields.goal}
        onChange={goal => onChange({ ...draft, fields: { ...draft.fields, goal } })}
      />
      <TextField
        fieldLabel="核心冲突 conflict"
        value={draft.fields.conflict}
        onChange={conflict => onChange({ ...draft, fields: { ...draft.fields, conflict } })}
      />
      <TextField
        fieldLabel="结尾钩子 hook"
        value={draft.fields.hook}
        onChange={hook => onChange({ ...draft, fields: { ...draft.fields, hook } })}
      />
      {footer}
    </div>
  )
}

export function OutlinePage({ projectId, navigate }: PageProps) {
  const outlines = useResource(() => api.listOutlines(projectId), [projectId])
  const chapters = useResource(() => api.listChapters(projectId), [projectId])
  const health = useResource(() => api.health(), [])

  const [draft, setDraft] = useState<OutlineDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [planCount, setPlanCount] = useState('10')
  const [planning, setPlanning] = useState(false)

  const aiReady = health.data?.hasApiKey === true

  const volumes = useMemo(() => {
    const list = outlines.data ?? []
    return list.filter(outline => outline.level === 'volume').sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }, [outlines.data])

  const chapterByNo = useMemo(() => {
    const map = new Map<number, Chapter>()
    for (const chapter of chapters.data ?? []) map.set(chapter.chapterNo, chapter)
    return map
  }, [chapters.data])

  const chapterOutlinesByParent = useMemo(() => {
    const map = new Map<string, Outline[]>()
    for (const outline of outlines.data ?? []) {
      if (outline.level === 'volume') continue
      const parentId = outline.parentId
      if (!parentId) continue
      const bucket = map.get(parentId)
      if (bucket) bucket.push(outline)
      else map.set(parentId, [outline])
    }
    for (const bucket of map.values()) bucket.sort(compareChapterOutlines)
    return map
  }, [outlines.data])

  const orphanChapterOutlines = useMemo(() => {
    const volumeIds = new Set(volumes.map(volume => volume.id))
    return (outlines.data ?? [])
      .filter(outline => outline.level !== 'volume' && (outline.parentId === null || !volumeIds.has(outline.parentId)))
      .sort(compareChapterOutlines)
  }, [outlines.data, volumes])

  const chapterOutlineCount = (outlines.data ?? []).filter(outline => outline.level !== 'volume').length

  async function save(current: OutlineDraft): Promise<void> {
    setSaving(true)
    try {
      if (current.kind === 'volume') {
        const title = current.title.trim()
        if (!title) {
          toast.error('卷标题不能为空。')
          return
        }
        await api.updateOutline(current.id, {
          title,
          content: current.content,
          expectedVersion: current.version,
        })
      } else {
        const content = current.structured ? JSON.stringify(current.fields) : current.raw
        await api.updateOutline(current.id, { content, expectedVersion: current.version })
      }
      toast.ok('已保存')
      setDraft(null)
      outlines.reload()
    } catch (error) {
      if (isVersionConflict(error)) {
        toast.error('资料已被其它窗口修改，已刷新')
        setDraft(null)
        outlines.reload()
      } else {
        toast.error(error instanceof Error ? error.message : String(error))
      }
    } finally {
      setSaving(false)
    }
  }

  async function runPlan(): Promise<void> {
    if (!aiReady) {
      toast.error('未配置 DEEPSEEK_API_KEY，AI 规划不可用。')
      return
    }
    const count = Number(planCount)
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      toast.error('章节数必须是 1 到 100 的整数。')
      return
    }
    setPlanning(true)
    try {
      await api.planOutline(projectId, count)
      toast.ok('AI 规划完成，大纲已更新')
      outlines.reload()
      chapters.reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPlanning(false)
    }
  }

  function openChapterDraft(outline: Outline): void {
    const fields = parseChapterContent(outline.content)
    setDraft({
      kind: 'chapter',
      id: outline.id,
      version: outline.version,
      structured: fields !== null,
      fields: fields ?? { summary: '', goal: '', conflict: '', hook: '' },
      raw: outline.content,
    })
  }

  function renderChapterRow(outline: Outline) {
    const chapter = outline.chapterNo === null ? undefined : chapterByNo.get(outline.chapterNo)
    const fields = parseChapterContent(outline.content)
    const isEditing = draft !== null && draft.kind === 'chapter' && draft.id === outline.id
    const clickable = !isEditing && chapter !== undefined

    return (
      <div className="list-item" key={outline.id} style={{ cursor: clickable ? 'pointer' : 'default' }}>
        <div
          className="list-item-main"
          onClick={clickable && chapter ? () => navigate(`/p/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapter.id)}`) : undefined}
        >
          <div className="list-item-title">
            <span className="chapter-no">{outline.chapterNo === null ? '—' : String(outline.chapterNo)}</span>
            <span>{outline.title}</span>
            <StatusBadge status={outline.status} />
            {!chapter && <span className="badge badge-muted">无对应章节</span>}
          </div>

          {isEditing ? null : (
            <>
              <div className="list-item-meta" style={{ marginTop: 3 }}>
                {fields
                  ? truncate(fields.summary || '（摘要为空）', 170)
                  : <span className="mono">{truncate(outline.content, 170) || '（内容为空）'}</span>}
              </div>
              {fields ? (
                <div className="list-item-meta">
                  目标：{truncate(fields.goal || '—', 46)} · 冲突：{truncate(fields.conflict || '—', 46)} · 钩子：{truncate(fields.hook || '—', 46)}
                </div>
              ) : (
                <div className="list-item-meta">非结构化内容：按纯文本编辑</div>
              )}
              <div className="list-item-meta">
                {chapter ? `章节 ${chapter.id.slice(0, 8)} · ${relativeTime(chapter.updatedAt)}` : '未生成对应章节，无法跳转'}
                {' · 大纲更新于 '}{relativeTime(outline.updatedAt)}
              </div>
            </>
          )}

          {isEditing && draft !== null && draft.kind === 'chapter' ? (
            <ChapterEditor
              draft={draft}
              saving={saving}
              onChange={setDraft}
              onSave={() => { void save(draft) }}
              onCancel={() => setDraft(null)}
            />
          ) : null}
        </div>

        <div className="list-item-actions">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              if (isEditing) setDraft(null)
              else openChapterDraft(outline)
            }}
          >
            {isEditing ? '取消' : '编辑'}
          </button>
        </div>
      </div>
    )
  }

  if (outlines.loading && !outlines.data) return <Loading text="正在载入大纲…" />
  if (outlines.error) return <ErrorBox error={outlines.error} onRetry={outlines.reload} />

  const healthHint = health.loading
    ? '正在检测 AI 配置…'
    : health.error
      ? `无法读取服务健康信息：${health.error.message}`
      : aiReady
        ? '已检测到 DEEPSEEK_API_KEY，可使用 AI 规划。'
        : '需要 DEEPSEEK_API_KEY：在启动 novelforge 的环境里配置该变量并重启服务后启用。'

  return (
    <div className="stack">
      <Card
        tight
        title="AI 规划后续章节"
        subtitle="按项目设定与已有大纲向后追加章节，并同步创建章节记录"
        actions={<span className={`badge ${aiReady ? 'badge-ok' : 'badge-muted'}`}>{aiReady ? 'AI 可用' : 'AI 未配置'}</span>}
      >
        <div className="row-wrap">
          <label className="field" style={{ width: 132 }}>
            <span className="field-label">规划章节数</span>
            <input
              className="input"
              type="number"
              min={1}
              max={100}
              value={planCount}
              onChange={event => setPlanCount(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!aiReady || planning}
            onClick={() => { void runPlan() }}
          >
            {planning ? 'AI 规划中…' : 'AI 规划后续章节'}
          </button>
          <span className="field-hint" style={{ maxWidth: 460 }}>{healthHint}</span>
        </div>
        {planning && <div className="hint-box" style={{ marginTop: 10 }}>规划需要调用模型，通常需要几十秒；完成后大纲与章节列表会自动刷新。</div>}
      </Card>

      <SectionTitle title="大纲" hint={`${volumes.length} 卷 · ${chapterOutlineCount} 章`} />

      {(outlines.data ?? []).length === 0 ? (
        <Empty
          title="还没有大纲"
          hint="AI 规划会按「卷 → 章」生成两级大纲并同步创建章节记录；章级大纲的 summary / goal / conflict / hook 会进入写作上下文。"
          action={(
            <button type="button" className="btn btn-primary btn-sm" disabled={!aiReady || planning} onClick={() => { void runPlan() }}>
              AI 规划大纲
            </button>
          )}
        />
      ) : (
        <div className="stack">
          {volumes.map(volume => {
            const volumeChapters = chapterOutlinesByParent.get(volume.id) ?? []
            const isEditing = draft !== null && draft.kind === 'volume' && draft.id === volume.id
            return (
              <Card
                key={volume.id}
                title={volume.title}
                subtitle={`${volumeChapters.length} 章 · 更新于 ${relativeTime(volume.updatedAt)}`}
                actions={(
                  <>
                    <StatusBadge status={volume.status} />
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        if (isEditing) setDraft(null)
                        else setDraft({
                          kind: 'volume',
                          id: volume.id,
                          title: volume.title,
                          content: volume.content,
                          version: volume.version,
                        })
                      }}
                    >
                      {isEditing ? '取消' : '编辑卷'}
                    </button>
                  </>
                )}
              >
                {isEditing && draft !== null && draft.kind === 'volume' ? (
                  <VolumeEditor
                    draft={draft}
                    saving={saving}
                    onChange={setDraft}
                    onSave={() => { void save(draft) }}
                    onCancel={() => setDraft(null)}
                  />
                ) : (
                  <div className="dim" style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.8 }}>
                    {volume.content.trim() || '（暂无卷摘要）'}
                  </div>
                )}

                <div className="divider" />
                {volumeChapters.length === 0 ? (
                  <div className="tiny muted">这一卷还没有章节大纲。</div>
                ) : (
                  <div className="list">{volumeChapters.map(outline => renderChapterRow(outline))}</div>
                )}
              </Card>
            )
          })}

          {orphanChapterOutlines.length > 0 && (
            <Card title="未归卷的章节大纲" subtitle="这些章级大纲没有可用的卷父节点">
              <div className="list">{orphanChapterOutlines.map(outline => renderChapterRow(outline))}</div>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}
