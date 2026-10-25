import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '../lib/api.ts'
import type { ChapterSummary, Outline } from '../lib/types.ts'
import type { PageProps } from '../app/types.ts'
import { toast, useResource } from '../lib/hooks.ts'
import { label, relativeTime, truncate } from '../lib/format.ts'
import { Badge, Card, Empty, ErrorBox, Field, Loading, Modal, Stat, StatusBadge, Tabs } from '../components/ui.tsx'

type Filter = 'all' | 'todo' | 'draft' | 'review' | 'done'

const FILTERS: Array<{ key: Filter; label: string; match: (status: string) => boolean }> = [
  { key: 'all', label: '全部', match: () => true },
  { key: 'todo', label: '待写', match: status => status === 'planned' || status === 'context_ready' },
  { key: 'draft', label: '草稿中', match: status => ['draft_generated', 'manual_draft', 'revising', 'reviewing'].includes(status) },
  { key: 'review', label: '待定稿', match: status => ['awaiting_approval', 'needs_author_decision'].includes(status) },
  { key: 'done', label: '已定稿', match: status => status === 'finalized' },
]

const UNGROUPED_KEY = '__ungrouped__'

interface ChapterGroup {
  key: string
  title: string
  hint: string
  rows: ChapterSummary[]
  volume: Outline | null
  words: number
}

function chapterRange(rows: ChapterSummary[]): string {
  if (rows.length === 0) return ''
  const numbers = rows.map(row => row.chapter.chapterNo)
  const min = Math.min(...numbers)
  const max = Math.max(...numbers)
  return min === max ? `第 ${min} 章` : `第 ${min}–${max} 章`
}

/**
 * 章卷分组：chapter.outlineId → 章级大纲 → parentId → 卷大纲。
 * 找不到卷归属的章节统一进「未归卷」。
 */
function groupByVolume(rows: ChapterSummary[], outlines: Outline[]): ChapterGroup[] {
  const outlineById = new Map<string, Outline>()
  for (const outline of outlines) outlineById.set(outline.id, outline)

  const buckets = new Map<string, ChapterGroup>()
  const ungrouped: ChapterSummary[] = []

  for (const row of rows) {
    const chapterOutline = row.chapter.outlineId ? outlineById.get(row.chapter.outlineId) : undefined
    const parent = chapterOutline?.parentId ? outlineById.get(chapterOutline.parentId) : undefined
    const volume = parent !== undefined && parent.level === 'volume' ? parent : undefined
    if (!volume) {
      ungrouped.push(row)
      continue
    }
    const existing = buckets.get(volume.id)
    if (existing) {
      existing.rows.push(row)
      existing.words += row.latest?.words ?? 0
    } else {
      buckets.set(volume.id, {
        key: volume.id,
        title: volume.title || '未命名卷',
        hint: truncate(volume.content.replace(/\s+/g, ' ').trim(), 80),
        rows: [row],
        volume,
        words: row.latest?.words ?? 0,
      })
    }
  }

  const groups = [...buckets.values()].sort(
    (left, right) => (left.rows[0]?.chapter.chapterNo ?? 0) - (right.rows[0]?.chapter.chapterNo ?? 0),
  )
  for (const group of groups) {
    group.rows.sort((left, right) => left.chapter.chapterNo - right.chapter.chapterNo)
  }

  if (ungrouped.length > 0) {
    ungrouped.sort((left, right) => left.chapter.chapterNo - right.chapter.chapterNo)
    groups.push({
      key: UNGROUPED_KEY,
      title: '未归卷',
      hint: '这些章节没有挂到任何卷上：手动新建的章节、或章级大纲还没指到卷。',
      rows: ungrouped,
      volume: null,
      words: ungrouped.reduce((sum, row) => sum + (row.latest?.words ?? 0), 0),
    })
  }

  return groups
}

