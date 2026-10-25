import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PageProps } from '../app/types.ts'
import { api, ApiError } from '../lib/api.ts'
import { toast, useResource } from '../lib/hooks.ts'
import { formatTime, label, prettyJson, relativeTime, safeJson, truncate } from '../lib/format.ts'
import {
  Badge, Card, Empty, ErrorBox, Kv, Loading, Modal, SectionTitle, Stat, StatusBadge, Tabs,
} from '../components/ui.tsx'
import type { Chapter, Entity } from '../lib/types.ts'

const ENTITY_KINDS: readonly string[] = ['character', 'world_rule', 'location', 'faction', 'item', 'ability', 'other']
const ENTITY_STATUSES: readonly string[] = ['planned', 'draft', 'confirmed', 'cancelled', 'active']
const CHARACTER_ROLES: readonly string[] = ['主角', '反派', '配角', '导师', '路人']
const IMPORTANCE_VALUES: readonly number[] = [1, 2, 3, 4, 5]

const PRE_STYLE: CSSProperties = {
  margin: 0,
  padding: '9px 11px',
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--bg-soft)',
  maxHeight: 220,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontFamily: 'var(--mono)',
  fontSize: 11.5,
  lineHeight: 1.6,
  color: 'var(--text-dim)',
}

const SCROLL_STYLE: CSSProperties = { maxHeight: '68vh', overflowY: 'auto', paddingRight: 4 }

interface EntityEditor {
  mode: 'create' | 'edit'
  id: string | null
  kind: string
  name: string
  summary: string
  status: string
  attributesText: string
  version: number
  role: string
  goal: string
  motivation: string
  flaw: string
  secret: string
  voice: string
  arc: string
  aliasesText: string
  importance: number
  firstAppearanceChapterId: string
}

type AttributesResult = { ok: true; value: Record<string, unknown> } | { ok: false; message: string }

function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'CONFLICT' || error.message.includes('版本已变化'))
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value) ?? String(value)
}

function attributeEntries(json: string): Array<{ key: string; text: string }> {
  const parsed = safeJson<unknown>(json, {})
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
  return Object.entries(parsed as Record<string, unknown>).map(([key, value]) => ({ key, text: describeValue(value) }))
}

