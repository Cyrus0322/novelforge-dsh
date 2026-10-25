import { useMemo, useState } from 'react'
import type { PageProps } from '../app/types.ts'
import { api, ApiError } from '../lib/api.ts'
import { confirmDialog, toast, useResource } from '../lib/hooks.ts'
import { label, relativeTime, truncate } from '../lib/format.ts'
import type { Tone } from '../lib/format.ts'
import { Badge, Card, Empty, ErrorBox, Loading, Modal, SectionTitle, Stat } from '../components/ui.tsx'
import type { Chapter, Foreshadowing } from '../lib/types.ts'

// 伏笔状态生命周期：open → reinforced → payoff / abandoned。
const LIFECYCLE: readonly string[] = ['open', 'reinforced', 'payoff', 'abandoned']
const LIFECYCLE_LABELS: Record<string, string> = {
  open: '未回收',
  reinforced: '已强化',
  payoff: '已回收',
  abandoned: '已废弃',
}
const LIFECYCLE_TONES: Record<string, Tone> = {
  open: 'info',
  reinforced: 'accent',
  payoff: 'ok',
  abandoned: 'muted',
}
const LIFECYCLE_HINTS: Record<string, string> = {
  open: '已埋设，等待回收',
  reinforced: '多次铺垫，尚未回收',
  payoff: '已在正文回收',
  abandoned: '放弃回收',
}

interface ForeshadowEditor {
  id: string
  name: string
  description: string
  status: string
  payoffChapterId: string
  deadlineChapterId: string
  version: number
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'CONFLICT' || error.message.includes('版本已变化'))
}

function statusText(status: string): string {
  return LIFECYCLE_LABELS[status] ?? label(status)
}

function statusTone(status: string): Tone {
  return LIFECYCLE_TONES[status] ?? 'muted'
}

function isUnrecovered(item: Foreshadowing): boolean {
  return item.status !== 'payoff' && item.status !== 'abandoned'
}

// 后端 schema 已加 deadlineChapterId（章号，不是章节 id），但 studio 的 Foreshadowing 类型尚未同步。
type ForeshadowingWithDeadline = Foreshadowing & { deadlineChapterId?: number | null }

function deadlineChapterNo(item: Foreshadowing): number | null {
  const value = (item as ForeshadowingWithDeadline).deadlineChapterId
  return typeof value === 'number' && value > 0 ? value : null
}

/** PATCH /api/foreshadowing/:id 已支持 deadlineChapterId，api.ts 的类型还没声明，这里显式拓宽。 */
type ForeshadowingPatch = Parameters<typeof api.updateForeshadowing>[1] & { deadlineChapterId?: number | null }

function parseDeadline(text: string): number | null | 'invalid' {
  const trimmed = text.trim()
  if (!trimmed) return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 1) return 'invalid'
  return Math.floor(value)
}

function lifecycleRank(status: string): number {
  const index = LIFECYCLE.indexOf(status)
  return index === -1 ? LIFECYCLE.length : index
}