export function ChaptersPage({ projectId, navigate }: PageProps) {
  const [filter, setFilter] = useState<Filter>('all')
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [planning, setPlanning] = useState(false)
  const [planCount, setPlanCount] = useState(5)
  const [planBusy, setPlanBusy] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set<string>())

  const summaries = useResource(() => api.listChapterSummaries(projectId), [projectId])
  const outlines = useResource(() => api.listOutlines(projectId), [projectId])

  const rows = summaries.data ?? []
  const outlineList = outlines.data ?? []
  const activeFilter = FILTERS.find(item => item.key === filter) ?? FILTERS[0]
  const visible = rows.filter(row => activeFilter ? activeFilter.match(row.chapter.status) : true)
  const totalWords = rows.reduce((sum, row) => sum + (row.latest?.words ?? 0), 0)
  const finalizedWords = rows.filter(row => row.chapter.status === 'finalized').reduce((sum, row) => sum + (row.latest?.words ?? 0), 0)
  const counts = useMemo(() => {
    const map = new Map<Filter, number>()
    for (const item of FILTERS) map.set(item.key, rows.filter(row => item.match(row.chapter.status)).length)
    return map
  }, [rows])

  const groups = useMemo(
    () => groupByVolume(visible, outlineList),
    [visible, outlineList],
  )
  // 用完整章节集合算卷数，避免筛选时统计跳变。
  const allGroups = useMemo(() => groupByVolume(rows, outlineList), [rows, outlineList])

  const collapsedCount = groups.filter(group => collapsed.has(group.key)).length
  const allCollapsed = groups.length > 0 && collapsedCount >= groups.length

  function toggleGroup(key: string): void {
    setCollapsed(previous => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleAll(): void {
    setCollapsed(allCollapsed ? new Set<string>() : new Set(groups.map(group => group.key)))
  }

  const openChapter = (chapterId: string): void => {
    navigate(`/p/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}`)
  }

  const createChapter = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!title.trim()) {
      toast.error('章节标题不能为空。')
      return
    }
    setBusy(true)
    try {
      const created = await api.createChapter(projectId, { title: title.trim() })
      toast.ok(`已创建第 ${created.chapter.chapterNo} 章`)
      setCreating(false)
      setTitle('')
      summaries.reload()
      outlines.reload()
      openChapter(created.chapter.id)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const plan = async (): Promise<void> => {
    const count = Math.floor(planCount)
    if (!Number.isFinite(count) || count < 1) {
      toast.error('规划章数至少为 1。')
      return
    }
    setPlanBusy(true)
    try {
      await api.planOutline(projectId, count)
      toast.ok(`已规划 ${count} 章`)
      setPlanning(false)
      summaries.reload()
      outlines.reload()
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPlanBusy(false)
    }
  }

  if (summaries.loading && !summaries.data) return <Loading text="正在读取章节…" />
  if (summaries.error) return <ErrorBox error={summaries.error} onRetry={summaries.reload} />

  return (
    <div className="stack">
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--serif)' }}>章节</h1>
          <div className="muted small">按卷分组；章节来自大纲规划，也可以手动新增；正文只追加新版本，不覆盖历史。</div>
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => { summaries.reload(); outlines.reload() }}>刷新</button>
          <button type="button" className="btn" onClick={() => setPlanning(true)}>AI 规划后续章节</button>
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>新建章节</button>
        </div>
      </div>

      {outlines.error && (
        <ErrorBox
          error={outlines.error}
          onRetry={outlines.reload}
        />
      )}

      <div className="stat-grid">
        <Stat label="章节数" value={rows.length} hint={`已定稿 ${counts.get('done') ?? 0}`} />
        <Stat label="正文总字数" value={totalWords.toLocaleString()} />
        <Stat label="已定稿字数" value={finalizedWords.toLocaleString()} tone="ok" />
        <Stat label="待写" value={counts.get('todo') ?? 0} tone={(counts.get('todo') ?? 0) > 0 ? 'warn' : undefined} />
        <Stat label="分卷" value={allGroups.filter(group => group.volume !== null).length} hint={allGroups.some(group => group.key === UNGROUPED_KEY) ? '另有未归卷章节' : '全部章节都有卷归属'} />
      </div>

      <Tabs
        value={filter}
        onChange={setFilter}
        items={FILTERS.map(item => ({ key: item.key, label: item.label, count: counts.get(item.key) ?? 0 }))}
      />

      {visible.length > 0 && (
        <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
          <span className="tiny muted">共 {visible.length} 章 · {groups.length} 个分组</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={toggleAll}>
            {allCollapsed ? '全部展开' : '全部收起'}
          </button>
        </div>
      )}

      {rows.length === 0 ? (
        <Empty
          title="还没有章节"
          hint="去大纲页用 AI 规划一批章节，或点右上角手动新建第一章。"
          action={<button type="button" className="btn" onClick={() => setPlanning(true)}>AI 规划后续章节</button>}
        />
      ) : visible.length === 0 ? (
        <Empty
          title="该筛选下没有章节"
          hint="换一个筛选条件试试。"
          action={<button type="button" className="btn btn-sm" onClick={() => setFilter('all')}>查看全部</button>}
        />
      ) : (
        <div className="stack-sm">
          {groups.map(group => {
            const isCollapsed = collapsed.has(group.key)
            const percent = totalWords > 0 ? Math.round((group.words / totalWords) * 100) : 0
            return (
              <Card key={group.key} tight>
                <button
                  type="button"
                  className="row-btn"
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '3px 2px', marginBottom: isCollapsed ? 0 : 10 }}
                  onClick={() => toggleGroup(group.key)}
                  aria-expanded={!isCollapsed}
                >
                  <span className="muted" style={{ width: 12, flex: 'none' }}>{isCollapsed ? '▸' : '▾'}</span>
                  <span className="card-title" style={{ fontFamily: 'var(--serif)' }}>{group.title}</span>
                  {group.volume && <Badge tone="muted">{label(group.volume.status)}</Badge>}
                  <span className="tiny muted nowrap">
                    {group.rows.length} 章 · {chapterRange(group.rows)} · {group.words.toLocaleString()} 字 · {percent}%
                  </span>
                  {group.hint.length > 0 && (
                    <span className="tiny muted truncate" style={{ maxWidth: 420 }}>{group.hint}</span>
                  )}
                  <span className="spacer" />
                  <span className="tiny muted nowrap">{isCollapsed ? '已收起' : '收起'}</span>
                </button>

                {!isCollapsed && (
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: 64 }}>章号</th>
                        <th>标题</th>
                        <th style={{ width: 112 }}>状态</th>
                        <th style={{ width: 130 }}>最新版本</th>
                        <th style={{ width: 84 }} className="num">字数</th>
                        <th style={{ width: 64 }} className="num">版本</th>
                        <th style={{ width: 110 }}>更新时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((row: ChapterSummary) => (
                        <tr key={row.chapter.id} style={{ cursor: 'pointer' }} onClick={() => openChapter(row.chapter.id)}>
                          <td className="mono muted">{row.chapter.chapterNo}</td>
                          <td>
                            <div style={{ fontFamily: 'var(--serif)', fontSize: 14 }}>{row.chapter.title}</div>
                            <div className="tiny muted">
                              {row.latest ? `最新正文 ${label(row.latest.kind)} · ${relativeTime(row.latest.createdAt)}` : '尚无正文'}
                            </div>
                          </td>
                          <td><StatusBadge status={row.chapter.status} /></td>
                          <td>
                            {row.latest
                              ? <span className="mono small">#{row.latest.revisionNo} <Badge tone="muted">{label(row.latest.status)}</Badge></span>
                              : <span className="muted small">—</span>}
                          </td>
                          <td className="num mono">{row.latest ? row.latest.words.toLocaleString() : '—'}</td>
                          <td className="num mono muted">{row.revisionCount}</td>
                          <td className="tiny muted">{relativeTime(row.chapter.updatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            )
          })}
        </div>
      )}

      <Modal
        open={creating}
        title="新建章节"
        onClose={() => setCreating(false)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setCreating(false)} disabled={busy}>取消</button>
            <button type="button" className="btn btn-primary" onClick={(event) => { void createChapter(event as unknown as FormEvent) }} disabled={busy}>
              {busy ? '创建中…' : '创建并打开'}
            </button>
          </>
        }
      >
        <form className="stack-sm" onSubmit={createChapter}>
          <Field label="章节标题" hint="章号自动接在最后一章后面">
            <input className="input" value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：雨夜访客" autoFocus />
          </Field>
          <div className="field-hint">会同时生成一条章级大纲（默认不挂卷，可在「大纲」页调整归属），之后可在「大纲」页补充章节目标、冲突和钩子。</div>
        </form>
      </Modal>

      <Modal
        open={planning}
        title="AI 规划后续章节"
        onClose={() => { if (!planBusy) setPlanning(false) }}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setPlanning(false)} disabled={planBusy}>取消</button>
            <button type="button" className="btn btn-primary" onClick={() => { void plan() }} disabled={planBusy}>
              {planBusy ? 'AI 规划中…' : '开始规划'}
            </button>
          </>
        }
      >
        <div className="stack-sm">
          <div className="hint-box">
            会根据作品设定、已完成章节和未回收伏笔规划后续章节：一次生成「卷 + 章」两级大纲，并同步创建章节记录。
            章节会按卷自动分组；已有章节不会被动。
          </div>
          <Field label="规划章节数" hint="一次不要太多，分批规划更好控制节奏">
            <input
              className="input"
              type="number"
              min={1}
              max={30}
              value={planCount}
              onChange={event => setPlanCount(Number(event.target.value))}
              autoFocus
            />
          </Field>
          <div className="field-hint">规划会调用模型，耗时取决于章节数量；完成后这里会自动刷新。</div>
        </div>
      </Modal>
    </div>
  )
}
