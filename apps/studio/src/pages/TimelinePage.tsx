import { useMemo, useState } from 'react'
import type { PageProps } from '../app/types.ts'
import { api, ApiError } from '../lib/api.ts'
import { toast, useResource } from '../lib/hooks.ts'
import { label, relativeTime, truncate } from '../lib/format.ts'
import { Badge, Card, Empty, ErrorBox, Field, Loading, Modal, SectionTitle, Stat, StatusBadge } from '../components/ui.tsx'
import type { Chapter, StoryEvent } from '../lib/types.ts'

const EVENT_EDIT_STATUSES: readonly string[] = ['planned', 'draft', 'confirmed', 'cancelled']

function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'CONFLICT' || error.message.includes('版本已变化'))
}

function compareEvents(left: StoryEvent, right: StoryEvent): number {
  const leftTime = left.eventTime.trim()
  const rightTime = right.eventTime.trim()
  // 空 eventTime 表示「未定时间」，统一排在最后。
  if (!leftTime && !rightTime) return left.createdAt.localeCompare(right.createdAt)
  if (!leftTime) return 1
  if (!rightTime) return -1
  return leftTime.localeCompare(rightTime, 'zh-Hans-CN') || left.createdAt.localeCompare(right.createdAt)
}

function timelineClass(status: string): string {
  return status === 'planned' || status === 'confirmed' || status === 'cancelled' ? ` ${status}` : ''
}

