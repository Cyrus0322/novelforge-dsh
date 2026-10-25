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

function lifecycleRank(status: string): number {
  const index = LIFECYCLE.indexOf(status)
  return index === -1 ? LIFECYCLE.length : index
}

export function ForeshadowingPage({ projectId }: PageProps) {
  const foreshadowing = useResource(() => api.listForeshadowing(projectId), [projectId])
  const chapters = useResource(() => api.listChapters(projectId), [projectId])

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newPlantChapterId, setNewPlantChapterId] = useState('')
  const [editor, setEditor] = useState<ForeshadowEditor | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)

  const chapterById = useMemo(() => {
    const map = new Map<string, Chapter>()
    for (const chapter of chapters.data ?? []) map.set(chapter.id, chapter)
    return map
  }, [chapters.data])

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
    setSaving(true)
    try {
      await api.createForeshadowing(projectId, {
        name,
        ...(newDescription.trim() ? { description: newDescription.trim() } : {}),
        status: 'open',
        ...(newPlantChapterId ? { plantChapterId: newPlantChapterId } : {}),
      })
      toast.ok('伏笔已埋设')
      setCreating(false)
      setNewName('')
      setNewDescription('')
      setNewPlantChapterId('')
      foreshadowing.reload()
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
    setSaving(true)
    setEditorError(null)
    try {
      await api.updateForeshadowing(editor.id, {
        name,
        description: editor.description,
        status: editor.status,
        payoffChapterId: editor.payoffChapterId === '' ? null : editor.payoffChapterId,
        expectedVersion: editor.version,
      })
      toast.ok('已保存')
      setEditor(null)
      foreshadowing.reload()
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
          <button type="button" className="btn" onClick={foreshadowing.reload}>刷新</button>
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>埋一条伏笔</button>
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="伏笔总数" value={total} hint="含已废弃" />
        <Stat
          label="未回收"
          value={stats.unrecovered}
          tone={stats.unrecovered > 0 ? 'warn' : undefined}
          hint={`open ${stats.open} · reinforced ${stats.reinforced}`}
        />
        <Stat label="已回收" value={stats.recovered} tone="ok" hint="payoff" />
        <Stat label="已废弃" value={stats.abandoned} hint="abandoned" />
      </div>

      {stats.unrecovered > 0 && (
        <div className="notice">
          还有 <strong>{stats.unrecovered} 条伏笔未回收</strong>：open（已埋设）与 reinforced（已强化）都算未回收，注意在后续章节安排呼应。其中 {stats.notPaidOff} 条还没有指定回收章节。
        </div>
      )}

      <SectionTitle
        title="伏笔"
        hint={`${total} 条 · 未回收 ${stats.unrecovered} 条`}
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
              return (
                <div className="list-item" key={item.id} style={{ cursor: 'default', opacity: item.status === 'abandoned' ? 0.72 : 1 }}>
                  <div className="list-item-main">
                    <div className="list-item-title">
                      <span>{item.name}</span>
                      <Badge tone={statusTone(item.status)} dot>{statusText(item.status)}</Badge>
                      {unrecovered && <span className="badge badge-warn">待回响</span>}
                      <span className="tiny muted" style={{ marginLeft: 'auto' }}>v{item.version}</span>
                    </div>

                    <div className="list-item-meta" style={{ marginTop: 3, fontSize: 12.5 }}>
                      {item.description.trim() ? truncate(item.description, 220) : '（暂无描述）'}
                    </div>

                    <div className="row-wrap" style={{ marginTop: 6 }}>
                      <span className="tiny muted">埋设：{chapterText(item.plantChapterId)}</span>
                      <span className="tiny muted">回收：{chapterText(item.payoffChapterId)}</span>
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

            <div className="tiny muted">
              版本 v{editor.version} · id {editor.id.slice(0, 8)} · 保存会带 expectedVersion，避免覆盖其它窗口的修改。
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
