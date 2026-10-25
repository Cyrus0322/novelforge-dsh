import { Fragment, useMemo, useState } from 'react'
import { api } from '../lib/api.ts'
import { useResource } from '../lib/hooks.ts'
import type { PageProps } from '../app/types.ts'
import { Card, Empty, ErrorBox, Loading, SectionTitle, StatusBadge } from '../components/ui.tsx'
import { formatTime, label, prettyJson, truncate } from '../lib/format.ts'

function duration(from: string, to: string): string {
  const start = new Date(from).getTime()
  const end = new Date(to).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—'
  const ms = end - start
  if (ms < 1000) return `${ms} 毫秒`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms - minutes * 60_000) / 1000)
  if (minutes < 60) return `${minutes} 分 ${seconds} 秒`
  return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`
}

export function WorkflowsPage({ projectId, navigate }: PageProps) {
  const workflows = useResource(() => api.listWorkflows(projectId), [projectId])
  const chapters = useResource(() => api.listChapters(projectId), [projectId])
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [openId, setOpenId] = useState<string | null>(null)

  const list = workflows.data ?? []
  const states = useMemo(() => {
    const counter = new Map<string, number>()
    for (const run of list) counter.set(run.state, (counter.get(run.state) ?? 0) + 1)
    return [...counter.entries()].map(([state, count]) => ({ state, count }))
  }, [list])
  const visible = statusFilter === 'all' ? list : list.filter(run => run.state === statusFilter)

  function chapterLabel(chapterId: string | null): string {
    if (!chapterId) return '—'
    const chapter = (chapters.data ?? []).find(item => item.id === chapterId)
    if (!chapter) return truncate(chapterId, 20)
    return truncate(`第 ${chapter.chapterNo} 章 · ${chapter.title}`, 34)
  }

  return (
    <div className="stack">
      <SectionTitle
        title="工作流"
        hint="写作、审查、修订、规划都会留下一条可恢复的检查点。"
        actions={(
          <button
            type="button"
            className="btn btn-sm"
            disabled={workflows.loading}
            onClick={() => { workflows.reload(); chapters.reload() }}
          >
            刷新
          </button>
        )}
      />

      {workflows.error && <ErrorBox error={workflows.error} onRetry={workflows.reload} />}
      {chapters.error && <div className="hint-box">章节标题暂时载入失败，章节列会显示为 ID：{chapters.error.message}</div>}

      {workflows.loading && !workflows.data ? (
        <Card><Loading text="正在载入工作流记录…" /></Card>
      ) : list.length === 0 ? (
        <Empty
          title="还没有工作流记录"
          hint="一次写作、审查或规划会留下一条可恢复的检查点；运行中的任务会在开始时写入，结束或失败时更新状态、耗时与错误。"
          action={<button type="button" className="btn btn-primary" onClick={() => navigate(`/p/${encodeURIComponent(projectId)}/chapters`)}>去章节工作台</button>}
        />
      ) : (
        <>
          <div className="row-wrap">
            <button
              type="button"
              className={`chip${statusFilter === 'all' ? ' active' : ''}`}
              onClick={() => setStatusFilter('all')}
            >
              全部 <span className="muted">{list.length}</span>
            </button>
            {states.map(item => (
              <button
                key={item.state}
                type="button"
                className={`chip${statusFilter === item.state ? ' active' : ''}`}
                onClick={() => setStatusFilter(item.state)}
              >
                {label(item.state)} <span className="muted">{item.count}</span>
              </button>
            ))}
          </div>

          <Card tight title="运行记录" subtitle={`共 ${list.length} 条 · 当前筛出 ${visible.length} 条 · 点击行展开检查点`}>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>任务</th>
                    <th>状态</th>
                    <th>章节</th>
                    <th>开始</th>
                    <th>更新</th>
                    <th className="num">耗时</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(run => (
                    <Fragment key={run.id}>
                      <tr
                        onClick={() => setOpenId(previous => (previous === run.id ? null : run.id))}
                        style={{ cursor: 'pointer', background: openId === run.id ? 'var(--surface-2)' : undefined }}
                      >
                        <td>
                          <div className="row" style={{ gap: 6 }}>
                            <span className="muted tiny">{openId === run.id ? '▾' : '▸'}</span>
                            <div style={{ minWidth: 0 }}>
                              <div className="mono">{run.taskType}</div>
                              <div className="tiny muted">{truncate(run.id, 24)}</div>
                            </div>
                          </div>
                        </td>
                        <td><StatusBadge status={run.state} /></td>
                        <td className="small">{chapterLabel(run.chapterId)}</td>
                        <td className="tiny muted nowrap">{formatTime(run.createdAt)}</td>
                        <td className="tiny muted nowrap">{formatTime(run.updatedAt)}</td>
                        <td className="num nowrap">{duration(run.createdAt, run.updatedAt)}</td>
                      </tr>
                      {openId === run.id && (
                        <tr>
                          <td colSpan={6} style={{ background: 'var(--bg-soft)' }}>
                            <div className="stack-sm">
                              <div>
                                <div className="small muted" style={{ marginBottom: 4 }}>检查点（checkpoint）</div>
                                <pre style={PRE_STYLE}>{prettyJson(run.checkpointJson)}</pre>
                              </div>
                              {run.error ? (
                                <div>
                                  <div className="small muted" style={{ marginBottom: 4 }}>错误</div>
                                  <div className="error-box">{run.error}</div>
                                </div>
                              ) : (
                                <div className="tiny muted">没有记录错误。</div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            {visible.length === 0 && <div className="empty" style={{ marginTop: 12 }}>这个状态下没有运行记录。</div>}
          </Card>
        </>
      )}
    </div>
  )
}

const PRE_STYLE = {
  margin: 0,
  padding: '9px 11px',
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--surface)',
  maxHeight: 320,
  overflow: 'auto',
  whiteSpace: 'pre-wrap' as const,
  wordBreak: 'break-word' as const,
  fontFamily: 'var(--mono)',
  fontSize: 11.5,
  lineHeight: 1.6,
  color: 'var(--text-dim)',
}
