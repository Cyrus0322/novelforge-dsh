/**
 * NovelForge 内嵌面板（DSH Web GUI 客户端插件）。
 *
 * 只依赖 React（DSH 基座提供），不引入任何额外运行时依赖。
 * 数据来自本机 NovelForge 工作台服务（默认 127.0.0.1:4319），该服务由宿主侧插件自动启动。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

const CANDIDATE_PORTS = [4319, 4320, 4321, 4322, 4323, 4324, 4325, 4326, 4327, 4328, 4329, 4330, 4331]

const C = {
  bg: 'var(--dsw-alias-bg-l1, #12151c)',
  bg2: 'var(--dsw-alias-bg-l2, #171b24)',
  bg3: 'var(--dsw-alias-bg-l3, #1d222d)',
  line: 'var(--dsw-alias-border-l1, #2a3140)',
  text: 'var(--dsw-alias-label-primary, #e9e7e1)',
  dim: 'var(--dsw-alias-label-secondary, #b3b8c4)',
  muted: 'var(--dsw-alias-label-tertiary, #858c9b)',
  accent: 'var(--dsw-alias-brand-primary, #d8a657)',
  danger: 'var(--dsw-alias-label-dangerous, #e3726a)',
  ok: 'var(--dsw-alias-label-success, #6cc08b)',
  warn: 'var(--dsw-alias-label-warning, #dfa95c)',
} as const

interface Project { id: string; title: string; genre: string; premise: string; status: string; updatedAt: string }
interface ChapterSummary {
  chapter: { id: string; chapterNo: number; title: string; status: string; updatedAt: string }
  revisionCount: number
  latest: { revisionNo: number; status: string; kind: string; words: number; createdAt: string } | null
}
interface Entity { id: string; kind: string; name: string; summary: string; attributesJson: string; status: string }
interface StoryEvent { id: string; summary: string; eventTime: string; status: string }
interface Foreshadowing { id: string; name: string; description: string; status: string }
interface SearchHit { recordId: string; recordType: string; status: string; snippet: string }
interface ChapterDetail {
  chapter: { id: string; chapterNo: number; title: string; status: string }
  latestRevision: { id: string; revisionNo: number; content: string; status: string; kind: string } | null
}

type Tab = 'chapters' | 'entities' | 'timeline' | 'foreshadowing'

// ── 数据访问 ────────────────────────────────────────────────

let cachedBase: string | null = null

async function discoverBase(): Promise<string> {
  if (cachedBase) return cachedBase
  for (const port of CANDIDATE_PORTS) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
      if (!response.ok) continue
      const payload = await response.json() as { ok?: boolean; data?: { version?: string } }
      if (payload.ok && payload.data?.version) {
        cachedBase = `http://127.0.0.1:${port}`
        return cachedBase
      }
    } catch { /* 试下一个端口 */ }
  }
  throw new Error('没有找到 NovelForge 本地服务（4319–4331）。请确认插件已加载，或在终端运行 npx novelforge studio。')
}

async function apiGet<T>(path: string): Promise<T> {
  const base = await discoverBase()
  const response = await fetch(base + path)
  const text = await response.text()
  let payload: { ok?: boolean; data?: T; error?: { message?: string } }
  try {
    payload = JSON.parse(text) as typeof payload
  } catch {
    throw new Error(`服务返回了非 JSON 内容（HTTP ${response.status}）`)
  }
  if (!response.ok || !payload.ok) throw new Error(payload.error?.message ?? `请求失败（HTTP ${response.status}）`)
  return payload.data as T
}

// ── 小组件 ──────────────────────────────────────────────────

function badge(text: string, tone: 'ok' | 'warn' | 'danger' | 'muted' | 'info' = 'muted') {
  const color = tone === 'ok' ? C.ok : tone === 'warn' ? C.warn : tone === 'danger' ? C.danger : tone === 'info' ? '#7aa7dc' : C.muted
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '0 7px', borderRadius: 999,
      border: `1px solid ${color}`, color, fontSize: 11, lineHeight: '18px', whiteSpace: 'nowrap',
    }}>{text}</span>
  )
}