function parseAttributesText(text: string): AttributesResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    return { ok: false, message: `属性 JSON 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: '属性必须是 JSON 对象，例如 {"年龄": 27}；数组与标量都不行。' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

function aliasesFromJson(json: string): string[] {
  const parsed = safeJson<unknown>(json, [])
  if (!Array.isArray(parsed)) return []
  return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function aliasesToJsonText(json: string): string {
  return aliasesFromJson(json).join('，')
}

function parseAliasesText(text: string): string[] {
  return text
    .split(/[,，、]/)
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 8)
}

function chapterText(chapterId: string | null, chapters: Chapter[]): string {
  if (!chapterId) return '—'
  const chapter = chapters.find(item => item.id === chapterId)
  return chapter ? `第 ${chapter.chapterNo} 章 · ${truncate(chapter.title, 18)}` : truncate(chapterId, 20)
}

function depthSummary(entity: Entity): string {
  const parts = [entity.goal, entity.motivation, entity.flaw, entity.voice].filter(part => part.trim().length > 0)
  return parts.length ? truncate(parts[0] ?? '', 60) : ''
}

export function EntitiesPage({ projectId, navigate }: PageProps) {
  const entities = useResource(() => api.listEntities(projectId), [projectId])
  const chapters = useResource(() => api.listChapters(projectId), [projectId])
  const relations = useResource(() => api.listRelations(projectId), [projectId])
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState('')
  const [editor, setEditor] = useState<EntityEditor | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [detail, setDetail] = useState<Entity | null>(null)
  const [snapshotChapterId, setSnapshotChapterId] = useState('')

  const kindOptions = useMemo<string[]>(() => {
    const used = (entities.data ?? []).map(entity => entity.kind)
    const extras = [...new Set(used)].filter(kind => !ENTITY_KINDS.includes(kind)).sort((left, right) => left.localeCompare(right))
    return [...ENTITY_KINDS, ...extras]
  }, [entities.data])

  const tabItems = useMemo(() => {
    const list = entities.data ?? []
    const counts = new Map<string, number>()
    for (const entity of list) counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1)
    return [
      { key: 'all', label: '全部', count: list.length },
      ...kindOptions.map(kind => ({ key: kind, label: label(kind), count: counts.get(kind) ?? 0 })),
    ]
  }, [entities.data, kindOptions])

  const visible = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase()
    return (entities.data ?? []).filter(entity => {
      if (tab !== 'all' && entity.kind !== tab) return false
      if (!keyword) return true
      const aliases = aliasesFromJson(entity.aliasesJson).join(' ')
      const depth = `${entity.role}\n${entity.goal}\n${entity.motivation}\n${entity.flaw}\n${entity.secret}\n${entity.voice}\n${entity.arc}`
      return `${entity.name}\n${entity.summary}\n${entity.attributesJson}\n${aliases}\n${depth}`.toLocaleLowerCase().includes(keyword)
    })
  }, [entities.data, tab, search])

  const stats = useMemo(() => {
    const list = entities.data ?? []
    return {
      total: list.length,
      characters: list.filter(entity => entity.kind === 'character').length,
      confirmed: list.filter(entity => entity.status === 'confirmed').length,
      planned: list.filter(entity => entity.status === 'planned' || entity.status === 'draft').length,
      other: list.filter(entity => entity.status !== 'confirmed' && entity.status !== 'planned' && entity.status !== 'draft').length,
    }
  }, [entities.data])

  const chapterList = chapters.data ?? []
  const relationList = relations.data ?? []
  const detailRelations = detail
    ? relationList.filter(relation => relation.sourceId === detail.id || relation.targetId === detail.id)
    : []

  // 切换项目时关闭弹窗，避免展示上一个项目的实体。
  useEffect(() => {
    setEditor(null)
    setDetail(null)
    setEditorError(null)
  }, [projectId])

  function closeEditor(): void {
    if (saving) return
    setEditor(null)
    setEditorError(null)
  }

  function openCreate(): void {
    const preferred = tab !== 'all' && kindOptions.includes(tab) ? tab : 'character'
    setEditorError(null)
    setEditor({
      mode: 'create',
      id: null,
      kind: preferred,
      name: '',
      summary: '',
      status: 'confirmed',
      attributesText: '{}',
      version: 0,
      role: '',
      goal: '',
      motivation: '',
      flaw: '',
      secret: '',
      voice: '',
      arc: '',
      aliasesText: '',
      importance: 3,
      firstAppearanceChapterId: '',
    })
  }

  function openEdit(entity: Entity): void {
    setEditorError(null)
    setEditor({
      mode: 'edit',
      id: entity.id,
      kind: entity.kind,
      name: entity.name,
      summary: entity.summary,
      status: entity.status,
      attributesText: prettyJson(entity.attributesJson),
      version: entity.version,
      role: entity.role,
      goal: entity.goal,
      motivation: entity.motivation,
      flaw: entity.flaw,
      secret: entity.secret,
      voice: entity.voice,
      arc: entity.arc,
      aliasesText: aliasesToJsonText(entity.aliasesJson),
      importance: entity.importance,
      firstAppearanceChapterId: entity.firstAppearanceChapterId ?? '',
    })
  }

  function openDetail(entity: Entity): void {
    setDetail(entity)
    setSnapshotChapterId(entity.firstAppearanceChapterId ?? '')
  }

  async function submit(): Promise<void> {
    if (!editor) return
    const name = editor.name.trim()
    if (!name) {
      setEditorError('名称不能为空。')
      return
    }
    const attributes = parseAttributesText(editor.attributesText)
    if (!attributes.ok) {
      setEditorError(attributes.message)
      return
    }
    const importance = editor.importance >= 1 && editor.importance <= 5 ? editor.importance : 3
    const depthInput = {
      role: editor.role.trim(),
      goal: editor.goal.trim(),
      motivation: editor.motivation.trim(),
      flaw: editor.flaw.trim(),
      secret: editor.secret.trim(),
      voice: editor.voice.trim(),
      arc: editor.arc.trim(),
      aliases: parseAliasesText(editor.aliasesText),
      firstAppearanceChapterId: editor.firstAppearanceChapterId || null,
      importance,
    }
    setSaving(true)
    setEditorError(null)
    try {
      if (editor.mode === 'create') {
        await api.createEntity(projectId, {
          kind: editor.kind,
          name,
          summary: editor.summary,
          attributes: attributes.value,
          status: editor.status,
          ...depthInput,
        })
      } else if (editor.id) {
        await api.updateEntity(editor.id, {
          name,
          summary: editor.summary,
          attributes: attributes.value,
          status: editor.status,
          ...depthInput,
          expectedVersion: editor.version,
        })
      }
      toast.ok('已保存')
      setEditor(null)
      entities.reload()
    } catch (error) {
      if (isVersionConflict(error)) {
        toast.error('资料已被其它窗口修改，已刷新')
        setEditor(null)
        entities.reload()
      } else {
        const message = error instanceof Error ? error.message : String(error)
        setEditorError(message)
        toast.error(message)
      }
    } finally {
      setSaving(false)
    }
  }

  if (entities.loading && !entities.data) return <Loading text="正在载入人物与世界观…" />
  if (entities.error) return <ErrorBox error={entities.error} onRetry={entities.reload} />

  const total = entities.data?.length ?? 0

  return (
    <div className="stack">
      <div className="notice">
        只有 <strong>confirmed（已确认）</strong> 的条目才是正式事实，会被组装进写作上下文；planned / draft 只是计划或草稿，cancelled 表示已作废。
        人物卡片的定位、目标、动机、缺陷、秘密、说话方式、弧光、别名会一起进入上下文；素材导入会自动抽取这些字段。
      </div>

      <div className="stat-grid">
        <Stat label="条目总数" value={stats.total} hint={`${stats.characters} 位人物 · ${kindOptions.length} 个分类`} />
        <Stat label="已确认（正式事实）" value={stats.confirmed} tone="ok" hint="进入写作上下文" />
        <Stat label="计划 / 草稿" value={stats.planned} tone="warn" hint="尚未成为事实" />
        <Stat label="其它状态" value={stats.other} hint="已取消 / 进行中等" />
      </div>

      <SectionTitle
        title="人物与世界观"
        hint={`${visible.length} / ${total} 条`}
        actions={(
          <>
            <input
              className="input input-sm"
              style={{ width: 210 }}
              placeholder="搜索名称 / 目标 / 别名 / 属性…"
              value={search}
              onChange={event => setSearch(event.target.value)}
            />
            <button type="button" className="btn btn-primary btn-sm" onClick={openCreate}>+ 新建实体</button>
          </>
        )}
      />

      <Tabs items={tabItems} value={tab} onChange={setTab} />

      {total === 0 ? (
        <Empty
          title="资料库还是空的"
          hint="新建人物、地点、势力、物品等条目。只有状态为 confirmed 的条目才会作为正式事实进入写作上下文。"
          action={<button type="button" className="btn btn-primary btn-sm" onClick={openCreate}>+ 新建实体</button>}
        />
      ) : visible.length === 0 ? (
        <Empty
          title="没有匹配的条目"
          hint="当前分类与搜索词下没有结果；可以切换上方标签，或清空搜索词。"
          action={(
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => { setSearch(''); setTab('all') }}
            >
              清空筛选
            </button>
          )}
        />
      ) : (
        <div className="grid-3">
          {visible.map(entity => {
            const entries = attributeEntries(entity.attributesJson)
            const aliases = aliasesFromJson(entity.aliasesJson)
            const relatedCount = relationList.filter(relation => relation.sourceId === entity.id || relation.targetId === entity.id).length
            const isCharacter = entity.kind === 'character'
            const depthLine = depthSummary(entity)
            const firstChapter = entity.firstAppearanceChapterId
              ? chapterList.find(chapter => chapter.id === entity.firstAppearanceChapterId)
              : undefined
            return (
              <Card
                key={entity.id}
                tight
                title={<span title={entity.name}>{truncate(entity.name, 26)}</span>}
                subtitle={`${label(entity.kind)} · 更新于 ${relativeTime(entity.updatedAt)}`}
                actions={<StatusBadge status={entity.status} />}
              >
                <div className="row-wrap" style={{ gap: 5, marginBottom: 6 }}>
                  {isCharacter && entity.role ? <Badge tone="accent">{entity.role}</Badge> : null}
                  {isCharacter && <Badge tone="muted">重要性 {entity.importance}/5</Badge>}
                  {relatedCount > 0 && <Badge tone="info">关系 {relatedCount}</Badge>}
                  {firstChapter && <Badge tone="muted">首登 第 {firstChapter.chapterNo} 章</Badge>}
                </div>

                <div className="small dim" style={{ minHeight: 40, whiteSpace: 'pre-wrap' }}>
                  {entity.summary.trim() ? truncate(entity.summary, 140) : '（暂无简介）'}
                </div>

                {isCharacter && (
                  <div className="tiny muted" style={{ marginTop: 6 }}>
                    目标：{entity.goal.trim() ? truncate(entity.goal, 70) : '—'}
                  </div>
                )}
                {isCharacter && !entity.goal.trim() && depthLine && (
                  <div className="tiny muted" style={{ marginTop: 4 }}>档案：{depthLine}</div>
                )}
                {aliases.length > 0 && (
                  <div className="tiny muted" style={{ marginTop: 4 }}>
                    别名：{aliases.slice(0, 4).map(alias => truncate(alias, 8)).join('、')}
                    {aliases.length > 4 ? ` +${aliases.length - 4}` : ''}
                  </div>
                )}

                <div className="row-wrap" style={{ marginTop: 8, gap: 5 }}>
                  {entries.length === 0 ? (
                    <span className="tiny muted">无属性</span>
                  ) : (
                    <>
                      {entries.slice(0, 4).map(entry => (
                        <span key={entry.key} className="badge badge-muted" title={`${entry.key}：${entry.text}`}>
                          {truncate(entry.key, 12)}：{truncate(entry.text, 16)}
                        </span>
                      ))}
                      {entries.length > 4 && <span className="tiny muted">+{entries.length - 4}</span>}
                    </>
                  )}
                </div>

                <div className="btn-row" style={{ marginTop: 10 }}>
                  <button type="button" className="btn btn-sm" onClick={() => openDetail(entity)}>详情</button>
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => openEdit(entity)}>编辑</button>
                  <Badge tone="muted">v{entity.version}</Badge>
                  {entity.sourceChapterId && (
                    <span className="tiny muted" title={entity.sourceChapterId}>来源正文</span>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}

      <Modal
        open={editor !== null}
        wide
        title={editor?.mode === 'create' ? '新建实体' : `编辑实体：${editor?.name ?? ''}`}
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
          <div className="stack-sm" style={SCROLL_STYLE}>
            {editorError && <div className="error-box">{editorError}</div>}
            <div className="grid-2">
              <label className="field">
                <span className="field-label">类型 kind</span>
                {editor.mode === 'create' ? (
                  <select
                    className="select"
                    value={editor.kind}
                    onChange={event => setEditor({ ...editor, kind: event.target.value })}
                  >
                    {kindOptions.map(kind => <option key={kind} value={kind}>{label(kind)}</option>)}
                  </select>
                ) : (
                  <div className="row-wrap">
                    <Badge tone="muted">{label(editor.kind)}</Badge>
                    <span className="tiny muted">类型不可在此修改</span>
                  </div>
                )}
              </label>
              <label className="field">
                <span className="field-label">状态 status</span>
                <select
                  className="select"
                  value={editor.status}
                  onChange={event => setEditor({ ...editor, status: event.target.value })}
                >
                  {!ENTITY_STATUSES.includes(editor.status) && <option value={editor.status}>{label(editor.status)}</option>}
                  {ENTITY_STATUSES.map(status => <option key={status} value={status}>{label(status)}</option>)}
                </select>
                <span className="field-hint">confirmed = 正式事实；planned / draft / cancelled 不进入上下文。</span>
              </label>
            </div>

            <div className="grid-2">
              <label className="field">
                <span className="field-label">名称 name</span>
                <input className="input" value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">定位 role</span>
                <select
                  className="select"
                  value={editor.role}
                  onChange={event => setEditor({ ...editor, role: event.target.value })}
                >
                  <option value="">（未设定）</option>
                  {editor.role && !CHARACTER_ROLES.includes(editor.role) && <option value={editor.role}>{editor.role}</option>}
                  {CHARACTER_ROLES.map(role => <option key={role} value={role}>{role}</option>)}
                </select>
                <span className="field-hint">主角 / 反派 / 配角 / 导师 / 路人，决定人物在故事里的功能。</span>
              </label>
            </div>

            <div className="grid-2">
              <label className="field">
                <span className="field-label">重要性 importance</span>
                <select
                  className="select"
                  value={String(editor.importance)}
                  onChange={event => setEditor({ ...editor, importance: Number(event.target.value) })}
                >
                  {IMPORTANCE_VALUES.map(value => (
                    <option key={value} value={value}>{value} · {value >= 5 ? '核心' : value >= 3 ? '常规' : '背景'}</option>
                  ))}
                </select>
                <span className="field-hint">1 = 背景板，3 = 常规角色，5 = 核心。</span>
              </label>
              <label className="field">
                <span className="field-label">首次登场章节 firstAppearance</span>
                <select
                  className="select"
                  value={editor.firstAppearanceChapterId}
                  onChange={event => setEditor({ ...editor, firstAppearanceChapterId: event.target.value })}
                >
                  <option value="">未指定</option>
                  {chapterList.map(chapter => (
                    <option key={chapter.id} value={chapter.id}>第 {chapter.chapterNo} 章 · {chapter.title}</option>
                  ))}
                </select>
                <span className="field-hint">
                  首次登场章节，用于上下文裁剪。
                  {chapters.error ? `章节列表载入失败：${chapters.error.message}` : ''}
                </span>
              </label>
            </div>

            <label className="field">
              <span className="field-label">简介 summary</span>
              <textarea
                className="textarea"
                rows={3}
                value={editor.summary}
                onChange={event => setEditor({ ...editor, summary: event.target.value })}
              />
            </label>

            <div className="divider" />
            <div className="small muted">
              人物深度档案 <span className="tiny">（人物卡必填；世界观/地点可留空。这些字段和关系、剧情线一起进入写作上下文）</span>
            </div>

            <div className="grid-2">
              <label className="field">
                <span className="field-label">目标 goal</span>
                <textarea
                  className="textarea"
                  rows={2}
                  value={editor.goal}
                  placeholder="他这一阶段想拿到什么？"
                  onChange={event => setEditor({ ...editor, goal: event.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">动机 motivation</span>
                <textarea
                  className="textarea"
                  rows={2}
                  value={editor.motivation}
                  placeholder="为什么非做不可？"
                  onChange={event => setEditor({ ...editor, motivation: event.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">缺陷 / 创伤 flaw</span>
                <textarea
                  className="textarea"
                  rows={2}
                  value={editor.flaw}
                  placeholder="会让他做错选择的东西。"
                  onChange={event => setEditor({ ...editor, flaw: event.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">秘密 secret</span>
                <textarea
                  className="textarea"
                  rows={2}
                  value={editor.secret}
                  placeholder="读者/其他角色还不知道的信息。"
                  onChange={event => setEditor({ ...editor, secret: event.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">说话方式 voice</span>
                <textarea
                  className="textarea"
                  rows={2}
                  value={editor.voice}
                  placeholder="口头禅、句长、语气。"
                  onChange={event => setEditor({ ...editor, voice: event.target.value })}
                />
              </label>
              <label className="field">
                <span className="field-label">人物弧光 arc</span>
                <textarea
                  className="textarea"
                  rows={2}
                  value={editor.arc}
                  placeholder="从什么状态变到什么状态？"
                  onChange={event => setEditor({ ...editor, arc: event.target.value })}
                />
              </label>
            </div>

            <label className="field">
              <span className="field-label">别名 aliases</span>
              <input
                className="input"
                value={editor.aliasesText}
                placeholder="例如：小渊，林队，灾星"
                onChange={event => setEditor({ ...editor, aliasesText: event.target.value })}
              />
              <span className="field-hint">用中文逗号、英文逗号或顿号分隔，最多 8 个；保存时自动转成数组。</span>
            </label>

            <label className="field">
              <span className="field-label">属性 attributes（JSON 对象）</span>
              <textarea
                className="textarea mono"
                rows={6}
                spellCheck={false}
                value={editor.attributesText}
                onChange={event => setEditor({ ...editor, attributesText: event.target.value })}
              />
              <span className="field-hint">
                必须是 JSON 对象，例如 {'{"年龄": 27}'}；留空保存为 {'{}'}。保存前会校验格式。
              </span>
            </label>

            {editor.mode === 'edit' && (
              <div className="tiny muted">
                版本 v{editor.version}{editor.id ? ` · id ${editor.id.slice(0, 8)}` : ''} · 保存会带 expectedVersion，避免覆盖其它窗口的修改。
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        open={detail !== null}
        wide
        title={detail ? `实体详情：${detail.name}` : '实体详情'}
        onClose={() => setDetail(null)}
        footer={detail ? (
          <>
            <button type="button" className="btn" onClick={() => setDetail(null)}>关闭</button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => { const target = detail; setDetail(null); openEdit(target) }}
            >
              编辑实体
            </button>
          </>
        ) : undefined}
      >
        {detail && (
          <div className="stack-sm" style={SCROLL_STYLE}>
            <div className="row-wrap" style={{ gap: 6 }}>
              <Badge tone="muted">{label(detail.kind)}</Badge>
              <StatusBadge status={detail.status} />
              {detail.role && <Badge tone="accent">{detail.role}</Badge>}
              <Badge tone="muted">重要性 {detail.importance}/5</Badge>
              <Badge tone="muted">v{detail.version}</Badge>
              <span className="tiny muted">更新于 {formatTime(detail.updatedAt)}</span>
            </div>

            <Kv rows={[
              { key: '首次登场', value: chapterText(detail.firstAppearanceChapterId, chapterList) },
              { key: '别名', value: aliasesFromJson(detail.aliasesJson).join('、') || '—' },
              { key: '来源章节', value: chapterText(detail.sourceChapterId, chapterList) },
              { key: '创建时间', value: formatTime(detail.createdAt) },
            ]} />

            <div className="small dim" style={{ whiteSpace: 'pre-wrap' }}>
              {detail.summary.trim() || '（暂无简介）'}
            </div>

            <div className="divider" />
            <div className="small muted">人物深度档案</div>
            {[detail.goal, detail.motivation, detail.flaw, detail.secret, detail.voice, detail.arc].every(value => !value.trim()) ? (
              <div className="hint-box">
                还没有人物深度档案。可以点「编辑实体」补目标 / 动机 / 缺陷 / 秘密 / 说话方式 / 弧光，或去
                <button type="button" className="row-btn" style={{ color: 'var(--accent)' }} onClick={() => navigate(`/p/${encodeURIComponent(projectId)}/ingest`)}> 素材导入 </button>
                让 AI 抽取。
              </div>
            ) : (
              <Kv rows={[
                ...(detail.goal.trim() ? [{ key: '目标', value: detail.goal }] : []),
                ...(detail.motivation.trim() ? [{ key: '动机', value: detail.motivation }] : []),
                ...(detail.flaw.trim() ? [{ key: '缺陷', value: detail.flaw }] : []),
                ...(detail.secret.trim() ? [{ key: '秘密', value: detail.secret }] : []),
                ...(detail.voice.trim() ? [{ key: '说话方式', value: detail.voice }] : []),
                ...(detail.arc.trim() ? [{ key: '弧光', value: detail.arc }] : []),
              ]} />
            )}

            <div className="divider" />
            <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
              <span className="small muted">人物关系（{detailRelations.length}）</span>
              <button type="button" className="btn btn-sm btn-ghost" disabled={relations.loading} onClick={relations.reload}>刷新</button>
            </div>
            {relations.error ? (
              <ErrorBox error={relations.error} onRetry={relations.reload} />
            ) : relations.loading && !relations.data ? (
              <Loading text="正在载入人物关系…" />
            ) : detailRelations.length === 0 ? (
              <div className="hint-box">
                还没有和该条目相关的关系记录。关系可由素材导入自动抽取（源 → 目标 + 类型 + 张力）。
              </div>
            ) : (
              <div className="list">
                {detailRelations.map(relation => {
                  const outgoing = relation.sourceId === detail.id
                  const otherName = outgoing ? relation.targetName : relation.sourceName
                  return (
                    <div key={relation.id} className="list-item" style={{ cursor: 'default' }}>
                      <div className="list-item-main">
                        <div className="list-item-title">
                          <span className="small">{outgoing ? '→' : '←'} {truncate(otherName, 20)}</span>
                          <Badge tone="info">{relation.kind || '关系'}</Badge>
                          <StatusBadge status={relation.status} />
                        </div>
                        <div className="list-item-meta">
                          {relation.tension.trim() ? `张力：${truncate(relation.tension, 100)}` : '（没写张力）'}
                          {relation.notes.trim() ? ` · ${truncate(relation.notes, 80)}` : ''}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            <div className="divider" />
            <div className="small muted">关键属性</div>
            <div className="row-wrap" style={{ gap: 5 }}>
              {attributeEntries(detail.attributesJson).length === 0 ? (
                <span className="tiny muted">无属性</span>
              ) : (
                attributeEntries(detail.attributesJson).slice(0, 12).map(entry => (
                  <span key={entry.key} className="badge badge-muted" title={`${entry.key}：${entry.text}`}>
                    {truncate(entry.key, 14)}：{truncate(entry.text, 24)}
                  </span>
                ))
              )}
            </div>
            <details>
              <summary className="tiny muted" style={{ cursor: 'pointer' }}>属性原始 JSON</summary>
              <pre style={PRE_STYLE}>{prettyJson(detail.attributesJson)}</pre>
            </details>

            <div className="divider" />
            <div className="small muted">状态快照 / 章节入口</div>
            <div className="grid-2">
              <label className="field">
                <span className="field-label">选择章节</span>
                <select
                  className="select"
                  value={snapshotChapterId}
                  onChange={event => setSnapshotChapterId(event.target.value)}
                  disabled={chapterList.length === 0}
                >
                  <option value="">选择章节…</option>
                  {chapterList.map(chapter => (
                    <option key={chapter.id} value={chapter.id}>第 {chapter.chapterNo} 章 · {chapter.title}</option>
                  ))}
                </select>
                <span className="field-hint">
                  {chapters.error
                    ? `章节列表载入失败：${chapters.error.message}`
                    : '选一个章节可直接打开工作台，按正文核对人物状态；按章节的历史快照将在后续版本提供。'}
                </span>
              </label>
              <div className="field">
                <span className="field-label">&nbsp;</span>
                <button
                  type="button"
                  className="btn"
                  disabled={!snapshotChapterId}
                  onClick={() => navigate(`/p/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(snapshotChapterId)}`)}
                >
                  打开该章节工作台
                </button>
                <span className="field-hint">打开后可在正文里核对人物状态与时间线。</span>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
