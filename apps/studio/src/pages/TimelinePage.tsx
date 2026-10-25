import { useMemo, useRef, useState } from 'react'
import type { PageProps } from '../app/types.ts'
import { api, ApiError } from '../lib/api.ts'
import { toast, useResource } from '../lib/hooks.ts'
import { label, relativeTime, truncate } from '../lib/format.ts'
import { Badge, Card, Empty, ErrorBox, Field, Kv, Loading, Modal, SectionTitle, Stat, StatusBadge } from '../components/ui.tsx'
import type { Chapter, EventImpact, StoryEvent } from '../lib/types.ts'

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

const KNOWER_STATE_LABELS: Record<string, string> = {
  knows: '知道',
  suspects: '怀疑',
  misbelieves: '误信',
  unaware: '不知道',
}

function knowerStateLabel(state: string): string {
  return KNOWER_STATE_LABELS[state] ?? state
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

  // 影响分析：改一个事件会影响哪些后续内容。
  const [impactTarget, setImpactTarget] = useState<StoryEvent | null>(null)
  const [impact, setImpact] = useState<EventImpact | null>(null)
  const [impactError, setImpactError] = useState<string | null>(null)
  const [impactLoading, setImpactLoading] = useState(false)
  const impactRequestRef = useRef(0)

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

  async function openImpact(event: StoryEvent): Promise<void> {
    impactRequestRef.current += 1
    const requestId = impactRequestRef.current
    setImpactTarget(event)
    setImpact(null)
    setImpactError(null)
    setImpactLoading(true)
    try {
      const result = await api.getEventImpact(event.id)
      if (impactRequestRef.current !== requestId) return
      setImpact(result)
    } catch (cause) {
      if (impactRequestRef.current !== requestId) return
      setImpactError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (impactRequestRef.current === requestId) setImpactLoading(false)
    }
  }

  function closeImpact(): void {
    impactRequestRef.current += 1
    setImpactTarget(null)
    setImpact(null)
    setImpactError(null)
    setImpactLoading(false)
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
                        <button type="button" className="btn btn-sm" onClick={() => { void openImpact(event) }}>影响分析</button>
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </Card>
      )}
      <Modal
        open={impactTarget !== null}
        title={impactTarget ? `影响分析：${truncate(impactTarget.summary, 22)}` : '影响分析'}
        wide
        onClose={closeImpact}
        footer={(
          <>
            <button type="button" className="btn" onClick={closeImpact}>关闭</button>
            {impactTarget && impact && impact.chapters.length > 0 && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const first = impact.chapters[0]
                  if (first) openChapter(first.chapter)
                }}
              >
                打开第一个受影响章节
              </button>
            )}
          </>
        )}
      >
        {impactLoading ? (
          <Loading text="正在分析这个事件和后续内容的关联…" />
        ) : impactError ? (
          <ErrorBox
            error={new Error(impactError)}
            onRetry={() => { if (impactTarget) void openImpact(impactTarget) }}
          />
        ) : impact ? (
          <div className="stack scroll-y" style={{ maxHeight: '62vh', paddingRight: 4 }}>
            <div className="notice">
              改动此事件需回看以下后续内容：共 <strong>{impact.total}</strong> 处关联
              （后续章节 {impact.chapters.length} · 伏笔 {impact.foreshadowing.length} · 剧情线 {impact.threads.length} · 知情事实 {impact.knowledge.length}）。
              事件摘要里的关键词会命中未定稿章节的标题 / 摘要 / 章纲，命中越多，改动后越要检查一致性。
            </div>

            <Kv rows={[
              { key: '事件', value: impact.event.summary },
              { key: '状态', value: <StatusBadge status={impact.event.status} /> },
              { key: '所在章节', value: impact.chapterNo !== null ? `第 ${impact.chapterNo} 章` : '未关联章节' },
              {
                key: '关键词',
                value: impact.keywords.length > 0 ? (
                  <span className="row-wrap" style={{ gap: 5 }}>
                    {impact.keywords.map(keyword => <span key={keyword} className="chip">{keyword}</span>)}
                  </span>
                ) : '（摘要太短，没有抽出关键词）',
              },
            ]} />

            <SectionTitle title="后续受影响章节" hint="只统计未定稿章节；点一行直接打开工作台" />
            {impact.chapters.length === 0 ? (
              <div className="hint-box">没有命中的后续章节。要么事件摘要里的关键词太泛，要么后续章节还没写到相关内容。</div>
            ) : (
              <div className="list">
                {impact.chapters.map(item => (
                  <button
                    key={item.chapter.id}
                    type="button"
                    className="list-item"
                    style={{ width: '100%' }}
                    onClick={() => openChapter(item.chapter)}
                  >
                    <div className="list-item-main">
                      <div className="list-item-title">
                        <span className="mono muted">第 {item.chapter.chapterNo} 章</span>
                        <span>{item.chapter.title}</span>
                        <StatusBadge status={item.chapter.status} />
                      </div>
                      <div className="list-item-meta">命中：{item.hits.join('、')}</div>
                    </div>
                    <div className="list-item-actions"><span className="tiny muted">打开</span></div>
                  </button>
                ))}
              </div>
            )}

            <div className="grid-2">
              <Card title="相关伏笔" subtitle="埋设章节在本事件之后的未回收伏笔" tight>
                {impact.foreshadowing.length === 0 ? (
                  <div className="small muted">没有相关伏笔。</div>
                ) : (
                  <div className="stack-sm">
                    {impact.foreshadowing.map(item => (
                      <div key={item.id} className="row-wrap" style={{ justifyContent: 'space-between' }}>
                        <span className="small dim">{truncate(item.name, 24)}</span>
                        <StatusBadge status={item.status} />
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card title="相关剧情线" subtitle="仍在推进、可能被本事件影响的线" tight>
                {impact.threads.length === 0 ? (
                  <div className="small muted">没有相关剧情线。</div>
                ) : (
                  <div className="stack-sm">
                    {impact.threads.map(item => (
                      <div key={item.id} className="row-wrap" style={{ justifyContent: 'space-between' }}>
                        <span className="small dim">{truncate(item.name, 24)}</span>
                        <span className="row-wrap">
                          <Badge tone="info">{label(item.kind)}</Badge>
                          <StatusBadge status={item.status} />
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>

            <Card title="相关知情事实" subtitle="事件参与者知道 / 误信的事：改事件时要一起调整信息差" tight>
              {impact.knowledge.length === 0 ? (
                <div className="small muted">参与者没有关联任何知情事实。</div>
              ) : (
                <div className="stack-sm">
                  {impact.knowledge.map(fact => (
                    <div key={fact.id}>
                      <div className="small dim">{truncate(fact.proposition, 80)}</div>
                      <div className="tiny muted">
                        知情：{fact.knowers.length === 0
                          ? '（未登记）'
                          : fact.knowers.map(knower => `${knower.name}·${knowerStateLabel(knower.state)}`).join('、')}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <div className="tiny muted">
              提示：这里只做只读分析，不会改动任何资料；要改事件请用「编辑」，改完再回来重跑一次影响分析。
            </div>
          </div>
        ) : (
          <Empty title="还没有分析结果" hint="重新打开影响分析试试。" />
        )}
      </Modal>
    </div>
  )
}
