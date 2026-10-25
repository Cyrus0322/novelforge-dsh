import { useMemo, useState } from 'react'
import type { PageProps } from '../app/types.ts'
import { api, ApiError } from '../lib/api.ts'
import { toast, useResource } from '../lib/hooks.ts'
import { label, prettyJson, relativeTime, safeJson, truncate } from '../lib/format.ts'
import {
  Badge, Card, Empty, ErrorBox, Loading, Modal, SectionTitle, Stat, StatusBadge, Tabs,
} from '../components/ui.tsx'
import type { Entity } from '../lib/types.ts'

const ENTITY_KINDS: readonly string[] = ['character', 'world_rule', 'location', 'faction', 'item', 'ability', 'other']
const ENTITY_STATUSES: readonly string[] = ['planned', 'draft', 'confirmed', 'cancelled', 'active']

interface EntityEditor {
  mode: 'create' | 'edit'
  id: string | null
  kind: string
  name: string
  summary: string
  status: string
  attributesText: string
  version: number
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

export function EntitiesPage({ projectId }: PageProps) {
  const entities = useResource(() => api.listEntities(projectId), [projectId])
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState('')
  const [editor, setEditor] = useState<EntityEditor | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

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
      return `${entity.name}\n${entity.summary}\n${entity.attributesJson}`.toLocaleLowerCase().includes(keyword)
    })
  }, [entities.data, tab, search])

  const stats = useMemo(() => {
    const list = entities.data ?? []
    return {
      total: list.length,
      confirmed: list.filter(entity => entity.status === 'confirmed').length,
      planned: list.filter(entity => entity.status === 'planned' || entity.status === 'draft').length,
      other: list.filter(entity => entity.status !== 'confirmed' && entity.status !== 'planned' && entity.status !== 'draft').length,
    }
  }, [entities.data])

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
    })
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
        })
      } else if (editor.id) {
        await api.updateEntity(editor.id, {
          name,
          summary: editor.summary,
          attributes: attributes.value,
          status: editor.status,
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
        只有 <strong>confirmed（已确认）</strong> 的条目才是正式事实，会被组装进写作上下文；planned / draft 只是计划或草稿，cancelled 表示已作废。状态可在编辑弹窗里修改。
      </div>

      <div className="stat-grid">
        <Stat label="条目总数" value={stats.total} hint={`${kindOptions.length} 个分类`} />
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
              placeholder="搜索名称 / 简介 / 属性…"
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
            return (
              <Card
                key={entity.id}
                tight
                title={<span title={entity.name}>{truncate(entity.name, 26)}</span>}
                subtitle={`${label(entity.kind)} · 更新于 ${relativeTime(entity.updatedAt)}`}
                actions={<StatusBadge status={entity.status} />}
              >
                <div className="small dim" style={{ minHeight: 40, whiteSpace: 'pre-wrap' }}>
                  {entity.summary.trim() ? truncate(entity.summary, 140) : '（暂无简介）'}
                </div>

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
                  <button type="button" className="btn btn-sm" onClick={() => openEdit(entity)}>编辑</button>
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
          <div className="stack-sm">
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

            <label className="field">
              <span className="field-label">名称 name</span>
              <input className="input" value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })} />
            </label>

            <label className="field">
              <span className="field-label">简介 summary</span>
              <textarea
                className="textarea"
                rows={3}
                value={editor.summary}
                onChange={event => setEditor({ ...editor, summary: event.target.value })}
              />
            </label>

            <label className="field">
              <span className="field-label">属性 attributes（JSON 对象）</span>
              <textarea
                className="textarea mono"
                rows={9}
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
    </div>
  )
}