function statusTone(status: string): 'ok' | 'warn' | 'danger' | 'muted' | 'info' {
  if (['finalized', 'confirmed', 'completed', 'resolved', 'passed', 'applied', 'payoff'].includes(status)) return 'ok'
  if (['failed', 'rejected', 'critical', 'cancelled'].includes(status)) return 'danger'
  if (['pending', 'awaiting_approval', 'needs_author_decision', 'revising', 'reviewing', 'open'].includes(status)) return 'warn'
  if (['planned', 'draft', 'draft_generated', 'manual_draft'].includes(status)) return 'info'
  return 'muted'
}

const STATUS_TEXT: Record<string, string> = {
  planned: '计划中', context_ready: '上下文就绪', draft_generated: '草稿', manual_draft: '人工草稿',
  revising: '修订中', reviewing: '审查中', awaiting_approval: '待定稿', needs_author_decision: '待决策',
  finalized: '已定稿', open: '未回收', reinforced: '已强化', payoff: '已回收', abandoned: '已废弃',
  confirmed: '已确认', draft: '草稿', cancelled: '已取消', active: '进行中',
}

const KIND_TEXT: Record<string, string> = {
  character: '人物', world_rule: '世界规则', location: '地点', faction: '势力', item: '物品', ability: '能力', other: '其它',
}

function text(value: string): string { return STATUS_TEXT[value] ?? value }

function Row(props: { children: ReactNode; onClick?: () => void; active?: boolean }) {
  return (
    <div
      onClick={props.onClick}
      style={{
        padding: '8px 10px', borderRadius: 8, cursor: props.onClick ? 'pointer' : 'default',
        background: props.active ? 'rgba(216,166,87,0.12)' : 'transparent',
        border: `1px solid ${props.active ? 'rgba(216,166,87,0.38)' : 'transparent'}`,
      }}
      onMouseEnter={event => { if (props.onClick && !props.active) (event.currentTarget as HTMLDivElement).style.background = C.bg3 }}
      onMouseLeave={event => { if (!props.active) (event.currentTarget as HTMLDivElement).style.background = 'transparent' }}
    >{props.children}</div>
  )
}

const btnStyle = {
  border: `1px solid ${C.line}`, background: C.bg3, color: C.text, borderRadius: 8,
  padding: '4px 10px', fontSize: 12, cursor: 'pointer', font: 'inherit',
} as const

// ── 主面板 ──────────────────────────────────────────────────

