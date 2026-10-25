import { useMemo, useState } from 'react'
import type { PageProps } from '../app/types.ts'
import { api, ApiError } from '../lib/api.ts'
import { confirmDialog, toast, useResource } from '../lib/hooks.ts'
import { relativeTime, truncate } from '../lib/format.ts'
import type { Tone } from '../lib/format.ts'
import { Badge, Card, Empty, ErrorBox, Loading, Modal, SectionTitle, Stat, Tabs } from '../components/ui.tsx'
import type { Chapter, Entity, KnowledgeFact, KnowerEntry } from '../lib/types.ts'

// ── 文案表 ────────────────────────────────────────────────

const TRUTHS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'true', label: '属实' },
  { key: 'partial', label: '部分属实' },
  { key: 'false', label: '假消息' },
]
const TRUTH_LABELS: Record<string, string> = { true: '属实', partial: '部分属实', false: '假消息' }
const TRUTH_TONES: Record<string, Tone> = { true: 'ok', partial: 'warn', false: 'danger' }
const TRUTH_HINTS: Record<string, string> = {
  true: '确实发生了。不知道的角色不能表现出知道。',
  partial: '只对了一半 / 传歪了，知道的人也可能理解错。',
  false: '假消息。信了的角色属于「误信」，不能当成事实写。',
}

const LEVELS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'secret', label: '秘密' },
  { key: 'circle', label: '小圈' },
  { key: 'organization', label: '组织' },
  { key: 'public', label: '公开' },
]
const LEVEL_LABELS: Record<string, string> = { secret: '秘密', circle: '小圈', organization: '组织', public: '公开' }
const LEVEL_TONES: Record<string, Tone> = { secret: 'accent', circle: 'info', organization: 'warn', public: 'ok' }

type KnowerState = KnowerEntry['state']

const KNOWER_STATES: ReadonlyArray<{ key: KnowerState; label: string }> = [
  { key: 'knows', label: '知道' },
  { key: 'suspects', label: '怀疑' },
  { key: 'misbelieves', label: '误信' },
  { key: 'unaware', label: '不知道' },
]
const KNOWER_LABELS: Record<string, string> = { knows: '知道', suspects: '怀疑', misbelieves: '误信', unaware: '不知道' }
const KNOWER_TONES: Record<string, Tone> = { knows: 'ok', suspects: 'warn', misbelieves: 'danger', unaware: 'muted' }

type LevelFilter = 'all' | 'secret' | 'circle' | 'organization' | 'public'

// ── 编辑草稿 ──────────────────────────────────────────────

interface KnowerDraft {
  entityId: string
  state: KnowerState
  sinceChapterId: string
  notes: string
}

interface KnowledgeEditor {
  id: string | null
  proposition: string
  truth: string
  publicLevel: string
  chapterId: string
  notes: string
  knowers: KnowerDraft[]
  version: number
}

function emptyEditor(): KnowledgeEditor {
  return {
    id: null,
    proposition: '',
    truth: 'true',
    publicLevel: 'secret',
    chapterId: '',
    notes: '',
    knowers: [],
    version: 0,
  }
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'CONFLICT' || error.message.includes('版本已变化'))
}