export function ForeshadowingPage({ projectId }: PageProps) {
  const foreshadowing = useResource(() => api.listForeshadowing(projectId), [projectId])
  const chapters = useResource(() => api.listChapters(projectId), [projectId])
  const overdue = useResource(() => api.listOverdueForeshadowing(projectId), [projectId])

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newPlantChapterId, setNewPlantChapterId] = useState('')
  const [newDeadline, setNewDeadline] = useState('')
  const [editor, setEditor] = useState<ForeshadowEditor | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)

  const chapterById = useMemo(() => {
    const map = new Map<string, Chapter>()
    for (const chapter of chapters.data ?? []) map.set(chapter.id, chapter)
    return map
  }, [chapters.data])

  // 写到第几章：优先用逾期接口给出的进度，其次按已定稿章节推算（与后端一致）。
  const progress = useMemo(() => {
    const fromOverdue = overdue.data?.find(item => typeof item.progressChapterNo === 'number')?.progressChapterNo
    if (typeof fromOverdue === 'number') return fromOverdue
    const list = chapters.data ?? []
    const finalized = list.filter(chapter => chapter.status === 'finalized')
    if (finalized.length > 0) return Math.max(...finalized.map(chapter => chapter.chapterNo))
    return list.length > 0 ? Math.min(...list.map(chapter => chapter.chapterNo)) - 1 : 0
  }, [overdue.data, chapters.data])

  const deadlineFlags = useMemo(() => {
    const overdueIds = new Set<string>()
    for (const item of overdue.data ?? []) overdueIds.add(item.id)
    const dueSoonIds = new Set<string>()
    for (const item of foreshadowing.data ?? []) {
      if (!isUnrecovered(item)) continue
      const deadline = deadlineChapterNo(item)
      if (deadline === null || deadline <= progress) continue
      if (deadline <= progress + 3) dueSoonIds.add(item.id)
    }
    return { overdueIds, dueSoonIds }
  }, [overdue.data, foreshadowing.data, progress])

  const sorted = useMemo(() => {
    return [...(foreshadowing.data ?? [])].sort((left, right) => {
      const rank = lifecycleRank(left.status) - lifecycleRank(right.status)
      if (rank !== 0) return rank
      return right.updatedAt.localeCompare(left.updatedAt)
    })
  }, [foreshadowing.data])

  const stats = useMemo(() => {
    const list = foreshadowing.data ?? []
    const unrecovered = list.filter(isUnrecovered).length
    return {
      total: list.length,
      unrecovered,
      open: list.filter(item => item.status === 'open').length,
      reinforced: list.filter(item => item.status === 'reinforced').length,
      recovered: list.filter(item => item.status === 'payoff').length,
      abandoned: list.filter(item => item.status === 'abandoned').length,
      notPaidOff: list.filter(item => item.payoffChapterId === null && isUnrecovered(item)).length,
    }
  }, [foreshadowing.data])

  const overdueCount = overdue.data?.length ?? 0
  const dueSoonCount = deadlineFlags.dueSoonIds.size

  function chapterText(chapterId: string | null): string {
    if (chapterId === null) return '未落到正文'
    const chapter = chapterById.get(chapterId)
    return chapter ? `第 ${chapter.chapterNo} 章 · ${truncate(chapter.title, 14)}` : '未知章节'
  }

  function openEdit(item: Foreshadowing): void {
    setEditorError(null)
    setEditor({
      id: item.id,
      name: item.name,
      description: item.description,
      status: item.status,
      payoffChapterId: item.payoffChapterId ?? '',
      deadlineChapterId: deadlineChapterNo(item)?.toString() ?? '',
      version: item.version,
    })
  }

  function closeEditor(): void {
    if (saving) return
    setEditor(null)
    setEditorError(null)
  }

  async function changeStatus(item: Foreshadowing, status: string): Promise<void> {
    if (item.status === status) return
    if (status === 'abandoned') {
      const ok = await confirmDialog({
        title: '标记为已废弃？',
        message: `「${item.name}」将被标记为 abandoned（放弃回收）。\n之后仍可改回其它状态，但请确认这条伏笔不再需要呼应。`,
        confirmLabel: '标记废弃',
        danger: true,
      })
      if (!ok) return
    }
    setPendingId(item.id)
    try {
      await api.updateForeshadowing(item.id, { status, expectedVersion: item.version })
      toast.ok('已保存')
      foreshadowing.reload()
      overdue.reload()
    } catch (error) {
      if (isVersionConflict(error)) {
        toast.error('资料已被其它窗口修改，已刷新')
        foreshadowing.reload()
      } else {
        toast.error(error instanceof Error ? error.message : String(error))
      }
    } finally {
      setPendingId(null)
    }
  }

  async function createForeshadowing(): Promise<void> {
    const name = newName.trim()
    if (!name) {
      toast.error('伏笔名称不能为空。')
      return
    }
    const deadline = parseDeadline(newDeadline)
    if (deadline === 'invalid') {
      toast.error('最晚回收章必须是 ≥ 1 的章号，留空表示不设截止。')
      return
    }
    setSaving(true)
    try {
      const created = await api.createForeshadowing(projectId, {
        name,
        ...(newDescription.trim() ? { description: newDescription.trim() } : {}),
        status: 'open',
        ...(newPlantChapterId ? { plantChapterId: newPlantChapterId } : {}),
      })
      if (deadline !== null) {
        const patch: ForeshadowingPatch = { deadlineChapterId: deadline }
        await api.updateForeshadowing(created.id, patch)
      }
      toast.ok('伏笔已埋设')
      setCreating(false)
      setNewName('')
      setNewDescription('')
      setNewPlantChapterId('')
      setNewDeadline('')
      foreshadowing.reload()
      overdue.reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  async function submit(): Promise<void> {
    if (!editor) return
    const name = editor.name.trim()
    if (!name) {
      setEditorError('伏笔名称不能为空。')
      return
    }
    const deadline = parseDeadline(editor.deadlineChapterId)
    if (deadline === 'invalid') {
      setEditorError('最晚回收章必须是 ≥ 1 的章号，留空表示不设截止。')
      return
    }
    setSaving(true)
    setEditorError(null)
    try {
      const patch: ForeshadowingPatch = {
        name,
        description: editor.description,
        status: editor.status,
        payoffChapterId: editor.payoffChapterId === '' ? null : editor.payoffChapterId,
        expectedVersion: editor.version,
        deadlineChapterId: deadline,
      }
      await api.updateForeshadowing(editor.id, patch)
      toast.ok('已保存')
      setEditor(null)
      foreshadowing.reload()
      overdue.reload()
    } catch (error) {
      if (isVersionConflict(error)) {
        toast.error('资料已被其它窗口修改，已刷新')
        setEditor(null)
        foreshadowing.reload()
      } else {
        const message = error instanceof Error ? error.message : String(error)
        setEditorError(message)
        toast.error(message)
      }
    } finally {
      setSaving(false)
    }
  }

  if (foreshadowing.loading && !foreshadowing.data) return <Loading text="正在载入伏笔…" />
  if (foreshadowing.error) return <ErrorBox error={foreshadowing.error} onRetry={foreshadowing.reload} />

  const total = foreshadowing.data?.length ?? 0

  return (
    <div className="stack">
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--serif)' }}>伏笔</h1>
          <div className="muted small">维护埋设、强化、回收与废弃；未回收的伏笔会进入每次写作的上下文包。</div>
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            onClick={() => { foreshadowing.reload(); chapters.reload(); overdue.reload() }}
          >
            刷新
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>埋一条伏笔</button>
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="伏笔总数" value={total} hint={`含已废弃 ${stats.abandoned}`} />
        <Stat
          label="未回收"
          value={stats.unrecovered}
          tone={stats.unrecovered > 0 ? 'warn' : undefined}
          hint={`open ${stats.open} · reinforced ${stats.reinforced}`}
        />
        <Stat label="已回收" value={stats.recovered} tone="ok" hint="payoff" />
        <Stat
          label="逾期"
          value={overdueCount}
          tone={overdueCount > 0 ? 'danger' : undefined}
          hint={`已写到第 ${progress} 章 · ${dueSoonCount} 条 3 章内到期`}
        />
      </div>

      {stats.unrecovered > 0 && (
        <div className="notice">
          还有 <strong>{stats.unrecovered} 条伏笔未回收</strong>：open（已埋设）与 reinforced（已强化）都算未回收，注意在后续章节安排呼应。其中 {stats.notPaidOff} 条还没有指定回收章节。
        </div>
      )}

      {overdueCount > 0 && (
        <div className="notice" style={{ borderColor: 'rgba(227, 114, 106, 0.38)', background: 'var(--danger-soft)', color: '#f2b6b0' }}>
          有 <strong>{overdueCount} 条伏笔已超过最晚回收章</strong>（当前进度：第 {progress} 章）：写作上下文会标红提醒，建议尽快回收；确认放弃的就改成「已废弃」。
        </div>
      )}

      {overdue.error && (
        <div className="error-box">逾期列表加载失败：{overdue.error.message}（逾期标记可能不完整）</div>
      )}

      <SectionTitle
        title="伏笔"
        hint={`${total} 条 · 未回收 ${stats.unrecovered} 条 · 逾期 ${overdueCount} 条 · 当前第 ${progress} 章`}
        actions={<span className="tiny muted">埋设 / 回收章节为空表示该伏笔还没有落到正文</span>}
      />

      <Modal
        open={creating}
        title="埋一条伏笔"
        onClose={() => { if (!saving) setCreating(false) }}
        footer={(
          <>
            <button type="button" className="btn" onClick={() => setCreating(false)} disabled={saving}>取消</button>
            <button type="button" className="btn btn-primary" onClick={() => { void createForeshadowing() }} disabled={saving}>
              {saving ? '创建中…' : '创建伏笔'}
            </button>
          </>
        )}
      >
        <div className="stack-sm">
          <label className="field">
            <span className="field-label">伏笔名称</span>
            <input className="input" value={newName} onChange={event => setNewName(event.target.value)} placeholder="例如：青铜钥匙" autoFocus />
          </label>
          <label className="field">
            <span className="field-label">描述</span>
            <textarea className="textarea" rows={3} value={newDescription} onChange={event => setNewDescription(event.target.value)} placeholder="埋在哪、暗示什么、打算怎么回收" />
          </label>
          <label className="field">
            <span className="field-label">埋设章节</span>
            <select className="select" value={newPlantChapterId} onChange={event => setNewPlantChapterId(event.target.value)}>
              <option value="">暂不指定（尚未落到正文）</option>
              {(chapters.data ?? []).map(chapter => (
                <option key={chapter.id} value={chapter.id}>第 {chapter.chapterNo} 章 · {chapter.title}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">最晚回收章（可选）</span>
            <input
              className="input"
              type="number"
              min={1}
              step={1}
              value={newDeadline}
              onChange={event => setNewDeadline(event.target.value)}
              placeholder="填章号，例如 12；留空表示不设截止"
            />
            <span className="field-hint">到这一章仍未回收，会在控制台和写作上下文里标红提醒。</span>
          </label>
        </div>
      </Modal>

      {total === 0 ? (
        <Empty
          title="还没有伏笔记录"
          hint="可以手动埋一条，也可以等章节定稿后由变更提议写入；状态流转是 未回收 → 已强化 → 已回收 / 已废弃。"
          action={<button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>埋第一条伏笔</button>}
        />
      ) : (
        <Card tight>
          <div className="list">
            {sorted.map(item => {
              const unrecovered = isUnrecovered(item)
              const busy = pendingId === item.id
              const deadline = deadlineChapterNo(item)
              const isOverdue = deadlineFlags.overdueIds.has(item.id)
              const isDueSoon = deadlineFlags.dueSoonIds.has(item.id)
              return (
                <div className="list-item" key={item.id} style={{ cursor: 'default', opacity: item.status === 'abandoned' ? 0.72 : 1 }}>
                  <div className="list-item-main">
                    <div className="list-item-title">
                      <span>{item.name}</span>
                      <Badge tone={statusTone(item.status)} dot>{statusText(item.status)}</Badge>
                      {unrecovered && <span className="badge badge-warn">待回响</span>}
                      {unrecovered && (
                        isOverdue ? (
                          <Badge tone="danger" dot>逾期 · 最晚第 {deadline} 章</Badge>
                        ) : deadline !== null ? (
                          <Badge tone={isDueSoon ? 'warn' : 'muted'} dot={isDueSoon}>最晚第 {deadline} 章</Badge>
                        ) : (
                          <span className="badge badge-muted">未设最晚回收章</span>
                        )
                      )}
                      <span className="tiny muted" style={{ marginLeft: 'auto' }}>v{item.version}</span>
                    </div>

                    <div className="list-item-meta" style={{ marginTop: 3, fontSize: 12.5 }}>
                      {item.description.trim() ? truncate(item.description, 220) : '（暂无描述）'}
                    </div>

                    <div className="row-wrap" style={{ marginTop: 6 }}>
                      <span className="tiny muted">埋设：{chapterText(item.plantChapterId)}</span>
                      <span className="tiny muted">回收：{chapterText(item.payoffChapterId)}</span>
                      <span className="tiny muted" style={isOverdue ? { color: 'var(--danger)' } : undefined}>
                        最晚回收：{deadline !== null ? `第 ${deadline} 章` : '未设置'}
                      </span>
                      <span className="tiny muted">更新于 {relativeTime(item.updatedAt)}</span>
                    </div>

                    <div className="row-wrap" style={{ marginTop: 8 }}>
                      <span className="tiny muted">状态：</span>
                      {LIFECYCLE.map(status => (
                        <button
                          key={status}
                          type="button"
                          className={`chip${item.status === status ? ' active' : ''}`}
                          style={{ font: 'inherit' }}
                          title={LIFECYCLE_HINTS[status] ?? status}
                          disabled={busy}
                          onClick={() => { void changeStatus(item, status) }}
                        >
                          {statusText(status)}
                        </button>
                      ))}
                      {item.status !== 'payoff' && item.payoffChapterId === null && (
                        <span className="tiny muted">（回收章节未设置）</span>
                      )}
                    </div>
                  </div>

                  <div className="list-item-actions">
                    <button type="button" className="btn btn-sm" onClick={() => openEdit(item)}>编辑</button>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      <Modal
        open={editor !== null}
        title={editor ? `编辑伏笔：${editor.name}` : '编辑伏笔'}
        onClose={closeEditor}
        footer={(
          <>
            <button type="button" className="btn" onClick={closeEditor}>取消</button>
            <button type="button" className="btn btn-primary" disabled={saving} onClick={() => { void submit() }}>
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        )}
      >
        {editor && (
          <div className="stack-sm">
            {editorError && <div className="error-box">{editorError}</div>}

            <label className="field">
              <span className="field-label">名称 name</span>
              <input className="input" value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} />
            </label>

            <label className="field">
              <span className="field-label">描述 description</span>
              <textarea
                className="textarea"
                rows={4}
                value={editor.description}
                onChange={event => setEditor({ ...editor, description: event.target.value })}
              />
            </label>

            <div className="grid-2">
              <label className="field">
                <span className="field-label">状态 status</span>
                <select className="select" value={editor.status} onChange={event => setEditor({ ...editor, status: event.target.value })}>
                  {!LIFECYCLE.includes(editor.status) && <option value={editor.status}>{statusText(editor.status)}</option>}
                  {LIFECYCLE.map(status => <option key={status} value={status}>{statusText(status)}</option>)}
                </select>
                <span className="field-hint">{LIFECYCLE_HINTS[editor.status] ?? '未回收 → 已强化 → 已回收 / 已废弃'}</span>
              </label>

              <label className="field">
                <span className="field-label">回收章节 payoffChapterId</span>
                <select
                  className="select"
                  value={editor.payoffChapterId}
                  onChange={event => setEditor({ ...editor, payoffChapterId: event.target.value })}
                >
                  <option value="">未落到正文（清空回收章节）</option>
                  {(chapters.data ?? []).map(chapter => (
                    <option key={chapter.id} value={chapter.id}>第 {chapter.chapterNo} 章 · {truncate(chapter.title, 24)}</option>
                  ))}
                  {editor.payoffChapterId !== '' && !chapterById.has(editor.payoffChapterId) && (
                    <option value={editor.payoffChapterId}>未知章节（{editor.payoffChapterId.slice(0, 8)}）</option>
                  )}
                </select>
                <span className="field-hint">埋设章节只读展示；这里可以指定或清空回收章节。</span>
              </label>
            </div>

            <label className="field">
              <span className="field-label">最晚回收章 deadlineChapterId</span>
              <input
                className="input"
                type="number"
                min={1}
                step={1}
                value={editor.deadlineChapterId}
                onChange={event => setEditor({ ...editor, deadlineChapterId: event.target.value })}
                placeholder="章号，例如 12；留空表示不设截止"
              />
              <span className="field-hint">填「第几章」而不是章节 ID；到章未回收会在控制台与写作上下文标红。</span>
            </label>

            <div className="tiny muted">
              版本 v{editor.version} · id {editor.id.slice(0, 8)} · 保存会带 expectedVersion，避免覆盖其它窗口的修改。
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