export function NovelForgePanel() {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [tab, setTab] = useState<Tab>('chapters')
  const [chapters, setChapters] = useState<ChapterSummary[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [events, setEvents] = useState<StoryEvent[]>([])
  const [foreshadowing, setForeshadowing] = useState<Foreshadowing[]>([])
  const [hits, setHits] = useState<SearchHit[]>([])
  const [query, setQuery] = useState('')
  const [reader, setReader] = useState<ChapterDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadProject = useCallback(async (id: string): Promise<void> => {
    setError(null)
    try {
      const [chapterList, entityList, eventList, shadowList] = await Promise.all([
        apiGet<ChapterSummary[]>(`/api/projects/${encodeURIComponent(id)}/chapter-summaries`),
        apiGet<Entity[]>(`/api/projects/${encodeURIComponent(id)}/entities`),
        apiGet<StoryEvent[]>(`/api/projects/${encodeURIComponent(id)}/events`),
        apiGet<Foreshadowing[]>(`/api/projects/${encodeURIComponent(id)}/foreshadowing`),
      ])
      setChapters(chapterList)
      setEntities(entityList)
      setEvents(eventList)
      setForeshadowing(shadowList)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const list = await apiGet<Project[]>('/api/projects')
      setProjects(list)
      const next = projectId && list.some(item => item.id === projectId) ? projectId : (list[0]?.id ?? '')
      setProjectId(next)
      if (next) await loadProject(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [loadProject, projectId])

  useEffect(() => { void refresh() }, []) // 只跑一次

  useEffect(() => {
    if (!query.trim() || !projectId) { setHits([]); return }
    const timer = setTimeout(() => {
      void apiGet<SearchHit[]>(`/api/projects/${encodeURIComponent(projectId)}/search?q=${encodeURIComponent(query.trim())}&limit=20`)
        .then(setHits)
        .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
    }, 250)
    return () => clearTimeout(timer)
  }, [query, projectId])

  const project = useMemo(() => projects.find(item => item.id === projectId) ?? null, [projects, projectId])
  const unrecovered = foreshadowing.filter(item => item.status === 'open' || item.status === 'reinforced').length
  const openChapter = (id: string): void => {
    void apiGet<ChapterDetail>(`/api/chapters/${encodeURIComponent(id)}`).then(setReader).catch(cause => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const openWorkbench = (): void => {
    void discoverBase().then(base => { window.open(base, '_blank', 'noopener') }).catch(cause => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  // —— 章节阅读视图 ——
  if (reader) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: `1px solid ${C.line}` }}>
          <button type="button" style={btnStyle} onClick={() => setReader(null)}>← 返回</button>
          <div style={{ fontWeight: 600 }}>第 {reader.chapter.chapterNo} 章 {reader.chapter.title}</div>
          {badge(text(reader.chapter.status), statusTone(reader.chapter.status))}
          {reader.latestRevision && badge(`v${reader.latestRevision.revisionNo} · ${reader.latestRevision.content.length} 字符`)}
          <div style={{ flex: 1 }} />
          <button type="button" style={btnStyle} onClick={openWorkbench}>完整工作台</button>
        </div>
        <div style={{ overflow: 'auto', padding: '22px 28px', lineHeight: 1.95, fontSize: 15.5, fontFamily: 'var(--dsw-alias-font-serif, "Songti SC", "Source Han Serif SC", Georgia, serif)', whiteSpace: 'pre-wrap' }}>
          {reader.latestRevision?.content ?? '这一章还没有正文。到完整工作台里写，或让模型生成草稿。'}
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text, fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: `1px solid ${C.line}` }}>
        <strong style={{ fontFamily: 'var(--dsw-alias-font-serif, "Songti SC", Georgia, serif)', letterSpacing: '0.04em' }}>NovelForge</strong>
        <select
          value={projectId}
          onChange={event => {
            const id = event.target.value
            setProjectId(id)
            setReader(null)
            void loadProject(id)
          }}
          style={{ ...btnStyle, maxWidth: 260 }}
        >
          {projects.length === 0 && <option value="">（暂无项目）</option>}
          {projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索章节、人物、事件、伏笔…"
          style={{ ...btnStyle, width: 260, fontWeight: 'normal' }}
        />
        <div style={{ flex: 1 }} />
        <span style={{ color: C.muted }}>{project ? `${project.genre} · ${chapters.length} 章 · 未回收伏笔 ${unrecovered}` : ''}</span>
        <button type="button" style={btnStyle} onClick={() => { void refresh() }}>刷新</button>
        <button type="button" style={{ ...btnStyle, borderColor: 'rgba(216,166,87,0.45)', color: C.accent }} onClick={openWorkbench}>完整工作台</button>
      </div>

      <div style={{ display: 'flex', gap: 6, padding: '8px 16px', borderBottom: `1px solid ${C.line}`, flexWrap: 'wrap' }}>
        {([['chapters', `章节 ${chapters.length}`], ['entities', `资料 ${entities.length}`], ['timeline', `时间线 ${events.length}`], ['foreshadowing', `伏笔 ${foreshadowing.length}`]] as Array<[Tab, string]>).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            style={{
              ...btnStyle,
              background: tab === key ? 'rgba(216,166,87,0.14)' : 'transparent',
              borderColor: tab === key ? 'rgba(216,166,87,0.45)' : C.line,
              color: tab === key ? C.accent : C.dim,
            }}
          >{label}</button>
        ))}
      </div>

      {error && <div style={{ margin: '10px 16px', padding: '9px 12px', border: `1px solid ${C.danger}`, borderRadius: 8, color: C.danger, whiteSpace: 'pre-wrap' }}>{error}</div>}
      {loading && <div style={{ padding: 16, color: C.muted }}>正在连接 NovelForge 本地服务…</div>}

      {!loading && !error && projects.length === 0 && (
        <div style={{ padding: 24, color: C.muted, lineHeight: 1.8 }}>
          还没有小说项目。点「完整工作台」在新窗口创建，或在对话里说「新建一本小说」。
        </div>
      )}

      {!loading && query.trim() && (
        <div style={{ overflow: 'auto', padding: '6px 10px' }}>
          <div style={{ padding: '4px 8px', color: C.muted, fontSize: 11 }}>搜索「{query.trim()}」命中 {hits.length} 条</div>
          {hits.map(hit => (
            <Row key={hit.recordId} active={false}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {badge(KIND_TEXT[hit.recordType] ?? hit.recordType, 'info')}
                {badge(text(hit.status), statusTone(hit.status))}
              </div>
              <div style={{ marginTop: 3, color: C.dim, whiteSpace: 'pre-wrap' }}>{hit.snippet.slice(0, 220)}</div>
            </Row>
          ))}
        </div>
      )}

      {!loading && !query.trim() && (
        <div style={{ overflow: 'auto', flex: 1 }}>
          {tab === 'chapters' && (
            <div style={{ padding: '6px 10px' }}>
              {chapters.length === 0 && <div style={{ padding: 16, color: C.muted }}>还没有章节。</div>}
              {chapters.map(item => (
                <Row key={item.chapter.id} onClick={() => openChapter(item.chapter.id)}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: C.muted, fontVariantNumeric: 'tabular-nums', minWidth: 32 }}>{item.chapter.chapterNo}</span>
                    <span style={{ fontFamily: 'var(--dsw-alias-font-serif, "Songti SC", Georgia, serif)' }}>{item.chapter.title}</span>
                    {badge(text(item.chapter.status), statusTone(item.chapter.status))}
                    <div style={{ flex: 1 }} />
                    <span style={{ color: C.muted, fontSize: 11 }}>{item.latest ? `${item.latest.words} 字` : '无正文'} · v{item.latest?.revisionNo ?? 0}</span>
                  </div>
                </Row>
              ))}
            </div>
          )}

          {tab === 'entities' && (
            <div style={{ padding: '6px 10px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
              {entities.length === 0 && <div style={{ padding: 16, color: C.muted }}>资料库还是空的。</div>}
              {entities.map(entity => (
                <div key={entity.id} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: '9px 11px', background: C.bg2 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <strong>{entity.name}</strong>
                    {badge(KIND_TEXT[entity.kind] ?? entity.kind, 'info')}
                    {badge(text(entity.status), statusTone(entity.status))}
                  </div>
                  <div style={{ color: C.dim, marginTop: 4, fontSize: 12 }}>{entity.summary || '（无简介）'}</div>
                </div>
              ))}
            </div>
          )}

          {tab === 'timeline' && (
            <div style={{ padding: '6px 10px' }}>
              {events.length === 0 && <div style={{ padding: 16, color: C.muted }}>还没有事件记录。</div>}
              {[...events].sort((a, b) => a.eventTime.localeCompare(b.eventTime)).map(event => (
                <Row key={event.id}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: C.muted, fontSize: 11, minWidth: 78 }}>{event.eventTime || '未定时间'}</span>
                    {badge(text(event.status), statusTone(event.status))}
                    <span style={{ color: event.status === 'confirmed' ? C.text : C.dim }}>{event.summary}</span>
                  </div>
                </Row>
              ))}
            </div>
          )}

          {tab === 'foreshadowing' && (
            <div style={{ padding: '6px 10px' }}>
              {foreshadowing.length === 0 && <div style={{ padding: 16, color: C.muted }}>还没有伏笔记录。</div>}
              {foreshadowing.map(item => (
                <Row key={item.id}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <strong style={{ fontWeight: 500 }}>{item.name}</strong>
                    {badge(text(item.status), statusTone(item.status))}
                  </div>
                  <div style={{ color: C.dim, fontSize: 12, marginTop: 2 }}>{item.description || '（无描述）'}</div>
                </Row>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function NovelForgeIcon() {
  return <span style={{ fontSize: 14, lineHeight: 1 }} aria-hidden>墨</span>
}