function asKnowerState(value: string): KnowerState {
  if (value === 'suspects' || value === 'misbelieves' || value === 'unaware') return value
  return 'knows'
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── 页面 ─────────────────────────────────────────────────

export function KnowledgePage({ projectId }: PageProps) {
  const knowledge = useResource(() => api.listKnowledge(projectId), [projectId])
  const entities = useResource(() => api.listEntities(projectId), [projectId])
  const chapters = useResource(() => api.listChapters(projectId), [projectId])

  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all')
  const [editor, setEditor] = useState<KnowledgeEditor | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const facts = knowledge.data ?? []
  const entityList = entities.data ?? []
  const chapterList = chapters.data ?? []

  const nameOf = useMemo(() => {
    const map = new Map<string, string>()
    for (const entity of entityList) map.set(entity.id, entity.name)
    return (entityId: string): string => map.get(entityId) ?? entityId.slice(0, 8)
  }, [entityList])

  const counts = useMemo(() => {
    let secret = 0
    let lies = 0
    let orphan = 0
    const knowers = new Set<string>()
    for (const fact of facts) {
      if (fact.publicLevel === 'secret') secret += 1
      if (fact.truth === 'false') lies += 1
      if (fact.knowers.length === 0) orphan += 1
      for (const knower of fact.knowers) knowers.add(knower.entityId)
    }
    return { secret, lies, orphan, knowers: knowers.size }
  }, [facts])

  const levelCounts = useMemo(() => {
    const map = new Map<LevelFilter, number>()
    map.set('all', facts.length)
    for (const level of LEVELS) {
      map.set(level.key as LevelFilter, facts.filter(fact => fact.publicLevel === level.key).length)
    }
    return map
  }, [facts])

  const visible = levelFilter === 'all' ? facts : facts.filter(fact => fact.publicLevel === levelFilter)

  function openCreate(): void {
    setEditorError(null)
    setEditor(emptyEditor())
  }

  function openEdit(fact: KnowledgeFact): void {
    setEditorError(null)
    setEditor({
      id: fact.id,
      proposition: fact.proposition,
      truth: fact.truth || 'true',
      publicLevel: fact.publicLevel || 'secret',
      chapterId: fact.chapterId ?? '',
      notes: fact.notes,
      knowers: fact.knowers.map(entry => ({
        entityId: entry.entityId,
        state: entry.state,
        sinceChapterId: entry.sinceChapterId ?? '',
        notes: entry.notes ?? '',
      })),
      version: fact.version,
    })
  }

  function closeEditor(): void {
    if (saving) return
    setEditor(null)
    setEditorError(null)
  }

  function changeKnower(index: number, patch: Partial<KnowerDraft>): void {
    setEditor(previous => previous === null ? previous : {
      ...previous,
      knowers: previous.knowers.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    })
  }

  function removeKnower(index: number): void {
    setEditor(previous => previous === null ? previous : {
      ...previous,
      knowers: previous.knowers.filter((_item, itemIndex) => itemIndex !== index),
    })
  }

  function addKnower(): void {
    if (!editor) return
    const used = new Set(editor.knowers.map(item => item.entityId))
    const next = entityList.find(entity => !used.has(entity.id))
    if (!next) {
      toast.error(entityList.length === 0 ? '还没有任何人物/势力可以选，先去资料页建实体。' : '所有实体都已登记为知情者。')
      return
    }
    setEditor({
      ...editor,
      knowers: [...editor.knowers, { entityId: next.id, state: 'knows', sinceChapterId: '', notes: '' }],
    })
  }

  function knowerOptions(current: KnowerDraft): Entity[] {
    if (!editor) return entityList
    const used = new Set(editor.knowers.filter(item => item !== current).map(item => item.entityId))
    return entityList.filter(entity => entity.id === current.entityId || !used.has(entity.id))
  }

  async function submit(): Promise<void> {
    if (!editor) return
    const proposition = editor.proposition.trim()
    if (!proposition) {
      setEditorError('事实 / 秘密不能为空。')
      return
    }
    const knowers: Array<{ entityId: string; state: KnowerState; sinceChapterId?: string; notes?: string }> = []
    for (const draft of editor.knowers) {
      if (!draft.entityId) {
        setEditorError('有一条知情者没有选择人物，请补上或删掉。')
        return
      }
      knowers.push({
        entityId: draft.entityId,
        state: draft.state,
        ...(draft.sinceChapterId ? { sinceChapterId: draft.sinceChapterId } : {}),
        ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
      })
    }
    setSaving(true)
    setEditorError(null)
    try {
      if (editor.id === null) {
        await api.createKnowledge(projectId, {
          proposition,
          truth: editor.truth,
          publicLevel: editor.publicLevel,
          chapterId: editor.chapterId === '' ? null : editor.chapterId,
          notes: editor.notes,
          knowers,
        })
        toast.ok('已记入一条知情事实')
      } else {
        await api.updateKnowledge(editor.id, {
          proposition,
          truth: editor.truth,
          publicLevel: editor.publicLevel,
          chapterId: editor.chapterId === '' ? null : editor.chapterId,
          notes: editor.notes,
          knowers,
          expectedVersion: editor.version,
        })
        toast.ok('知情事实已保存')
      }
      setEditor(null)
      knowledge.reload()
    } catch (error) {
      if (isVersionConflict(error)) {
        toast.error('资料已被其它窗口修改，已刷新')
        setEditor(null)
        knowledge.reload()
      } else {
        const message = errorText(error)
        setEditorError(message)
        toast.error(message)
      }
    } finally {
      setSaving(false)
    }
  }

  async function remove(fact: KnowledgeFact): Promise<void> {
    const ok = await confirmDialog({
      title: '删除这条知情事实？',
      message: `「${truncate(fact.proposition, 60)}」将从知情矩阵移除。\n审查器之后不再据此判断角色是否「开天眼」。`,
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return
    setDeletingId(fact.id)
    try {
      await api.deleteKnowledge(fact.id)
      toast.ok('已删除')
      knowledge.reload()
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setDeletingId(null)
    }
  }

  if (knowledge.loading && !knowledge.data) return <Loading text="正在载入知情矩阵…" />
  if (knowledge.error) return <ErrorBox error={knowledge.error} onRetry={knowledge.reload} />

  return (
    <div className="stack">
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--serif)' }}>知情矩阵</h1>
          <div className="muted small">谁在什么时间知道什么、谁被蒙在鼓里；审查器据此检查角色是否开了天眼。</div>
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            onClick={() => { knowledge.reload(); entities.reload(); chapters.reload() }}
          >
            刷新
          </button>
          <button type="button" className="btn btn-primary" onClick={openCreate}>记一条知情事实</button>
        </div>
      </div>

      <div className="notice">
        这里是<strong>误会、装傻、信息差的地基</strong>：一条「事实」+ 谁知道 / 谁怀疑 / 谁误信 / 谁不知道。
        审查器会拿它查角色是否说了只有上帝视角才知道的话。素材导入也会自动抽出这类事实，再到这里修正。
        {entities.error && <div style={{ marginTop: 6 }}>人物列表加载失败：{entities.error.message}（知情者编辑会受影响）</div>}
        {chapters.error && <div style={{ marginTop: 6 }}>章节列表加载失败：{chapters.error.message}</div>}
      </div>

      <div className="stat-grid">
        <Stat label="知情事实" value={facts.length} hint={`涉及 ${counts.knowers} 个角色 / 势力`} />
        <Stat label="秘密" value={counts.secret} hint="secret：只在小范围流通" tone={counts.secret > 0 ? 'accent' : undefined} />
        <Stat label="假消息" value={counts.lies} hint="false：被信了才算误信" tone={counts.lies > 0 ? 'danger' : undefined} />
        <Stat label="没有知情者" value={counts.orphan} hint="还没登记谁知道" tone={counts.orphan > 0 ? 'warn' : undefined} />
      </div>

      <Tabs
        value={levelFilter}
        onChange={setLevelFilter}
        items={[
          { key: 'all', label: '全部', count: levelCounts.get('all') ?? 0 },
          ...LEVELS.map(level => ({
            key: level.key as LevelFilter,
            label: level.label,
            count: levelCounts.get(level.key as LevelFilter) ?? 0,
          })),
        ]}
      />

      {facts.length === 0 ? (
        <Empty
          title="还没有知情事实"
          hint="先想想全书最大的秘密是什么、谁不知道它：比如「师父是杀父仇人」——谁知道、谁怀疑、谁被骗。"
          action={<button type="button" className="btn btn-sm btn-primary" onClick={openCreate}>记第一条</button>}
        />
      ) : visible.length === 0 ? (
        <Empty
          title="这个公开度下没有知情事实"
          hint="切换上方的筛选，或选择「全部」查看所有事实。"
          action={<button type="button" className="btn btn-sm" onClick={() => setLevelFilter('all')}>查看全部</button>}
        />
      ) : (
        <Card tight>
          <div className="list">
            {visible.map(fact => (
              <div className="list-item" key={fact.id} style={{ cursor: 'default' }}>
                <div className="list-item-main">
                  <div className="list-item-title">
                    <Badge tone={TRUTH_TONES[fact.truth] ?? 'muted'} dot>{TRUTH_LABELS[fact.truth] ?? fact.truth}</Badge>
                    <Badge tone={LEVEL_TONES[fact.publicLevel] ?? 'muted'}>{LEVEL_LABELS[fact.publicLevel] ?? fact.publicLevel}</Badge>
                    <span className="tiny muted">{fact.chapterNo !== null ? `涉及第 ${fact.chapterNo} 章` : '未关联章节'}</span>
                    <span className="tiny muted" style={{ marginLeft: 'auto' }}>v{fact.version} · {relativeTime(fact.updatedAt)}</span>
                  </div>

                  <div style={{ marginTop: 5, fontSize: 13.5, lineHeight: 1.75 }}>{fact.proposition}</div>

                  {fact.notes.trim().length > 0 && (
                    <div className="tiny muted" style={{ marginTop: 2 }}>{truncate(fact.notes, 180)}</div>
                  )}

                  <div className="row-wrap" style={{ marginTop: 8 }}>
                    <span className="tiny muted">知情：</span>
                    {fact.knowers.length === 0 ? (
                      <span className="tiny muted">还没有登记任何知情者（审查器无法据此判「开天眼」）</span>
                    ) : (
                      fact.knowers.map(knower => (
                        <Badge key={`${fact.id}-${knower.entityId}`} tone={KNOWER_TONES[knower.state] ?? 'muted'}>
                          {knower.name} · {KNOWER_LABELS[knower.state] ?? knower.state}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>

                <div className="list-item-actions">
                  <button type="button" className="btn btn-sm" onClick={() => openEdit(fact)}>编辑</button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={deletingId === fact.id}
                    onClick={() => { void remove(fact) }}
                  >
                    {deletingId === fact.id ? '删除中…' : '删除'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <SectionTitle title="怎么用" hint="写对白和冲突时翻一眼这里" />
      <div className="grid-3">
        <Card tight><div className="small dim"><b>信息差 = 冲突</b><br />同一件事，A 知道、B 不知道、C 误信了错误版本，三人的对白与反应就不该一样。</div></Card>
        <Card tight><div className="small dim"><b>别让角色开天眼</b><br />不在 knows / suspects 里的角色，不能说出只有真凶或上帝视角才知道的细节。</div></Card>
        <Card tight><div className="small dim"><b>装傻与误会</b><br />「不知道」和「误信」是两种表演：前者要藏，后者会自信地说错话。</div></Card>
      </div>

      <Modal
        open={editor !== null}
        title={editor?.id === null ? '记一条知情事实' : '编辑知情事实'}
        wide
        onClose={closeEditor}
        footer={(
          <>
            <button type="button" className="btn" onClick={closeEditor} disabled={saving}>取消</button>
            <button type="button" className="btn btn-primary" onClick={() => { void submit() }} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        )}
      >
        {editor && (
          <div className="stack-sm scroll-y" style={{ maxHeight: '66vh', paddingRight: 4 }}>
            {editorError && <div className="error-box">{editorError}</div>}

            <label className="field">
              <span className="field-label">事实 / 秘密 proposition</span>
              <textarea
                className="textarea"
                rows={3}
                value={editor.proposition}
                placeholder="例如：师父就是当年灭门案的凶手"
                autoFocus
                onChange={event => setEditor({ ...editor, proposition: event.target.value })}
              />
              <span className="field-hint">一句话写清「一件客观发生的事」，不要写成对话或评价。</span>
            </label>

            <div className="grid-2">
              <label className="field">
                <span className="field-label">真伪 truth</span>
                <select className="select" value={editor.truth} onChange={event => setEditor({ ...editor, truth: event.target.value })}>
                  {!TRUTHS.some(item => item.key === editor.truth) && <option value={editor.truth}>{editor.truth}</option>}
                  {TRUTHS.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
                </select>
                <span className="field-hint">{TRUTH_HINTS[editor.truth] ?? '属实 / 部分属实 / 假消息'}</span>
              </label>

              <label className="field">
                <span className="field-label">公开度 publicLevel</span>
                <select className="select" value={editor.publicLevel} onChange={event => setEditor({ ...editor, publicLevel: event.target.value })}>
                  {!LEVELS.some(item => item.key === editor.publicLevel) && <option value={editor.publicLevel}>{editor.publicLevel}</option>}
                  {LEVELS.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
                </select>
                <span className="field-hint">secret 秘密 / circle 小圈 / organization 组织 / public 公开</span>
              </label>

              <label className="field">
                <span className="field-label">涉及章节 chapterId</span>
                <select className="select" value={editor.chapterId} onChange={event => setEditor({ ...editor, chapterId: event.target.value })}>
                  <option value="">未关联章节</option>
                  {chapterList.map((chapter: Chapter) => (
                    <option key={chapter.id} value={chapter.id}>第 {chapter.chapterNo} 章 · {chapter.title}</option>
                  ))}
                  {editor.chapterId !== '' && !chapterList.some(chapter => chapter.id === editor.chapterId) && (
                    <option value={editor.chapterId}>未知章节（{editor.chapterId.slice(0, 8)}）</option>
                  )}
                </select>
                <span className="field-hint">这条信息第一次成立 / 被揭开的位置。</span>
              </label>

              <label className="field">
                <span className="field-label">备注 notes</span>
                <input
                  className="input"
                  value={editor.notes}
                  onChange={event => setEditor({ ...editor, notes: event.target.value })}
                  placeholder="为什么保密 / 谁在掩盖"
                />
              </label>
            </div>

            <div className="divider" />

            <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
              <span className="field-label">知情者 knowers</span>
              <button type="button" className="btn btn-sm" onClick={addKnower} disabled={entityList.length === 0}>添加知情者</button>
            </div>

            {editor.knowers.length === 0 ? (
              <div className="hint-box">还没有登记知情者。至少把「该知道的」和「绝对不知道的」两类角色列上，审查器才有依据。</div>
            ) : (
              <div className="stack-sm">
                {editor.knowers.map((draft, index) => (
                  <div key={`${index}-${draft.entityId}`} className="row-wrap" style={{ alignItems: 'flex-start' }}>
                    <select
                      className="select"
                      style={{ flex: '1 1 180px', width: 'auto' }}
                      value={draft.entityId}
                      onChange={event => changeKnower(index, { entityId: event.target.value })}
                    >
                      {knowerOptions(draft).map((entity: Entity) => (
                        <option key={entity.id} value={entity.id}>{entity.name}</option>
                      ))}
                      {!entityList.some(entity => entity.id === draft.entityId) && (
                        <option value={draft.entityId}>{nameOf(draft.entityId)}</option>
                      )}
                    </select>
                    <select
                      className="select"
                      style={{ flex: '0 0 116px', width: 'auto' }}
                      value={draft.state}
                      onChange={event => changeKnower(index, { state: asKnowerState(event.target.value) })}
                    >
                      {KNOWER_STATES.map(state => <option key={state.key} value={state.key}>{state.label}</option>)}
                    </select>
                    <input
                      className="input"
                      style={{ flex: '1 1 150px', width: 'auto' }}
                      value={draft.notes}
                      placeholder="备注（可选）"
                      onChange={event => changeKnower(index, { notes: event.target.value })}
                    />
                    <button type="button" className="icon-btn" title="移除" onClick={() => removeKnower(index)}>✕</button>
                  </div>
                ))}
              </div>
            )}

            {editor.id !== null && (
              <div className="tiny muted">版本 v{editor.version} · 保存会带 expectedVersion，冲突时提示并刷新。</div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