export function TimelinePage({ projectId, navigate }: PageProps) {
  const events = useResource(() => api.listEvents(projectId), [projectId])
  const chapters = useResource(() => api.listChapters(projectId), [projectId])

  const [statusFilter, setStatusFilter] = useState('all')
  const [creating, setCreating] = useState(false)
  const [newSummary, setNewSummary] = useState('')
  const [newTime, setNewTime] = useState('')
  const [newStatus, setNewStatus] = useState('confirmed')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editSummary, setEditSummary] = useState('')
  const [editTime, setEditTime] = useState('')
  const [editStatus, setEditStatus] = useState('planned')
  const [saving, setSaving] = useState(false)

  const sorted = useMemo(() => [...(events.data ?? [])].sort(compareEvents), [events.data])

  const chapterById = useMemo(() => {
    const map = new Map<string, Chapter>()
    for (const chapter of chapters.data ?? []) map.set(chapter.id, chapter)
    return map
  }, [chapters.data])

  function findChapter(chapterId: string | null): Chapter | undefined {
    return chapterId === null ? undefined : chapterById.get(chapterId)
  }

  const statusOptions = useMemo(() => {
    const known = ['planned', 'confirmed', 'cancelled']
    const extras = [...new Set((events.data ?? []).map(event => event.status))]
      .filter(status => !known.includes(status))
      .sort((left, right) => left.localeCompare(right))
    return [...known, ...extras]
  }, [events.data])

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const event of events.data ?? []) counts.set(event.status, (counts.get(event.status) ?? 0) + 1)
    return counts
  }, [events.data])

  const filtered = statusFilter === 'all' ? sorted : sorted.filter(event => event.status === statusFilter)

  const stats = useMemo(() => {
    const list = events.data ?? []
    return {
      planned: list.filter(event => event.status === 'planned' || event.status === 'draft').length,
      confirmed: list.filter(event => event.status === 'confirmed').length,
      undated: list.filter(event => !event.eventTime.trim()).length,
      cancelled: list.filter(event => event.status === 'cancelled').length,
    }
  }, [events.data])

  function openEdit(event: StoryEvent): void {
    setEditingId(event.id)
    setEditSummary(event.summary)
    setEditTime(event.eventTime)
    setEditStatus(event.status)
  }

  async function saveEvent(event: StoryEvent): Promise<void> {
    const summary = editSummary.trim()
    if (!summary) {
      toast.error('事件摘要不能为空。')
      return
    }
    setSaving(true)
    try {
      await api.updateEvent(event.id, {
        summary,
        eventTime: editTime.trim(),
        status: editStatus,
        expectedVersion: event.version,
      })
      toast.ok('已保存')
      setEditingId(null)
      events.reload()
    } catch (error) {
      if (isVersionConflict(error)) {
        toast.error('资料已被其它窗口修改，已刷新')
        setEditingId(null)
        events.reload()
      } else {
        toast.error(error instanceof Error ? error.message : String(error))
      }
    } finally {
      setSaving(false)
    }
  }

  async function createEvent(): Promise<void> {
    const summary = newSummary.trim()
    if (!summary) {
      toast.error('事件摘要不能为空。')
      return
    }
    setSaving(true)
    try {
      await api.createEvent(projectId, {
        summary,
        ...(newTime.trim() ? { eventTime: newTime.trim() } : {}),
        status: newStatus,
      })
      toast.ok('事件已创建')
      setCreating(false)
      setNewSummary('')
      setNewTime('')
      setNewStatus('confirmed')
      events.reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  function openChapter(chapter: Chapter): void {
    navigate(`/p/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapter.id)}`)
  }

  if (events.loading && !events.data) return <Loading text="正在载入事件时间线…" />
  if (events.error) return <ErrorBox error={events.error} onRetry={events.reload} />

  const total = events.data?.length ?? 0

  return (
    <div className="stack">
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--serif)' }}>事件时间线</h1>
          <div className="muted small">计划与已发生分开记录；只有 confirmed 会作为上下文里的既成事实。</div>
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={events.reload}>刷新</button>
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>新建事件</button>
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="事件总数" value={total} hint={`${statusOptions.length} 种状态`} />
        <Stat label="计划中（未发生）" value={stats.planned} tone="warn" hint="planned / draft，不是既成事实" />
        <Stat label="已确认发生" value={stats.confirmed} tone="ok" hint="可作为上下文事实" />
        <Stat label="未定时间" value={stats.undated} hint="eventTime 为空" />
      </div>

      <SectionTitle
        title="事件时间线"
        hint={`按 eventTime 升序 · ${filtered.length} / ${total} 条`}
        actions={(
          <>
            <button
              type="button"
              className={`chip${statusFilter === 'all' ? ' active' : ''}`}
              style={{ font: 'inherit' }}
              onClick={() => setStatusFilter('all')}
            >
              全部 <span className="tiny">{total}</span>
            </button>
            {statusOptions.map(status => (
              <button
                key={status}
                type="button"
                className={`chip${statusFilter === status ? ' active' : ''}`}
                style={{ font: 'inherit' }}
                onClick={() => setStatusFilter(status)}
              >
                {label(status)} <span className="tiny">{statusCounts.get(status) ?? 0}</span>
              </button>
            ))}
          </>
        )}
      />

      <Modal
        open={creating}
        title="新建事件"
        onClose={() => setCreating(false)}
        footer={(
          <>
            <button type="button" className="btn" onClick={() => setCreating(false)} disabled={saving}>取消</button>
            <button type="button" className="btn btn-primary" onClick={() => { void createEvent() }} disabled={saving}>
              {saving ? '创建中…' : '创建事件'}
            </button>
          </>
        )}
      >
        <div className="stack-sm">
          <Field label="事件摘要" hint="一句话说清发生了什么">
            <textarea className="textarea" rows={2} value={newSummary} onChange={changeEvent => setNewSummary(changeEvent.target.value)} autoFocus />
          </Field>
          <div className="grid-2">
            <Field label="事件时间" hint="自由文本；留空表示未定">
              <input className="input" value={newTime} onChange={changeEvent => setNewTime(changeEvent.target.value)} placeholder="例如：第三年春 · 第 12 章后" />
            </Field>
            <Field label="状态" hint="confirmed 才表示已经发生">
              <select className="select" value={newStatus} onChange={changeEvent => setNewStatus(changeEvent.target.value)}>
                {EVENT_EDIT_STATUSES.map(status => <option key={status} value={status}>{label(status)}</option>)}
              </select>
            </Field>
          </div>
        </div>
      </Modal>

      {total === 0 ? (
        <Empty
          title="还没有事件记录"
          hint="可以在右上角手动新建，也可以等章节定稿后由变更提议写入。planned / draft 只代表计划，不是已发生的事实。"
          action={<button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>新建第一个事件</button>}
        />
      ) : filtered.length === 0 ? (
        <Empty
          title="该状态下没有事件"
          hint="切换上方的状态筛选，或选择「全部」查看所有事件。"
          action={<button type="button" className="btn btn-sm" onClick={() => setStatusFilter('all')}>查看全部</button>}
        />
      ) : (
        <Card tight>
          <div className="timeline">
            {filtered.map(event => {
              const chapter = findChapter(event.chapterId)
              const isEditing = editingId === event.id
              return (
                <div className={`timeline-item${timelineClass(event.status)}`} key={event.id}>
                  <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
                    <span className="timeline-time">
                      {event.eventTime.trim() || '未定时间'}
                      <span className="muted" style={{ marginLeft: 8 }}>v{event.version}</span>
                    </span>
                    <span className="tiny muted">更新于 {relativeTime(event.updatedAt)}</span>
                  </div>

                  <div className="row-wrap" style={{ marginTop: 5 }}>
                    <StatusBadge status={event.status} />
                    {(event.status === 'planned' || event.status === 'draft') && (
                      <Badge tone="info">计划，不是已发生事实</Badge>
                    )}
                    {chapter ? (
                      <button type="button" className="chip" style={{ font: 'inherit' }} onClick={() => openChapter(chapter)}>
                        第 {chapter.chapterNo} 章 · {truncate(chapter.title, 18)}
                      </button>
                    ) : event.chapterId ? (
                      <Badge tone="muted">关联章节已不存在</Badge>
                    ) : (
                      <Badge tone="muted">未关联章节</Badge>
                    )}
                    <span className="tiny muted mono" title={event.sourceRevisionId ?? undefined}>
                      来源版本 {event.sourceRevisionId ? event.sourceRevisionId.slice(0, 8) : '—'}
                    </span>
                  </div>

                  {isEditing ? (
                    <div className="stack-sm" style={{ marginTop: 8 }}>
                      <label className="field">
                        <span className="field-label">事件摘要 summary</span>
                        <textarea
                          className="textarea"
                          rows={2}
                          value={editSummary}
                          onChange={changeEvent => setEditSummary(changeEvent.target.value)}
                        />
                      </label>
                      <div className="grid-2">
                        <label className="field">
                          <span className="field-label">事件时间 eventTime</span>
                          <input
                            className="input"
                            value={editTime}
                            placeholder="自由文本，如「第三年春 · 第 12 章后」；留空表示未定时间"
                            onChange={changeEvent => setEditTime(changeEvent.target.value)}
                          />
                        </label>
                        <label className="field">
                          <span className="field-label">状态 status</span>
                          <select
                            className="select"
                            value={editStatus}
                            onChange={changeEvent => setEditStatus(changeEvent.target.value)}
                          >
                            {!EVENT_EDIT_STATUSES.includes(editStatus) && <option value={editStatus}>{label(editStatus)}</option>}
                            {EVENT_EDIT_STATUSES.map(status => <option key={status} value={status}>{label(status)}</option>)}
                          </select>
                          <span className="field-hint">confirmed 才表示已经发生；planned / cancelled 不算事实。</span>
                        </label>
                      </div>
                      <div className="btn-row">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={saving}
                          onClick={() => { void saveEvent(event) }}
                        >
                          {saving ? '保存中…' : '保存'}
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => setEditingId(null)}>取消</button>
                        <span className="field-hint">保存会带 expectedVersion = {event.version}，冲突时自动刷新。</span>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={{ marginTop: 7, fontSize: 13.5, lineHeight: 1.8 }}>{event.summary}</div>
                      <div className="btn-row" style={{ marginTop: 6 }}>
                        <button type="button" className="btn btn-sm" onClick={() => openEdit(event)}>编辑</button>
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </Card>
      )}
    </div>
  )
}
