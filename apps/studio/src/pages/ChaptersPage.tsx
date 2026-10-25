import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '../lib/api.ts'
import type { ChapterSummary } from '../lib/types.ts'
import type { PageProps } from '../app/types.ts'
import { toast, useResource } from '../lib/hooks.ts'
import { label, relativeTime } from '../lib/format.ts'
import { Badge, Card, Empty, ErrorBox, Field, Loading, Modal, Stat, StatusBadge, Tabs } from '../components/ui.tsx'

type Filter = 'all' | 'todo' | 'draft' | 'review' | 'done'

const FILTERS: Array<{ key: Filter; label: string; match: (status: string) => boolean }> = [
  { key: 'all', label: '全部', match: () => true },
  { key: 'todo', label: '待写', match: status => status === 'planned' || status === 'context_ready' },
  { key: 'draft', label: '草稿中', match: status => ['draft_generated', 'manual_draft', 'revising', 'reviewing'].includes(status) },
  { key: 'review', label: '待定稿', match: status => ['awaiting_approval', 'needs_author_decision'].includes(status) },
  { key: 'done', label: '已定稿', match: status => status === 'finalized' },
]

export function ChaptersPage({ projectId, navigate }: PageProps) {
  const [filter, setFilter] = useState<Filter>('all')
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const summaries = useResource(() => api.listChapterSummaries(projectId), [projectId])

  const rows = summaries.data ?? []
  const activeFilter = FILTERS.find(item => item.key === filter) ?? FILTERS[0]
  const visible = rows.filter(row => activeFilter ? activeFilter.match(row.chapter.status) : true)
  const totalWords = rows.reduce((sum, row) => sum + (row.latest?.words ?? 0), 0)
  const finalizedWords = rows.filter(row => row.chapter.status === 'finalized').reduce((sum, row) => sum + (row.latest?.words ?? 0), 0)
  const counts = useMemo(() => {
    const map = new Map<Filter, number>()
    for (const item of FILTERS) map.set(item.key, rows.filter(row => item.match(row.chapter.status)).length)
    return map
  }, [rows])

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
      openChapter(created.chapter.id)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  if (summaries.loading && !summaries.data) return <Loading text="正在读取章节…" />
  if (summaries.error) return <ErrorBox error={summaries.error} onRetry={summaries.reload} />

  return (
    <div className="stack">
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--serif)' }}>章节</h1>
          <div className="muted small">章节来自大纲规划，也可以手动新增；正文只追加新版本，不覆盖历史。</div>
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={summaries.reload}>刷新</button>
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>新建章节</button>
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="章节数" value={rows.length} hint={`已定稿 ${counts.get('done') ?? 0}`} />
        <Stat label="正文总字数" value={totalWords.toLocaleString()} />
        <Stat label="已定稿字数" value={finalizedWords.toLocaleString()} tone="ok" />
        <Stat label="待写" value={counts.get('todo') ?? 0} tone={(counts.get('todo') ?? 0) > 0 ? 'warn' : undefined} />
      </div>

      <Tabs
        value={filter}
        onChange={setFilter}
        items={FILTERS.map(item => ({ key: item.key, label: item.label, count: counts.get(item.key) ?? 0 }))}
      />

      {visible.length === 0 ? (
        <Empty
          title={rows.length ? '该筛选下没有章节' : '还没有章节'}
          hint={rows.length ? '换一个筛选条件试试。' : '去大纲页用 AI 规划一批章节，或点右上角手动新建第一章。'}
          action={rows.length ? undefined : <button type="button" className="btn" onClick={() => setCreating(true)}>新建第一章</button>}
        />
      ) : (
        <Card tight>
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
              {visible.map((row: ChapterSummary) => (
                <tr key={row.chapter.id} style={{ cursor: 'pointer' }} onClick={() => openChapter(row.chapter.id)}>
                  <td className="mono muted">{row.chapter.chapterNo}</td>
                  <td>
                    <div style={{ fontFamily: 'var(--serif)', fontSize: 14 }}>{row.chapter.title}</div>
                    <div className="tiny muted">
                      {row.latest ? `最新正文 ${label(row.latest.kind)} · ${relativeTime(row.latest.createdAt)}` : '尚无正文'}
                    </div>
                  </td>
                  <td><StatusBadge status={row.chapter.status} /></td>
                  <td>{row.latest ? <span className="mono small">#{row.latest.revisionNo} <Badge tone="muted">{label(row.latest.status)}</Badge></span> : <span className="muted small">—</span>}</td>
                  <td className="num mono">{row.latest ? row.latest.words.toLocaleString() : '—'}</td>
                  <td className="num mono muted">{row.revisionCount}</td>
                  <td className="tiny muted">{relativeTime(row.chapter.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
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
          <div className="field-hint">会同时生成一条章级大纲，之后可在「大纲」页补充章节目标、冲突和钩子。</div>
        </form>
      </Modal>
    </div>
  )
}
