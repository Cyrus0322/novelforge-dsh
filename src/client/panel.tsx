/**
 * NovelForge 内嵌面板（DSH Web GUI 客户端插件）。
 *
 * 完整可操作工作台：素材导入、审批变更、编辑人物/剧情线/关系/场景、写正文与定稿。
 * 只依赖 React（DSH 基座提供），运行时不需要浏览器另开页面。
 * 数据来自宿主插件自动启动的本地服务（默认 127.0.0.1:4319）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

const CANDIDATE_PORTS = Array.from({ length: 13 }, (_, index) => 4319 + index)
const RETRY_DELAYS = [300, 600, 900, 1500, 2000, 3000]

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
  info: 'var(--dsw-alias-label-info, #7aa7dc)',
} as const

// ── 类型 ────────────────────────────────────────────────────
interface Project {
  id: string; title: string; genre: string; premise: string; styleGuide: string
  pov: string; tense: string; status: string; themesJson: string
  chapterWordsMin: number; chapterWordsMax: number; targetChapters: number; version: number
}
interface OverviewCounts {
  chapters: number; finalizedChapters: number; entities: number; foreshadowingOpen: number
  threads: number; relations: number; scenes: number; openIssues: number; pendingProposals: number
  ingestBatches: number; overdueForeshadowing: number
}
interface ProjectOverview { project: Project; counts: OverviewCounts }
interface ChapterSummary {
  chapter: { id: string; chapterNo: number; title: string; status: string; updatedAt: string; summary?: string }
  revisionCount: number
  latest: { id: string; revisionNo: number; status: string; kind: string; words: number; createdAt: string } | null
}
interface Entity {
  id: string; kind: string; name: string; summary: string; status: string
  role: string; goal: string; motivation: string; flaw: string; secret: string; voice: string; arc: string
  importance: number; aliasesJson: string; version: number
}
interface StoryEvent { id: string; summary: string; eventTime: string; status: string }
interface Foreshadowing {
  id: string; name: string; description: string; status: string; kind: string
  importance: number; notes: string; deadlineChapterId: number | null; version: number
  plantChapterId: string | null; payoffChapterId: string | null
}
interface PlotThread { id: string; name: string; kind: string; goal: string; summary: string; status: string; version: number }
interface Relation { id: string; sourceName: string; targetName: string; kind: string; tension: string; status: string; version: number }
interface Scene {
  id: string; sceneNo: number; beat: string; goal: string; conflict: string; outcome: string
  castNames: string[]; status: string; version: number
}
interface SearchHit { recordId: string; recordType: string; status: string; snippet: string }
interface ChapterDetail {
  chapter: { id: string; chapterNo: number; title: string; status: string; summary: string }
  outline: { id: string; title: string; content: string; version: number } | null
  latestRevision: { id: string; revisionNo: number; content: string; status: string; kind: string } | null
  latestReview: { run: { status: string }; issues: Array<{ id: string; severity: string; issue: string; resolutionStatus?: string }> } | null
}

interface KnowerEntry { entityId: string; state: 'knows' | 'suspects' | 'misbelieves' | 'unaware'; sinceChapterId?: string | null; notes?: string }
interface KnowledgeFact {
  id: string; proposition: string; truth: string; publicLevel: string
  chapterId: string | null; chapterNo: number | null; notes: string; version: number; updatedAt: string
  knowers: Array<KnowerEntry & { name: string }>
}
interface EntityState {
  id: string; characterId: string; chapterId: string | null; summary: string; stateJson: string; createdAt: string
}
interface Proposal {
  id: string; targetType: string; operation: string; status: string; payloadJson: string
  targetId: string | null; source: string; createdAt: string
}
interface IngestBatch {
  id: string; title: string; mode: string; status: string; statsJson: string; createdAt: string; sourceText: string
}
interface IngestOutcome {
  batch: IngestBatch
  stats: { entities: number; relations: number; events: number; foreshadowing: number; threads: number; knowledge: number; dropped: number; conflicts: number; droppedReasons: Record<string, number>; conflictList?: Array<{ type: string; description: string; evidence?: string }>; truncated?: boolean }
  proposals: Proposal[]
}

type Tab = 'chapters' | 'entities' | 'threads' | 'relations' | 'timeline' | 'foreshadowing' | 'knowledge' | 'ingest' | 'proposals'

// ── 数据访问 ─────────────────────────────────────────────────
let cachedBase: string | null = null

async function probe(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
    if (!response.ok) return null
    const payload = await response.json() as { ok?: boolean; data?: { version?: string } }
    return payload.ok && payload.data?.version ? `http://127.0.0.1:${port}` : null
  } catch {
    return null
  }
}

async function discoverBase(force = false): Promise<string> {
  if (cachedBase && !force) return cachedBase
  for (let round = 0; round < RETRY_DELAYS.length; round += 1) {
    for (const port of CANDIDATE_PORTS) {
      const base = await probe(port)
      if (base) { cachedBase = base; return base }
    }
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[round]))
  }
  cachedBase = null
  throw new Error('连不上 NovelForge 本地服务（端口 4319–4331）。\n· 确认插件已启用：设置 → 插件 → novelforge-dsh\n· 或手动启动：npx novelforge-dsh studio')
}

async function apiCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const base = await discoverBase()
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
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
const apiGet = <T,>(path: string) => apiCall<T>('GET', path)

// ── 小件 ────────────────────────────────────────────────────
const STATUS_TEXT: Record<string, string> = {
  planned: '计划中', context_ready: '上下文就绪', draft_generated: '草稿', manual_draft: '人工草稿',
  revising: '修订中', reviewing: '审查中', awaiting_approval: '待定稿', needs_author_decision: '待决策',
  finalized: '已定稿', open: '未回收', reinforced: '已强化', payoff: '已回收', abandoned: '已废弃',
  confirmed: '已确认', draft: '草稿', cancelled: '已取消', active: '进行中', paused: '已暂停',
  resolved: '已解决', pending: '待审批', applied: '已应用', rejected: '已驳回', ready: '待应用',
  advancing: '推进中', closed: '已结束',
  knows: '知道', suspects: '怀疑', misbelieves: '误信', unaware: '不知道',
  true: '属实', false: '假消息', partial: '部分属实',
  secret: '秘密', circle: '小圈', organization: '组织', public: '公开',
  partially_applied: '部分应用', applied_batch: '已应用', failed: '失败', analyzing: '分析中', applying: '应用中',
}
const KIND_TEXT: Record<string, string> = {
  character: '人物', world_rule: '规则', location: '地点', faction: '势力', item: '物品', ability: '能力', other: '其它',
}
const THREAD_TEXT: Record<string, string> = {
  main: '主线', sub: '支线', romance: '感情', mystery: '悬疑', revenge: '复仇', growth: '成长',
}
const TARGET_TEXT: Record<string, string> = { entity: '资料', event: '事件', foreshadowing: '伏笔', relation: '关系', thread: '剧情线', knowledge: '知情' }

function text(value: string): string { return STATUS_TEXT[value] ?? value }
function toneOf(status: string): string {
  if (['finalized', 'confirmed', 'resolved', 'payoff', 'active', 'applied', 'applied_batch'].includes(status)) return C.ok
  if (['failed', 'rejected', 'critical', 'cancelled'].includes(status)) return C.danger
  if (['pending', 'awaiting_approval', 'needs_author_decision', 'revising', 'reviewing', 'open', 'ready', 'partially_applied'].includes(status)) return C.warn
  if (['planned', 'draft', 'draft_generated', 'manual_draft', 'analyzing', 'applying'].includes(status)) return C.info
  return C.muted
}
function shortTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function Pill({ children, color }: { children: ReactNode; color?: string }) {
  const tone = color ?? C.muted
  return <span style={{ display: 'inline-flex', alignItems: 'center', padding: '0 7px', borderRadius: 999, border: `1px solid ${tone}`, color: tone, fontSize: 11, lineHeight: '18px', whiteSpace: 'nowrap' }}>{children}</span>
}
function StatusPill({ status }: { status: string }) { return <Pill color={toneOf(status)}>{text(status)}</Pill> }

const btnStyle: React.CSSProperties = {
  border: `1px solid ${C.line}`, background: C.bg3, color: C.text, borderRadius: 8,
  padding: '4px 10px', fontSize: 12, cursor: 'pointer', font: 'inherit',
}
const inputStyle: React.CSSProperties = {
  border: `1px solid ${C.line}`, background: C.bg, color: C.text, borderRadius: 8,
  padding: '5px 9px', fontSize: 12.5, font: 'inherit', width: '100%', boxSizing: 'border-box',
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
      <span style={{ color: C.muted, fontSize: 11 }}>{label}</span>
      {children}
      {hint && <span style={{ color: C.muted, fontSize: 10.5 }}>{hint}</span>}
    </label>
  )
}

function Row({ children, onClick, active }: { children: ReactNode; onClick?: () => void; active?: boolean }) {
  return (
    <div
      onClick={onClick}
      style={{ padding: '8px 10px', borderRadius: 8, cursor: onClick ? 'pointer' : 'default', background: active ? 'rgba(216,166,87,0.12)' : 'transparent', border: `1px solid ${active ? 'rgba(216,166,87,0.38)' : 'transparent'}` }}
      onMouseEnter={event => { if (onClick && !active) (event.currentTarget as HTMLDivElement).style.background = C.bg3 }}
      onMouseLeave={event => { if (!active) (event.currentTarget as HTMLDivElement).style.background = 'transparent' }}
    >{children}</div>
  )
}

function StatCard({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: string }) {
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: '8px 11px', background: C.bg2, minWidth: 76 }}>
      <div style={{ color: C.muted, fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: tone ?? C.text, lineHeight: 1.3 }}>{value}</div>
      {hint && <div style={{ color: C.muted, fontSize: 10.5 }}>{hint}</div>}
    </div>
  )
}

function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(4,6,9,0.66)', display: 'grid', placeItems: 'center', padding: 20 }} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div style={{ width: wide ? 'min(880px, 100%)' : 'min(560px, 100%)', maxHeight: '86vh', overflow: 'auto', background: C.bg2, border: `1px solid ${C.line}`, borderRadius: 12, padding: '16px 18px', color: C.text, boxShadow: '0 18px 40px rgba(0,0,0,0.5)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <strong style={{ fontSize: 14 }}>{title}</strong>
          <div style={{ flex: 1 }} />
          <button type="button" style={btnStyle} onClick={onClose}>关闭</button>
        </div>
        {children}
        {footer && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>{footer}</div>}
      </div>
    </div>
  )
}

// ── 主面板 ──────────────────────────────────────────────────
export function NovelForgePanel() {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [overview, setOverview] = useState<ProjectOverview | null>(null)
  const [chapters, setChapters] = useState<ChapterSummary[]>([])
  const [entities, setEntities] = useState<Entity[]>([])
  const [threads, setThreads] = useState<PlotThread[]>([])
  const [relations, setRelations] = useState<Relation[]>([])
  const [events, setEvents] = useState<StoryEvent[]>([])
  const [foreshadowing, setForeshadowing] = useState<Foreshadowing[]>([])
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [batches, setBatches] = useState<IngestBatch[]>([])
  const [knowledge, setKnowledge] = useState<KnowledgeFact[]>([])
  const [hits, setHits] = useState<SearchHit[]>([])
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<Tab>('chapters')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [aiReady, setAiReady] = useState(false)

  // 章节工作台
  const [reader, setReader] = useState<ChapterDetail | null>(null)
  const [scenes, setScenes] = useState<Scene[]>([])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  // 弹窗
  const [entityDraft, setEntityDraft] = useState<Partial<Entity> | null>(null)
  const [newChapterTitle, setNewChapterTitle] = useState<string | null>(null)
  const [threadDraft, setThreadDraft] = useState<Partial<PlotThread> | null>(null)
  const [relationDraft, setRelationDraft] = useState<{ id?: string; version?: number; sourceId: string; targetId: string; kind: string; tension: string } | null>(null)
  const [sceneDraft, setSceneDraft] = useState<Partial<Scene> | null>(null)
  const [knowledgeDraft, setKnowledgeDraft] = useState<Partial<KnowledgeFact> | null>(null)
  const [eventDraft, setEventDraft] = useState<{ id?: string; summary: string; eventTime: string; status: string; version?: number } | null>(null)
  const [shadowDraft, setShadowDraft] = useState<Partial<Foreshadowing> | null>(null)
  const [outlineDraft, setOutlineDraft] = useState<{ id: string; summary: string; goal: string; conflict: string; hook: string; raw: string; version: number } | null>(null)
  const [entityDetail, setEntityDetail] = useState<Entity | null>(null)
  const [entityStates, setEntityStates] = useState<EntityState[]>([])
  const [stateDraft, setStateDraft] = useState<{ chapterId: string; summary: string; stateJson: string } | null>(null)
  const [knowerDraft, setKnowerDraft] = useState<Record<string, 'knows' | 'suspects' | 'misbelieves' | 'unaware' | 'none'>>({})

  // 素材导入
  const [material, setMaterial] = useState('')
  const [materialTitle, setMaterialTitle] = useState('')
  const [materialFocus, setMaterialFocus] = useState('')
  const [materialMode, setMaterialMode] = useState<'propose' | 'apply'>('propose')
  const [ingestResult, setIngestResult] = useState<IngestOutcome | null>(null)

  const mounted = useRef(true)
  const projectIdRef = useRef('')
  useEffect(() => () => { mounted.current = false }, [])

  const flash = useCallback((message: string): void => {
    setNotice(message)
    window.setTimeout(() => { if (mounted.current) setNotice(current => (current === message ? null : current)) }, 4200)
  }, [])

  const loadProject = useCallback(async (id: string): Promise<void> => {
    setError(null)
    try {
      const encoded = encodeURIComponent(id)
      const [detail, chapterList, entityList, threadList, relationList, eventList, shadowList, proposalList, batchList, knowledgeList] = await Promise.all([
        apiGet<ProjectOverview>(`/api/projects/${encoded}`),
        apiGet<ChapterSummary[]>(`/api/projects/${encoded}/chapter-summaries`),
        apiGet<Entity[]>(`/api/projects/${encoded}/entities`),
        apiGet<PlotThread[]>(`/api/projects/${encoded}/threads`),
        apiGet<Relation[]>(`/api/projects/${encoded}/relations`),
        apiGet<StoryEvent[]>(`/api/projects/${encoded}/events`),
        apiGet<Foreshadowing[]>(`/api/projects/${encoded}/foreshadowing`),
        apiGet<Proposal[]>(`/api/projects/${encoded}/proposals?status=pending`),
        apiGet<IngestBatch[]>(`/api/projects/${encoded}/ingest-batches`),
        apiGet<KnowledgeFact[]>(`/api/projects/${encoded}/knowledge`),
      ])
      if (!mounted.current) return
      setOverview(detail)
      setChapters(chapterList)
      setEntities(entityList)
      setThreads(threadList)
      setRelations(relationList)
      setEvents(eventList)
      setForeshadowing(shadowList)
      setProposals(proposalList)
      setBatches(batchList)
      setKnowledge(knowledgeList)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const health = await apiGet<{ hasApiKey: boolean }>('/api/health').catch(() => ({ hasApiKey: false }))
      if (mounted.current) setAiReady(Boolean(health.hasApiKey))
      const list = await apiGet<Project[]>('/api/projects')
      if (!mounted.current) return
      setProjects(list)
      const next = projectIdRef.current && list.some(item => item.id === projectIdRef.current) ? projectIdRef.current : (list[0]?.id ?? '')
      projectIdRef.current = next
      setProjectId(next)
      if (next) await loadProject(next)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [loadProject])

  useEffect(() => { void refresh() }, [attempt, refresh])

  useEffect(() => {
    if (!query.trim() || !projectId) { setHits([]); return }
    const timer = setTimeout(() => {
      void apiGet<SearchHit[]>(`/api/projects/${encodeURIComponent(projectId)}/search?q=${encodeURIComponent(query.trim())}&limit=20`)
        .then(setHits)
        .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
    }, 250)
    return () => clearTimeout(timer)
  }, [query, projectId])

  const act = useCallback(async (key: string, action: () => Promise<unknown>, message: string): Promise<boolean> => {
    setBusy(key)
    setError(null)
    try {
      await action()
      flash(message)
      if (projectIdRef.current) await loadProject(projectIdRef.current)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [flash, loadProject])

  const project = useMemo(() => projects.find(item => item.id === projectId) ?? null, [projects, projectId])
  const counts = overview?.counts
  const progressChapter = useMemo(() => {
    const finalized = chapters.filter(item => item.chapter.status === 'finalized')
    if (finalized.length) return Math.max(...finalized.map(item => item.chapter.chapterNo))
    const all = chapters.map(item => item.chapter.chapterNo)
    return all.length ? Math.min(...all) - 1 : 0
  }, [chapters])
  const isOverdue = (item: Foreshadowing): boolean =>
    (item.status === 'open' || item.status === 'reinforced') && item.deadlineChapterId !== null
    && item.deadlineChapterId > 0 && item.deadlineChapterId <= progressChapter
  const characters = useMemo(() => entities.filter(item => item.kind === 'character'), [entities])
  const others = useMemo(() => entities.filter(item => item.kind !== 'character'), [entities])

  // ── 章节 ──
  const openChapter = async (id: string): Promise<void> => {
    setReader(null); setScenes([]); setEditing(false)
    try {
      const detail = await apiGet<ChapterDetail>(`/api/chapters/${encodeURIComponent(id)}`)
      if (!mounted.current) return
      setReader(detail)
      setDraft(detail.latestRevision?.content ?? '')
      setScenes(await apiGet<Scene[]>(`/api/chapters/${encodeURIComponent(id)}/scenes`))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const reloadReader = async (): Promise<void> => {
    if (!reader) return
    await openChapter(reader.chapter.id)
  }
  const saveDraft = async (): Promise<void> => {
    if (!reader) return
    const ok = await act('save', () => apiCall('POST', `/api/chapters/${reader.chapter.id}/revisions`, { content: draft }), '已保存为新版本')
    if (ok) { setEditing(false); await reloadReader() }
  }
  const finalize = async (): Promise<void> => {
    if (!reader?.latestRevision) return
    if (!window.confirm(`确认定稿第 ${reader.chapter.chapterNo} 章？定稿后导出才包含它，历史版本仍保留。`)) return
    await act('finalize', () => apiCall('POST', `/api/revisions/${reader.latestRevision?.id}/finalize`, { approvedChangeIds: [] }), '已定稿')
    await reloadReader()
  }
  const aiDraft = async (): Promise<void> => {
    if (!reader) return
    if (!window.confirm('让 AI 读取上下文生成本章草稿？会新建一个版本，不影响现有正文。')) return
    const ok = await act('ai-draft', () => apiCall('POST', `/api/chapters/${reader.chapter.id}/draft`), '草稿已生成')
    if (ok) await reloadReader()
  }
  const aiReview = async (): Promise<void> => {
    if (!reader?.latestRevision) return
    const ok = await act('ai-review', () => apiCall('POST', `/api/revisions/${reader.latestRevision?.id}/review`), '审查完成')
    if (ok) await reloadReader()
  }
  const aiRevise = async (): Promise<void> => {
    if (!reader?.latestRevision) return
    const issues = (reader.latestReview?.issues ?? []).filter(issue => (issue.resolutionStatus ?? 'open') === 'open')
    if (!issues.length) { setError('当前版本没有未解决的审查问题，先跑一次审查。'); return }
    if (!window.confirm(`按 ${issues.length} 个未解决问题让 AI 修订？会新建一个版本并自动复检。`)) return
    const ok = await act('ai-revise', () => apiCall('POST', `/api/revisions/${reader.latestRevision?.id}/revise`, {
      issueIds: issues.map(issue => issue.id),
      instruction: '',
    }), '修订完成并已复检')
    if (ok) await reloadReader()
  }

  const createChapter = async (): Promise<void> => {
    if (!newChapterTitle?.trim() || !projectId) return
    const ok = await act('chapter', () => apiCall('POST', `/api/projects/${projectId}/chapters`, { title: newChapterTitle.trim() }), '已创建章节')
    if (ok) setNewChapterTitle(null)
  }

  // ── 实体 ──
  const saveEntity = async (): Promise<void> => {
    if (!entityDraft || !projectId) return
    const payload = {
      kind: entityDraft.kind ?? 'character',
      name: entityDraft.name ?? '',
      summary: entityDraft.summary ?? '',
      role: entityDraft.role ?? '',
      goal: entityDraft.goal ?? '',
      motivation: entityDraft.motivation ?? '',
      flaw: entityDraft.flaw ?? '',
      secret: entityDraft.secret ?? '',
      voice: entityDraft.voice ?? '',
      arc: entityDraft.arc ?? '',
      importance: entityDraft.importance ?? 3,
      status: entityDraft.status ?? 'confirmed',
    }
    const ok = entityDraft.id
      ? await act('entity', () => apiCall('PATCH', `/api/entities/${entityDraft.id}`, { ...payload, expectedVersion: entityDraft.version }), '已保存人物资料')
      : await act('entity', () => apiCall('POST', `/api/projects/${projectId}/entities`, payload), '已创建人物/设定')
    if (ok) setEntityDraft(null)
  }

  // ── 剧情线 / 关系 / 场景 ──
  const saveThread = async (): Promise<void> => {
    if (!threadDraft || !projectId) return
    const payload = { name: threadDraft.name ?? '', kind: threadDraft.kind ?? 'main', goal: threadDraft.goal ?? '', summary: threadDraft.summary ?? '', status: threadDraft.status ?? 'active' }
    const ok = threadDraft.id
      ? await act('thread', () => apiCall('PATCH', `/api/threads/${threadDraft.id}`, { ...payload, expectedVersion: threadDraft.version }), '已保存剧情线')
      : await act('thread', () => apiCall('POST', `/api/projects/${projectId}/threads`, payload), '已创建剧情线')
    if (ok) setThreadDraft(null)
  }
  const saveRelation = async (): Promise<void> => {
    if (!relationDraft || !projectId) return
    const ok = relationDraft.id
      ? await act('relation', () => apiCall('PATCH', `/api/relations/${relationDraft.id}`, {
        kind: relationDraft.kind, tension: relationDraft.tension, expectedVersion: relationDraft.version,
      }), '已保存关系')
      : await act('relation', () => apiCall('POST', `/api/projects/${projectId}/relations`, {
        sourceId: relationDraft.sourceId, targetId: relationDraft.targetId,
        kind: relationDraft.kind, tension: relationDraft.tension,
      }), '已创建关系')
    if (ok) setRelationDraft(null)
  }

  // ── AI 批量规划大纲 ──
  const planOutline = async (): Promise<void> => {
    if (!projectId) return
    const raw = window.prompt('要规划多少章？（1–100）', '10')
    if (raw === null) return
    const count = Number(raw)
    if (!Number.isInteger(count) || count < 1 || count > 100) { setError('章节数必须是 1–100 的整数。'); return }
    if (!window.confirm(`让 AI 规划 ${count} 章并写入卷纲/章纲/章节记录？`)) return
    await act('plan', () => apiCall('POST', `/api/projects/${projectId}/outlines/plan`, { chapterCount: count }), `已规划 ${count} 章`)
  }
  const saveScene = async (): Promise<void> => {
    if (!sceneDraft || !reader) return
    const payload = { beat: sceneDraft.beat ?? '', goal: sceneDraft.goal ?? '', conflict: sceneDraft.conflict ?? '', outcome: sceneDraft.outcome ?? '' }
    const ok = sceneDraft.id
      ? await act('scene', () => apiCall('PATCH', `/api/scenes/${sceneDraft.id}`, { ...payload, expectedVersion: sceneDraft.version }), '已保存场景')
      : await act('scene', () => apiCall('POST', `/api/chapters/${reader.chapter.id}/scenes`, payload), '已添加场景')
    if (ok) { setSceneDraft(null); await reloadReader() }
  }
  const deleteScene = async (sceneId: string): Promise<void> => {
    if (!window.confirm('删除这个场景？')) return
    const ok = await act('scene-delete', () => apiCall('DELETE', `/api/scenes/${sceneId}`), '已删除场景')
    if (ok) await reloadReader()
  }

  // ── 素材导入 / 审批 ──
  const runIngest = async (): Promise<void> => {
    if (!projectId) return
    if (material.trim().length < 20) { setError('素材太短，至少 20 字。'); return }
    if (materialMode === 'apply' && !window.confirm('apply 模式会直接把抽取结果写入正式资料，确定吗？')) return
    setBusy('ingest')
    setError(null)
    try {
      const result = await apiCall<IngestOutcome>('POST', `/api/projects/${projectId}/ingest`, {
        material,
        ...(materialTitle.trim() ? { title: materialTitle.trim() } : {}),
        ...(materialFocus.trim() ? { focus: materialFocus.trim() } : {}),
        mode: materialMode,
      })
      setIngestResult(result)
      flash(`整理完成：${result.proposals.length} 条提议`)
      await loadProject(projectId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setBusy(null)
    }
  }
  const applyBatch = async (batchId: string): Promise<void> => {
    if (!window.confirm('应用这个批次里的全部提议？会写入正式资料并记录审计。')) return
    await act('batch', () => apiCall('POST', `/api/ingest-batches/${batchId}/apply`), '批次已应用')
  }
  const applyProposal = async (proposalId: string): Promise<void> => {
    await act('proposal', () => apiCall('POST', `/api/proposals/${proposalId}/apply`), '已应用到正式资料')
  }
  const rejectProposal = async (proposalId: string): Promise<void> => {
    await act('proposal', () => apiCall('POST', `/api/proposals/${proposalId}/reject`), '已驳回')
  }

  // ── 知情矩阵 ──
  const saveKnowledge = async (): Promise<void> => {
    if (!knowledgeDraft || !projectId) return
    const knowers = Object.entries(knowerDraft)
      .filter(([, state]) => state !== 'none')
      .map(([entityId, state]) => ({ entityId, state }))
    const payload = {
      proposition: knowledgeDraft.proposition ?? '',
      truth: knowledgeDraft.truth ?? 'true',
      publicLevel: knowledgeDraft.publicLevel ?? 'secret',
      chapterId: knowledgeDraft.chapterId ?? null,
      notes: knowledgeDraft.notes ?? '',
      knowers,
    }
    const ok = knowledgeDraft.id
      ? await act('knowledge', () => apiCall('PATCH', `/api/knowledge/${knowledgeDraft.id}`, { ...payload, expectedVersion: knowledgeDraft.version }), '已保存知情事实')
      : await act('knowledge', () => apiCall('POST', `/api/projects/${projectId}/knowledge`, payload), '已记录知情事实')
    if (ok) { setKnowledgeDraft(null); setKnowerDraft({}) }
  }
  const deleteKnowledge = async (factId: string): Promise<void> => {
    if (!window.confirm('删除这条知情事实？')) return
    await act('knowledge-delete', () => apiCall('DELETE', `/api/knowledge/${factId}`), '已删除')
  }

  // ── 事件 / 伏笔 ──
  const saveEvent = async (): Promise<void> => {
    if (!eventDraft || !projectId) return
    const payload = { summary: eventDraft.summary, eventTime: eventDraft.eventTime, status: eventDraft.status }
    const ok = eventDraft.id
      ? await act('event', () => apiCall('PATCH', `/api/events/${eventDraft.id}`, payload), '已保存事件')
      : await act('event', () => apiCall('POST', `/api/projects/${projectId}/events`, payload), '已创建事件')
    if (ok) setEventDraft(null)
  }
  const saveShadow = async (): Promise<void> => {
    if (!shadowDraft || !projectId) return
    const payload = {
      name: shadowDraft.name ?? '',
      description: shadowDraft.description ?? '',
      kind: shadowDraft.kind ?? '',
      importance: shadowDraft.importance ?? 3,
      notes: shadowDraft.notes ?? '',
      status: shadowDraft.status ?? 'open',
      deadlineChapterId: shadowDraft.deadlineChapterId ?? null,
    }
    const ok = shadowDraft.id
      ? await act('shadow', () => apiCall('PATCH', `/api/foreshadowing/${shadowDraft.id}`, { ...payload, expectedVersion: shadowDraft.version }), '已保存伏笔')
      : await act('shadow', () => apiCall('POST', `/api/projects/${projectId}/foreshadowing`, payload), '已埋设伏笔')
    if (ok) setShadowDraft(null)
  }

  // ── 章纲 ──
  const saveOutline = async (): Promise<void> => {
    if (!outlineDraft) return
    const content = JSON.stringify({ summary: outlineDraft.summary, goal: outlineDraft.goal, conflict: outlineDraft.conflict, hook: outlineDraft.hook })
    const ok = await act('outline', () => apiCall('PATCH', `/api/outlines/${outlineDraft.id}`, { content, expectedVersion: outlineDraft.version }), '已保存章纲')
    if (ok) { setOutlineDraft(null); await reloadReader() }
  }
  const openOutline = (): void => {
    if (!reader?.outline) return
    let parsed: { summary?: string; goal?: string; conflict?: string; hook?: string } = {}
    try { parsed = JSON.parse(reader.outline.content) as typeof parsed } catch { parsed = {} }
    setOutlineDraft({
      id: reader.outline.id,
      version: reader.outline.version,
      summary: parsed.summary ?? '',
      goal: parsed.goal ?? '',
      conflict: parsed.conflict ?? '',
      hook: parsed.hook ?? '',
      raw: reader.outline.content,
    })
  }

  // ── 人物状态快照 ──
  const openEntityDetail = async (entity: Entity): Promise<void> => {
    setEntityDetail(entity)
    setStateDraft({ chapterId: '', summary: '', stateJson: '{}' })
    try {
      setEntityStates(await apiGet<EntityState[]>(`/api/entities/${encodeURIComponent(entity.id)}/states`))
    } catch {
      setEntityStates([])
    }
  }
  const saveEntityState = async (): Promise<void> => {
    if (!entityDetail || !stateDraft) return
    let parsed: Record<string, unknown> = {}
    try { parsed = JSON.parse(stateDraft.stateJson || '{}') as Record<string, unknown> } catch { setError('状态 JSON 格式不对。'); return }
    const ok = await act('entity-state', () => apiCall('POST', `/api/entities/${entityDetail.id}/states`, {
      ...(stateDraft.chapterId ? { chapterId: stateDraft.chapterId } : {}),
      summary: stateDraft.summary,
      state: parsed,
    }), '已记录状态快照')
    if (ok) {
      setEntityStates(await apiGet<EntityState[]>(`/api/entities/${encodeURIComponent(entityDetail.id)}/states`).catch(() => []))
      setStateDraft({ chapterId: '', summary: '', stateJson: '{}' })
    }
  }

  // ── 删除关系 / 剧情线 ──
  const deleteRelation = async (relation: Relation): Promise<void> => {
    if (!window.confirm(`删除关系「${relation.sourceName} —${relation.kind}→ ${relation.targetName}」？`)) return
    await act('relation-delete', () => apiCall('DELETE', `/api/relations/${relation.id}`), '已删除关系')
  }
  const deleteThread = async (thread: PlotThread): Promise<void> => {
    if (!window.confirm(`删除剧情线「${thread.name}」？`)) return
    await act('thread-delete', () => apiCall('DELETE', `/api/threads/${thread.id}`), '已删除剧情线')
  }

  // ── 导出 ──
  const exportMarkdown = async (): Promise<void> => {
    if (!projectId) return
    try {
      const base = await discoverBase()
      const response = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}/export.md`)
      if (!response.ok) throw new Error(`导出失败（HTTP ${response.status}）`)
      const markdown = await response.text()
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${project?.title ?? 'novel'}.md`
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      flash(`已导出 ${markdown.length} 字符（仅含已定稿章节）`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const retry = (): void => { cachedBase = null; setLoading(true); setAttempt(value => value + 1) }

  // ── 章节阅读 / 编辑视图 ──
  if (reader) {
    const dirty = editing && draft !== (reader.latestRevision?.content ?? '')
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: `1px solid ${C.line}`, flexWrap: 'wrap' }}>
          <button type="button" style={btnStyle} onClick={() => { setReader(null); setEditing(false) }}>← 返回</button>
          <div style={{ fontWeight: 600 }}>第 {reader.chapter.chapterNo} 章 {reader.chapter.title}</div>
          <StatusPill status={reader.chapter.status} />
          {reader.latestRevision && <Pill>v{reader.latestRevision.revisionNo} · {reader.latestRevision.content.length} 字符</Pill>}
          <div style={{ flex: 1 }} />
          {editing ? (
            <>
              <button type="button" style={{ ...btnStyle, borderColor: 'rgba(108,192,139,0.5)', color: C.ok }} disabled={busy !== null} onClick={() => { void saveDraft() }}>
                {busy === 'save' ? '保存中…' : dirty ? '保存为新版本' : '没有改动'}
              </button>
              <button type="button" style={btnStyle} onClick={() => { setEditing(false); setDraft(reader.latestRevision?.content ?? '') }}>取消</button>
            </>
          ) : (
            <>
              <button type="button" style={btnStyle} onClick={() => { setEditing(true); setDraft(reader.latestRevision?.content ?? '') }}>编辑正文</button>
              {reader.outline && <button type="button" style={btnStyle} onClick={openOutline}>编辑章纲</button>}
              {aiReady && (
                <>
                  <button type="button" style={btnStyle} disabled={busy !== null} onClick={() => { void aiDraft() }} title="读取上下文生成本章草稿">
                    {busy === 'ai-draft' ? '生成中…' : 'AI 草稿'}
                  </button>
                  <button type="button" style={btnStyle} disabled={!reader.latestRevision || busy !== null} onClick={() => { void aiReview() }} title="六维审查最新版本">
                    {busy === 'ai-review' ? '审查中…' : 'AI 审查'}
                  </button>
                  <button type="button" style={btnStyle} disabled={!reader.latestRevision || busy !== null} onClick={() => { void aiRevise() }} title="按未解决问题修订并复检">
                    {busy === 'ai-revise' ? '修订中…' : `AI 修订${reader.latestReview ? ` (${(reader.latestReview.issues ?? []).filter(issue => (issue.resolutionStatus ?? 'open') === 'open').length})` : ''}`}
                  </button>
                </>
              )}
              <button type="button" style={btnStyle} disabled={!reader.latestRevision || busy !== null} onClick={() => { void finalize() }}>定稿</button>
            </>
          )}
        </div>
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div style={{ flex: 1, overflow: 'auto', padding: editing ? 12 : '22px 28px' }}>
            {editing ? (
              <textarea
                value={draft}
                onChange={event => setDraft(event.target.value)}
                style={{ width: '100%', height: '100%', minHeight: 400, resize: 'vertical', background: C.bg, color: C.text, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, fontSize: 15, lineHeight: 1.9, fontFamily: 'var(--dsw-alias-font-serif, "Songti SC", Georgia, serif)', boxSizing: 'border-box' }}
                placeholder="在这一章写正文；保存会新建一个版本，不覆盖历史。"
              />
            ) : (
              <div style={{ lineHeight: 1.95, fontSize: 15.5, fontFamily: 'var(--dsw-alias-font-serif, "Songti SC", "Source Han Serif SC", Georgia, serif)', whiteSpace: 'pre-wrap' }}>
                {reader.chapter.summary && (
                  <div style={{ marginBottom: 16, padding: '8px 12px', border: `1px solid ${C.line}`, borderRadius: 8, color: C.dim, fontSize: 13, fontFamily: 'inherit', whiteSpace: 'normal' }}>
                    章节摘要：{reader.chapter.summary}
                  </div>
                )}
                {reader.latestRevision?.content ?? '这一章还没有正文。点右上角「编辑正文」直接写。'}
              </div>
            )}
          </div>
          <div style={{ width: 300, borderLeft: `1px solid ${C.line}`, overflow: 'auto', padding: '12px 14px', background: C.bg2 }}>
            {reader.latestReview && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ color: C.muted, fontSize: 11, letterSpacing: 1, marginBottom: 6 }}>审查问题 {reader.latestReview.issues.length}</div>
                {reader.latestReview.issues.slice(0, 6).map(issue => (
                  <div key={issue.id} style={{ borderLeft: `3px solid ${issue.severity === 'critical' ? C.danger : issue.severity === 'major' ? C.warn : C.muted}`, paddingLeft: 7, marginBottom: 6 }}>
                    <div style={{ fontSize: 11.5, color: C.dim, lineHeight: 1.6 }}>{issue.issue.slice(0, 90)}</div>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ color: C.muted, fontSize: 11, letterSpacing: 1 }}>场景 / 节拍 {scenes.length}</span>
              <div style={{ flex: 1 }} />
              <button type="button" style={{ ...btnStyle, padding: '2px 7px', fontSize: 11 }} onClick={() => setSceneDraft({ beat: '', goal: '', conflict: '', outcome: '' })}>+ 场景</button>
            </div>
            {scenes.length === 0 && <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.8 }}>还没有场景。拆成「目标-冲突-结果」，写起来不容易流水账。</div>}
            {scenes.map(scene => (
              <div key={scene.id} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: '8px 10px', marginBottom: 8, background: C.bg }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ color: C.accent, fontSize: 11 }}>S{scene.sceneNo}</span>
                  {scene.beat && <Pill>{scene.beat}</Pill>}
                  <div style={{ flex: 1 }} />
                  <button type="button" style={{ ...btnStyle, padding: '1px 6px', fontSize: 10.5 }} onClick={() => setSceneDraft(scene)}>改</button>
                  <button type="button" style={{ ...btnStyle, padding: '1px 6px', fontSize: 10.5, color: C.danger }} onClick={() => { void deleteScene(scene.id) }}>删</button>
                </div>
                {scene.goal && <div style={{ fontSize: 12, marginTop: 4 }}>目标：{scene.goal}</div>}
                {scene.conflict && <div style={{ fontSize: 12, color: C.dim }}>冲突：{scene.conflict}</div>}
                {scene.outcome && <div style={{ fontSize: 12, color: C.dim }}>结果：{scene.outcome}</div>}
              </div>
            ))}
          </div>
        </div>

        {sceneDraft && (
          <Modal title={sceneDraft.id ? '编辑场景' : '新增场景'} onClose={() => setSceneDraft(null)}
            footer={<><button type="button" style={btnStyle} onClick={() => setSceneDraft(null)}>取消</button><button type="button" style={{ ...btnStyle, borderColor: 'rgba(216,166,87,0.5)', color: C.accent }} onClick={() => { void saveScene() }}>保存</button></>}>
            <div style={{ display: 'grid', gap: 10 }}>
              <Field label="节拍（如：冷开场 / 冲突升级 / 代价展示）"><input style={inputStyle} value={sceneDraft.beat ?? ''} onChange={event => setSceneDraft({ ...sceneDraft, beat: event.target.value })} /></Field>
              <Field label="场景目标"><input style={inputStyle} value={sceneDraft.goal ?? ''} onChange={event => setSceneDraft({ ...sceneDraft, goal: event.target.value })} /></Field>
              <Field label="冲突"><input style={inputStyle} value={sceneDraft.conflict ?? ''} onChange={event => setSceneDraft({ ...sceneDraft, conflict: event.target.value })} /></Field>
              <Field label="结果"><input style={inputStyle} value={sceneDraft.outcome ?? ''} onChange={event => setSceneDraft({ ...sceneDraft, outcome: event.target.value })} /></Field>
            </div>
          </Modal>
        )}
      </div>
    )
  }

  const tabs: Array<[Tab, string, number | null]> = [
    ['chapters', '章节', chapters.length],
    ['entities', '资料', entities.length],
    ['threads', '剧情线', threads.length],
    ['relations', '关系', relations.length],
    ['timeline', '时间线', events.length],
    ['foreshadowing', '伏笔', foreshadowing.length],
    ['knowledge', '认知', knowledge.length],
    ['ingest', '导入', batches.length],
    ['proposals', '审批', proposals.length],
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text, fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: `1px solid ${C.line}`, flexWrap: 'wrap' }}>
        <strong style={{ fontFamily: 'var(--dsw-alias-font-serif, "Songti SC", Georgia, serif)', letterSpacing: '0.04em' }}>NovelForge</strong>
        <select
          value={projectId}
          onChange={event => { const id = event.target.value; projectIdRef.current = id; setProjectId(id); setReader(null); void loadProject(id) }}
          style={{ ...btnStyle, maxWidth: 220 }}
        >
          {projects.length === 0 && <option value="">（暂无项目）</option>}
          {projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索章节、人物、事件、伏笔…" style={{ ...btnStyle, width: 240, fontWeight: 'normal' }} />
        <div style={{ flex: 1 }} />
        {project && <span style={{ color: C.muted }}>{project.genre}{project.pov ? ` · ${project.pov}` : ''}</span>}
        <button type="button" style={btnStyle} onClick={() => { cachedBase = null; void refresh() }}>刷新</button>
        <button type="button" style={btnStyle} onClick={() => { void exportMarkdown() }} title="导出仅含已定稿章节的 Markdown">导出</button>
      </div>

      {notice && <div style={{ margin: '8px 16px 0', padding: '7px 11px', border: `1px solid rgba(108,192,139,0.4)`, background: 'rgba(108,192,139,0.1)', color: C.ok, borderRadius: 8, fontSize: 12 }}>{notice}</div>}
      {error && (
        <div style={{ margin: '8px 16px 0', padding: '9px 12px', border: `1px solid ${C.danger}`, borderRadius: 8, color: C.danger, whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
          <div style={{ marginBottom: 6 }}>{error}</div>
          <button type="button" style={btnStyle} onClick={retry}>重新连接</button>
        </div>
      )}

      {counts && (
        <div style={{ display: 'flex', gap: 8, padding: '10px 16px', borderBottom: `1px solid ${C.line}`, overflowX: 'auto' }}>
          <StatCard label="章节" value={counts.chapters} hint={`已定稿 ${counts.finalizedChapters}`} />
          <StatCard label="人物" value={characters.length} hint={`设定 ${others.length}`} />
          <StatCard label="剧情线" value={counts.threads} />
          <StatCard label="关系" value={counts.relations} />
          <StatCard label="场景" value={counts.scenes} />
          <StatCard label="未回收伏笔" value={counts.foreshadowingOpen} tone={counts.foreshadowingOpen ? C.warn : undefined} />
          <StatCard label="待审批" value={counts.pendingProposals} tone={counts.pendingProposals ? C.warn : undefined} />
          <StatCard label="逾期伏笔" value={counts.overdueForeshadowing} tone={counts.overdueForeshadowing ? C.danger : undefined}
            hint={counts.overdueForeshadowing ? '已过截止章' : undefined} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, padding: '8px 16px', borderBottom: `1px solid ${C.line}`, flexWrap: 'wrap' }}>
        {tabs.map(([key, label, count]) => (
          <button key={key} type="button" onClick={() => setTab(key)}
            style={{ ...btnStyle, background: tab === key ? 'rgba(216,166,87,0.14)' : 'transparent', borderColor: tab === key ? 'rgba(216,166,87,0.45)' : C.line, color: tab === key ? C.accent : C.dim }}>
            {label}{count ? ` ${count}` : ''}
          </button>
        ))}
      </div>

      {loading && <div style={{ padding: 16, color: C.muted }}>正在连接 NovelForge 本地服务…（服务刚启动时会自动重试约 20 秒）</div>}

      {!loading && !error && projects.length === 0 && (
        <div style={{ padding: 24, color: C.muted, lineHeight: 1.9 }}>还没有小说项目。在对话里说「新建一本小说」，或到完整工作台创建。</div>
      )}

      {!loading && query.trim() && (
        <div style={{ overflow: 'auto', padding: '6px 10px' }}>
          <div style={{ padding: '4px 8px', color: C.muted, fontSize: 11 }}>搜索「{query.trim()}」命中 {hits.length} 条</div>
          {hits.map(hit => (
            <Row key={hit.recordId}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Pill color={C.info}>{KIND_TEXT[hit.recordType] ?? hit.recordType}</Pill><StatusPill status={hit.status} /></div>
              <div style={{ marginTop: 3, color: C.dim, whiteSpace: 'pre-wrap' }}>{hit.snippet.slice(0, 240)}</div>
            </Row>
          ))}
        </div>
      )}

      {!loading && !query.trim() && (
        <div style={{ overflow: 'auto', flex: 1 }}>
          {tab === 'chapters' && (
            <div style={{ padding: '6px 10px' }}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <button type="button" style={btnStyle} onClick={() => setNewChapterTitle('')}>+ 新建章节</button>
                {aiReady && <button type="button" style={{ ...btnStyle, borderColor: 'rgba(216,166,87,0.5)', color: C.accent }} disabled={busy !== null} onClick={() => { void planOutline() }}>{busy === 'plan' ? '规划中…' : 'AI 规划后续章节'}</button>}
              </div>
              {chapters.length === 0 && <div style={{ padding: 16, color: C.muted }}>还没有章节。</div>}
              {chapters.map(item => (
                <Row key={item.chapter.id} onClick={() => { void openChapter(item.chapter.id) }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: C.muted, minWidth: 30 }}>{item.chapter.chapterNo}</span>
                    <span style={{ fontFamily: 'var(--dsw-alias-font-serif, "Songti SC", Georgia, serif)' }}>{item.chapter.title}</span>
                    <StatusPill status={item.chapter.status} />
                    <div style={{ flex: 1 }} />
                    <span style={{ color: C.muted, fontSize: 11 }}>{item.latest ? `${item.latest.words} 字` : '无正文'} · v{item.latest?.revisionNo ?? 0}</span>
                  </div>
                </Row>
              ))}
            </div>
          )}

          {tab === 'entities' && (
            <div style={{ padding: '6px 10px' }}>
              <button type="button" style={{ ...btnStyle, marginBottom: 8 }} onClick={() => setEntityDraft({ kind: 'character', status: 'confirmed', importance: 3 })}>+ 新建人物/设定</button>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
                {entities.length === 0 && <div style={{ padding: 16, color: C.muted }}>资料库还是空的。去「导入」页贴设定让 AI 抽取，或手动新建。</div>}
                {[...characters, ...others].map(entity => (
                  <div key={entity.id} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: '9px 11px', background: C.bg2 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <strong>{entity.name}</strong>
                      <Pill color={C.info}>{KIND_TEXT[entity.kind] ?? entity.kind}</Pill>
                      {entity.role && <Pill color={C.accent}>{entity.role}</Pill>}
                      <StatusPill status={entity.status} />
                      <div style={{ flex: 1 }} />
                      <button type="button" style={{ ...btnStyle, padding: '1px 7px', fontSize: 11 }} onClick={() => { void openEntityDetail(entity) }}>详情</button>
                      <button type="button" style={{ ...btnStyle, padding: '1px 7px', fontSize: 11 }} onClick={() => setEntityDraft(entity)}>编辑</button>
                    </div>
                    {entity.goal && <div style={{ color: C.dim, marginTop: 4, fontSize: 12 }}>目标：{entity.goal}</div>}
                    {entity.summary && <div style={{ color: C.muted, marginTop: 3, fontSize: 11.5 }}>{entity.summary.slice(0, 90)}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'threads' && (
            <div style={{ padding: '6px 10px' }}>
              <button type="button" style={{ ...btnStyle, marginBottom: 8 }} onClick={() => setThreadDraft({ kind: 'main', status: 'active' })}>+ 新建剧情线</button>
              {threads.length === 0 && <div style={{ padding: 16, color: C.muted }}>还没有剧情线。建议主线 1 条 + 支线 2–4 条。</div>}
              {threads.map(thread => (
                <Row key={thread.id}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Pill color={thread.kind === 'main' ? C.accent : C.info}>{THREAD_TEXT[thread.kind] ?? thread.kind}</Pill>
                    <strong style={{ fontWeight: 500 }}>{thread.name}</strong>
                    <StatusPill status={thread.status} />
                    <div style={{ flex: 1 }} />
                    <button type="button" style={{ ...btnStyle, padding: '1px 7px', fontSize: 11 }} onClick={() => setThreadDraft(thread)}>编辑</button>
                    <button type="button" style={{ ...btnStyle, padding: '1px 7px', fontSize: 11, color: C.danger }} onClick={() => { void deleteThread(thread) }}>删除</button>
                  </div>
                  {thread.goal && <div style={{ color: C.dim, fontSize: 12, marginTop: 3 }}>目标：{thread.goal}</div>}
                </Row>
              ))}
            </div>
          )}

          {tab === 'relations' && (
            <div style={{ padding: '6px 10px' }}>
              <button type="button" style={{ ...btnStyle, marginBottom: 8 }} onClick={() => setRelationDraft({ sourceId: '', targetId: '', kind: '搭档', tension: '' })}>+ 新建关系</button>
              {relations.length === 0 && <div style={{ padding: 16, color: C.muted }}>还没有人物关系。关系张力是冲突的来源。</div>}
              {relations.map(relation => (
                <Row key={relation.id}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong style={{ fontWeight: 500 }}>{relation.sourceName}</strong>
                    <span style={{ color: C.muted }}>—{relation.kind}→</span>
                    <strong style={{ fontWeight: 500 }}>{relation.targetName}</strong>
                    <div style={{ flex: 1 }} />
                    <button type="button" style={{ ...btnStyle, padding: '1px 7px', fontSize: 11 }} onClick={() => setRelationDraft({ id: relation.id, version: relation.version, sourceId: '', targetId: '', kind: relation.kind, tension: relation.tension })}>编辑</button>
                    <button type="button" style={{ ...btnStyle, padding: '1px 7px', fontSize: 11, color: C.danger }} onClick={() => { void deleteRelation(relation) }}>删除</button>
                  </div>
                  {relation.tension && <div style={{ color: C.dim, fontSize: 12, marginTop: 3 }}>张力：{relation.tension}</div>}
                </Row>
              ))}
            </div>
          )}

          {tab === 'timeline' && (
            <div style={{ padding: '6px 10px' }}>
              <button type="button" style={{ ...btnStyle, marginBottom: 8 }} onClick={() => setEventDraft({ summary: '', eventTime: '', status: 'confirmed' })}>+ 新建事件</button>
              {events.length === 0 && <div style={{ padding: 16, color: C.muted }}>还没有事件记录。别忘了：planned 只是计划，confirmed 才算既成事实。</div>}
              {[...events].sort((a, b) => a.eventTime.localeCompare(b.eventTime)).map(event => (
                <Row key={event.id}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: C.muted, fontSize: 11, minWidth: 78 }}>{event.eventTime || '未定时间'}</span>
                    <StatusPill status={event.status} />
                    <span style={{ color: event.status === 'confirmed' ? C.text : C.dim }}>{event.summary}</span>
                    <div style={{ flex: 1 }} />
                    <button type="button" style={{ ...btnStyle, padding: '1px 7px', fontSize: 11 }} onClick={() => setEventDraft({ id: event.id, summary: event.summary, eventTime: event.eventTime, status: event.status })}>编辑</button>
                  </div>
                </Row>
              ))}
            </div>
          )}

          {tab === 'foreshadowing' && (
            <div style={{ padding: '6px 10px' }}>
              <button type="button" style={{ ...btnStyle, marginBottom: 8 }} onClick={() => setShadowDraft({ status: 'open', importance: 3, kind: '' })}>+ 埋设伏笔</button>
              {foreshadowing.length === 0 && <div style={{ padding: 16, color: C.muted }}>还没有伏笔记录。建议每条都填「最晚回收章」，逾期会在总览标红。</div>}
              {foreshadowing.map(item => {
                const overdue = isOverdue(item)
                return (
                  <Row key={item.id}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <strong style={{ fontWeight: 500 }}>{item.name}</strong>
                      <StatusPill status={item.status} />
                      {item.kind && <Pill>{item.kind}</Pill>}
                      {item.deadlineChapterId ? (
                        <Pill color={overdue ? C.danger : C.muted}>
                          {overdue ? `逾期：应第 ${item.deadlineChapterId} 章前回收` : `最晚第 ${item.deadlineChapterId} 章`}
                        </Pill>
                      ) : <Pill color={C.muted}>未设截止章</Pill>}
                      <div style={{ flex: 1 }} />
                      <button type="button" style={{ ...btnStyle, padding: '1px 7px', fontSize: 11 }} onClick={() => setShadowDraft(item)}>编辑</button>
                    </div>
                    <div style={{ color: overdue ? C.danger : C.dim, fontSize: 12, marginTop: 2 }}>{item.description || '（无描述）'}</div>
                  </Row>
                )
              })}
            </div>
          )}

          {tab === 'knowledge' && (
            <div style={{ padding: '6px 10px' }}>
              <button type="button" style={{ ...btnStyle, marginBottom: 8 }} onClick={() => {
                setKnowledgeDraft({ truth: 'true', publicLevel: 'secret', notes: '', proposition: '' })
                setKnowerDraft({})
              }}>+ 记录一条「谁知道什么」</button>
              {knowledge.length === 0 && (
                <div style={{ padding: 16, color: C.muted, lineHeight: 1.8 }}>
                  还没有知情事实。误会、装傻、信息差全靠它：写清「这件事的真相」+「谁已经知道 / 谁还在猜 / 谁被蒙在鼓里」。
                </div>
              )}
              {knowledge.map(fact => (
                <div key={fact.id} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: '8px 10px', marginBottom: 8, background: C.bg2 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 500 }}>{fact.proposition}</span>
                    <Pill color={fact.truth === 'true' ? C.ok : fact.truth === 'partial' ? C.warn : C.danger}>{text(fact.truth)}</Pill>
                    <Pill color={C.info}>{text(fact.publicLevel)}</Pill>
                    {fact.chapterNo !== null && <Pill color={C.muted}>第 {fact.chapterNo} 章</Pill>}
                    <div style={{ flex: 1 }} />
                    <button type="button" style={{ ...btnStyle, padding: '1px 7px', fontSize: 11 }} onClick={() => {
                      setKnowledgeDraft(fact)
                      const draft: Record<string, 'knows' | 'suspects' | 'misbelieves' | 'unaware' | 'none'> = {}
                      for (const knower of fact.knowers) draft[knower.entityId] = knower.state
                      setKnowerDraft(draft)
                    }}>编辑</button>
                    <button type="button" style={{ ...btnStyle, padding: '1px 7px', fontSize: 11, color: C.danger }} onClick={() => { void deleteKnowledge(fact.id) }}>删除</button>
                  </div>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 5 }}>
                    {fact.knowers.length === 0 && <span style={{ color: C.muted, fontSize: 11.5 }}>还没有记录谁知道</span>}
                    {fact.knowers.map(knower => (
                      <Pill key={knower.entityId} color={knower.state === 'knows' ? C.ok : knower.state === 'unaware' ? C.muted : C.warn}>
                        {knower.name}：{text(knower.state)}
                      </Pill>
                    ))}
                  </div>
                  {fact.notes && <div style={{ color: C.muted, fontSize: 11.5, marginTop: 4 }}>{fact.notes}</div>}
                </div>
              ))}
            </div>
          )}

          {tab === 'ingest' && (
            <div style={{ padding: '10px 16px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 14 }}>
              <div>
                <div style={{ color: C.muted, fontSize: 11.5, lineHeight: 1.8, marginBottom: 8 }}>
                  AI 只抽素材里写明的内容，每条都要能在原文找到证据，编造的会被丢弃；默认只生成待审批提议，不会直接改正式资料。
                </div>
                <input style={{ ...inputStyle, marginBottom: 8 }} value={materialTitle} onChange={event => setMaterialTitle(event.target.value)} placeholder="这批素材的标题（可选）" />
                <input style={{ ...inputStyle, marginBottom: 8 }} value={materialFocus} onChange={event => setMaterialFocus(event.target.value)} placeholder="整理重点（可选），例如：只抽人物与势力" />
                <textarea
                  value={material}
                  onChange={event => setMaterial(event.target.value)}
                  placeholder="把人物小传、世界观笔记、剧情梗概、正文片段贴进来（≥20 字）…"
                  style={{ ...inputStyle, minHeight: 260, lineHeight: 1.8, resize: 'vertical' }}
                />
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                  <select value={materialMode} onChange={event => setMaterialMode(event.target.value === 'apply' ? 'apply' : 'propose')} style={{ ...btnStyle }}>
                    <option value="propose">只生成提议</option>
                    <option value="apply">同时应用</option>
                  </select>
                  <button type="button" style={{ ...btnStyle, borderColor: 'rgba(216,166,87,0.5)', color: C.accent }} disabled={busy !== null} onClick={() => { void runIngest() }}>
                    {busy === 'ingest' ? '分析中…' : '开始整理'}
                  </button>
                  <span style={{ color: C.muted, fontSize: 11 }}>{material.trim().length} 字符</span>
                </div>
              </div>
              <div>
                {ingestResult && (
                  <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: '9px 11px', marginBottom: 10, background: C.bg2 }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>本次结果</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      <Pill color={C.ok}>资料 {ingestResult.stats.entities}</Pill>
                      <Pill color={C.ok}>关系 {ingestResult.stats.relations}</Pill>
                      <Pill color={C.ok}>事件 {ingestResult.stats.events}</Pill>
                      <Pill color={C.ok}>伏笔 {ingestResult.stats.foreshadowing}</Pill>
                      <Pill color={C.ok}>剧情线 {ingestResult.stats.threads}</Pill>
                      <Pill color={C.ok}>知情 {ingestResult.stats.knowledge}</Pill>
                      {ingestResult.stats.dropped > 0 && <Pill color={C.warn}>丢弃 {ingestResult.stats.dropped}</Pill>}
                      {ingestResult.stats.conflicts > 0 && <Pill color={C.danger}>矛盾 {ingestResult.stats.conflicts}</Pill>}
                    </div>
                    {ingestResult.stats.dropped > 0 && (
                      <div style={{ marginTop: 6, color: C.muted, fontSize: 11, lineHeight: 1.7 }}>
                        丢弃原因：{Object.entries(ingestResult.stats.droppedReasons).map(([key, value]) => `${key}×${value}`).join('，')}
                      </div>
                    )}
                    {(ingestResult.stats.conflictList ?? []).length > 0 && (
                      <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
                        {ingestResult.stats.conflictList?.map((conflict, index) => (
                          <div key={index} style={{ color: C.warn, fontSize: 11.5 }}>· {conflict.type}：{conflict.description}</div>
                        ))}
                      </div>
                    )}
                    <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                      <button type="button" style={{ ...btnStyle, padding: '2px 8px', fontSize: 11 }} onClick={() => setTab('proposals')}>去审批</button>
                      <button type="button" style={{ ...btnStyle, padding: '2px 8px', fontSize: 11 }} disabled={busy !== null} onClick={() => { void applyBatch(ingestResult.batch.id) }}>应用全部</button>
                    </div>
                  </div>
                )}
                <div style={{ color: C.muted, fontSize: 11, marginBottom: 6 }}>历史批次</div>
                {batches.length === 0 && <div style={{ color: C.muted, fontSize: 12 }}>还没有导入记录。</div>}
                {batches.map(batch => (
                  <div key={batch.id} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: '7px 9px', marginBottom: 6, background: C.bg2 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ fontSize: 12 }}>{batch.title || '（未命名）'}</span>
                      <StatusPill status={batch.status} />
                      <div style={{ flex: 1 }} />
                      <span style={{ color: C.muted, fontSize: 10.5 }}>{shortTime(batch.createdAt)}</span>
                    </div>
                    <div style={{ color: C.muted, fontSize: 11, marginTop: 3 }}>
                      {batch.sourceText.length} 字符 · {batch.mode === 'apply' ? '直接应用' : '仅提议'}
                    </div>
                    {['ready', 'partially_applied'].includes(batch.status) && (
                      <button type="button" style={{ ...btnStyle, marginTop: 5, padding: '2px 8px', fontSize: 11 }} disabled={busy !== null} onClick={() => { void applyBatch(batch.id) }}>应用这批</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'proposals' && (
            <div style={{ padding: '6px 10px' }}>
              {proposals.length === 0 && <div style={{ padding: 16, color: C.muted }}>没有待审批的变更。AI 只能提议，应用必须由你点。</div>}
              {proposals.map(proposal => (
                <div key={proposal.id} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: '8px 10px', marginBottom: 8, background: C.bg2 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Pill color={C.info}>{TARGET_TEXT[proposal.targetType] ?? proposal.targetType}</Pill>
                    <Pill>{proposal.operation === 'create' ? '新建' : '修改'}</Pill>
                    <Pill color={proposal.source === 'ai_ingest' ? C.accent : C.muted}>{proposal.source === 'ai_ingest' ? '素材导入' : '手动'}</Pill>
                    <div style={{ flex: 1 }} />
                    <span style={{ color: C.muted, fontSize: 10.5 }}>{shortTime(proposal.createdAt)}</span>
                  </div>
                  <pre style={{ margin: '6px 0 0', color: C.dim, fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 160, overflow: 'auto' }}>
                    {proposal.payloadJson}
                  </pre>
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <button type="button" style={{ ...btnStyle, padding: '2px 9px', fontSize: 11, borderColor: 'rgba(108,192,139,0.45)', color: C.ok }} disabled={busy !== null} onClick={() => { void applyProposal(proposal.id) }}>应用</button>
                    <button type="button" style={{ ...btnStyle, padding: '2px 9px', fontSize: 11, color: C.muted }} disabled={busy !== null} onClick={() => { void rejectProposal(proposal.id) }}>驳回</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── 弹窗 ── */}
      {knowledgeDraft && (
        <Modal wide title={knowledgeDraft.id ? '编辑知情事实' : '记录知情事实'} onClose={() => { setKnowledgeDraft(null); setKnowerDraft({}) }}
          footer={<><button type="button" style={btnStyle} onClick={() => { setKnowledgeDraft(null); setKnowerDraft({}) }}>取消</button><button type="button" style={{ ...btnStyle, borderColor: 'rgba(216,166,87,0.5)', color: C.accent }} disabled={busy !== null} onClick={() => { void saveKnowledge() }}>保存</button></>}>
          <div style={{ display: 'grid', gap: 10 }}>
            <Field label="事实 / 秘密（一句话）"><input style={inputStyle} value={knowledgeDraft.proposition ?? ''} onChange={event => setKnowledgeDraft({ ...knowledgeDraft, proposition: event.target.value })} placeholder="例如：林渊每次回响会折寿" /></Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              <Field label="真相">
                <select style={inputStyle} value={knowledgeDraft.truth ?? 'true'} onChange={event => setKnowledgeDraft({ ...knowledgeDraft, truth: event.target.value })}>
                  <option value="true">属实</option><option value="partial">部分属实</option><option value="false">假消息</option>
                </select>
              </Field>
              <Field label="公开度">
                <select style={inputStyle} value={knowledgeDraft.publicLevel ?? 'secret'} onChange={event => setKnowledgeDraft({ ...knowledgeDraft, publicLevel: event.target.value })}>
                  <option value="secret">秘密</option><option value="circle">小圈</option><option value="organization">组织</option><option value="public">公开</option>
                </select>
              </Field>
              <Field label="首次涉及章节">
                <select style={inputStyle} value={knowledgeDraft.chapterId ?? ''} onChange={event => setKnowledgeDraft({ ...knowledgeDraft, chapterId: event.target.value || null })}>
                  <option value="">不指定</option>
                  {chapters.map(item => <option key={item.chapter.id} value={item.chapter.id}>第 {item.chapter.chapterNo} 章 {item.chapter.title}</option>)}
                </select>
              </Field>
            </div>
            <Field label="备注"><textarea style={{ ...inputStyle, minHeight: 60 }} value={knowledgeDraft.notes ?? ''} onChange={event => setKnowledgeDraft({ ...knowledgeDraft, notes: event.target.value })} /></Field>
            <div>
              <div style={{ color: C.muted, fontSize: 11, marginBottom: 6 }}>谁知道（人物 / 势力）</div>
              <div style={{ display: 'grid', gap: 6, maxHeight: 240, overflow: 'auto', border: `1px solid ${C.line}`, borderRadius: 8, padding: 8 }}>
                {entities.length === 0 && <div style={{ color: C.muted, fontSize: 12 }}>资料库里还没有人物，先去「资料」标签新建。</div>}
                {entities.map(entity => (
                  <div key={entity.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ flex: 1, fontSize: 12 }}>{entity.name}<span style={{ color: C.muted, fontSize: 11 }}> · {KIND_TEXT[entity.kind] ?? entity.kind}</span></span>
                    <select
                      style={{ ...inputStyle, width: 120 }}
                      value={knowerDraft[entity.id] ?? 'none'}
                      onChange={event => setKnowerDraft({ ...knowerDraft, [entity.id]: event.target.value as 'knows' })}
                    >
                      <option value="none">不涉及</option>
                      <option value="knows">知道</option>
                      <option value="suspects">怀疑</option>
                      <option value="misbelieves">误信</option>
                      <option value="unaware">不知道</option>
                    </select>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      )}

      {eventDraft && (
        <Modal title={eventDraft.id ? '编辑事件' : '新建事件'} onClose={() => setEventDraft(null)}
          footer={<><button type="button" style={btnStyle} onClick={() => setEventDraft(null)}>取消</button><button type="button" style={{ ...btnStyle, borderColor: 'rgba(216,166,87,0.5)', color: C.accent }} disabled={busy !== null} onClick={() => { void saveEvent() }}>保存</button></>}>
          <div style={{ display: 'grid', gap: 10 }}>
            <Field label="事件摘要"><textarea style={{ ...inputStyle, minHeight: 70 }} value={eventDraft.summary} onChange={event => setEventDraft({ ...eventDraft, summary: event.target.value })} /></Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="故事内时间"><input style={inputStyle} value={eventDraft.eventTime} onChange={event => setEventDraft({ ...eventDraft, eventTime: event.target.value })} placeholder="例如：第 11 天 03:40" /></Field>
              <Field label="状态">
                <select style={inputStyle} value={eventDraft.status} onChange={event => setEventDraft({ ...eventDraft, status: event.target.value })}>
                  <option value="confirmed">已发生</option><option value="planned">计划中</option><option value="draft">草稿</option><option value="cancelled">已取消</option>
                </select>
              </Field>
            </div>
          </div>
        </Modal>
      )}

      {shadowDraft && (
        <Modal title={shadowDraft.id ? '编辑伏笔' : '埋设伏笔'} onClose={() => setShadowDraft(null)}
          footer={<><button type="button" style={btnStyle} onClick={() => setShadowDraft(null)}>取消</button><button type="button" style={{ ...btnStyle, borderColor: 'rgba(216,166,87,0.5)', color: C.accent }} disabled={busy !== null} onClick={() => { void saveShadow() }}>保存</button></>}>
          <div style={{ display: 'grid', gap: 10 }}>
            <Field label="名称"><input style={inputStyle} value={shadowDraft.name ?? ''} onChange={event => setShadowDraft({ ...shadowDraft, name: event.target.value })} /></Field>
            <Field label="描述"><textarea style={{ ...inputStyle, minHeight: 70 }} value={shadowDraft.description ?? ''} onChange={event => setShadowDraft({ ...shadowDraft, description: event.target.value })} /></Field>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              <Field label="类型"><input style={inputStyle} value={shadowDraft.kind ?? ''} onChange={event => setShadowDraft({ ...shadowDraft, kind: event.target.value })} placeholder="道具/对话/场景" /></Field>
              <Field label="状态">
                <select style={inputStyle} value={shadowDraft.status ?? 'open'} onChange={event => setShadowDraft({ ...shadowDraft, status: event.target.value })}>
                  <option value="open">未回收</option><option value="reinforced">已强化</option><option value="payoff">已回收</option><option value="abandoned">已废弃</option>
                </select>
              </Field>
              <Field label="最晚回收章（章号）"><input style={inputStyle} type="number" min={1} value={shadowDraft.deadlineChapterId ?? ''} onChange={event => setShadowDraft({ ...shadowDraft, deadlineChapterId: event.target.value ? Number(event.target.value) : null })} /></Field>
            </div>
            <Field label="重要度 1–5"><input style={inputStyle} type="number" min={1} max={5} value={shadowDraft.importance ?? 3} onChange={event => setShadowDraft({ ...shadowDraft, importance: Number(event.target.value) })} /></Field>
            <Field label="备注"><textarea style={{ ...inputStyle, minHeight: 60 }} value={shadowDraft.notes ?? ''} onChange={event => setShadowDraft({ ...shadowDraft, notes: event.target.value })} /></Field>
          </div>
        </Modal>
      )}

      {outlineDraft && (
        <Modal title="编辑章纲（计划，不是已发生事实）" onClose={() => setOutlineDraft(null)}
          footer={<><button type="button" style={btnStyle} onClick={() => setOutlineDraft(null)}>取消</button><button type="button" style={{ ...btnStyle, borderColor: 'rgba(216,166,87,0.5)', color: C.accent }} disabled={busy !== null} onClick={() => { void saveOutline() }}>保存</button></>}>
          <div style={{ display: 'grid', gap: 10 }}>
            <Field label="本章摘要"><textarea style={{ ...inputStyle, minHeight: 60 }} value={outlineDraft.summary} onChange={event => setOutlineDraft({ ...outlineDraft, summary: event.target.value })} /></Field>
            <Field label="本章目标"><input style={inputStyle} value={outlineDraft.goal} onChange={event => setOutlineDraft({ ...outlineDraft, goal: event.target.value })} /></Field>
            <Field label="核心冲突"><input style={inputStyle} value={outlineDraft.conflict} onChange={event => setOutlineDraft({ ...outlineDraft, conflict: event.target.value })} /></Field>
            <Field label="章末钩子"><input style={inputStyle} value={outlineDraft.hook} onChange={event => setOutlineDraft({ ...outlineDraft, hook: event.target.value })} /></Field>
          </div>
        </Modal>
      )}

      {entityDetail && (
        <Modal wide title={`${entityDetail.name} 的状态与知情`} onClose={() => setEntityDetail(null)}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <div style={{ color: C.muted, fontSize: 11, marginBottom: 6 }}>按章状态快照（{entityStates.length}）</div>
              {entityStates.length === 0 && <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.8 }}>还没有快照。记录等级、伤势、持有物、位置，防止「重伤秒好」。</div>}
              <div style={{ display: 'grid', gap: 6, maxHeight: 220, overflow: 'auto' }}>
                {entityStates.map(state => (
                  <div key={state.id} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: '6px 9px', background: C.bg }}>
                    <div style={{ fontSize: 11.5, color: C.muted }}>{state.chapterId ? (chapters.find(item => item.chapter.id === state.chapterId)?.chapter.title ?? '未知章节') : '未指定章节'} · {shortTime(state.createdAt)}</div>
                    <div style={{ fontSize: 12.5, marginTop: 2 }}>{state.summary || '（无摘要）'}</div>
                    {state.stateJson !== '{}' && <pre style={{ margin: '4px 0 0', color: C.dim, fontSize: 11, whiteSpace: 'pre-wrap' }}>{state.stateJson}</pre>}
                  </div>
                ))}
              </div>
              {stateDraft && (
                <div style={{ marginTop: 10, borderTop: `1px solid ${C.line}`, paddingTop: 10, display: 'grid', gap: 8 }}>
                  <Field label="章节">
                    <select style={inputStyle} value={stateDraft.chapterId} onChange={event => setStateDraft({ ...stateDraft, chapterId: event.target.value })}>
                      <option value="">不指定</option>
                      {chapters.map(item => <option key={item.chapter.id} value={item.chapter.id}>第 {item.chapter.chapterNo} 章 {item.chapter.title}</option>)}
                    </select>
                  </Field>
                  <Field label="状态摘要"><input style={inputStyle} value={stateDraft.summary} onChange={event => setStateDraft({ ...stateDraft, summary: event.target.value })} placeholder="例如：左臂骨裂，青铜灯冷却中" /></Field>
                  <Field label="结构化状态（JSON，可留空）" hint='例如 {"level":"引气七层","injury":["左臂骨裂"],"items":["青铜灯"],"location":"归墟巷"}'>
                    <textarea style={{ ...inputStyle, minHeight: 70 }} value={stateDraft.stateJson} onChange={event => setStateDraft({ ...stateDraft, stateJson: event.target.value })} />
                  </Field>
                  <button type="button" style={{ ...btnStyle, borderColor: 'rgba(216,166,87,0.5)', color: C.accent }} disabled={busy !== null} onClick={() => { void saveEntityState() }}>记录快照</button>
                </div>
              )}
            </div>
            <div>
              <div style={{ color: C.muted, fontSize: 11, marginBottom: 6 }}>该角色相关的知情事实</div>
              {knowledge.filter(fact => fact.knowers.some(knower => knower.entityId === entityDetail.id)).length === 0 && (
                <div style={{ color: C.muted, fontSize: 12 }}>还没有记录。去「认知」标签补一条。</div>
              )}
              <div style={{ display: 'grid', gap: 6 }}>
                {knowledge
                  .filter(fact => fact.knowers.some(knower => knower.entityId === entityDetail.id))
                  .map(fact => {
                    const mine = fact.knowers.find(knower => knower.entityId === entityDetail.id)
                    return (
                      <div key={fact.id} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: '6px 9px', background: C.bg }}>
                        <div style={{ fontSize: 12.5 }}>{fact.proposition}</div>
                        <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                          {mine ? text(mine.state) : ''} · 公开度 {text(fact.publicLevel)}
                        </div>
                      </div>
                    )
                  })}
              </div>
              <div style={{ color: C.muted, fontSize: 11, margin: '12px 0 6px' }}>与该角色相关的关系</div>
              {relations.filter(relation => relation.sourceName === entityDetail.name || relation.targetName === entityDetail.name).length === 0
                ? <div style={{ color: C.muted, fontSize: 12 }}>还没有关系记录。</div>
                : relations.filter(relation => relation.sourceName === entityDetail.name || relation.targetName === entityDetail.name).map(relation => (
                  <div key={relation.id} style={{ fontSize: 12, color: C.dim, marginBottom: 3 }}>
                    {relation.sourceName} —{relation.kind}→ {relation.targetName}
                    {relation.tension ? `（${relation.tension}）` : ''}
                  </div>
                ))}
            </div>
          </div>
        </Modal>
      )}

      {entityDraft && (
        <Modal wide title={entityDraft.id ? `编辑：${entityDraft.name ?? ''}` : '新建人物 / 设定'} onClose={() => setEntityDraft(null)}
          footer={<><button type="button" style={btnStyle} onClick={() => setEntityDraft(null)}>取消</button><button type="button" style={{ ...btnStyle, borderColor: 'rgba(216,166,87,0.5)', color: C.accent }} disabled={busy !== null} onClick={() => { void saveEntity() }}>保存</button></>}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="名称"><input style={inputStyle} value={entityDraft.name ?? ''} onChange={event => setEntityDraft({ ...entityDraft, name: event.target.value })} /></Field>
            <Field label="类型">
              <select style={inputStyle} value={entityDraft.kind ?? 'character'} onChange={event => setEntityDraft({ ...entityDraft, kind: event.target.value })}>
                {Object.entries(KIND_TEXT).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </Field>
            <Field label="定位（主角/反派/配角…）"><input style={inputStyle} value={entityDraft.role ?? ''} onChange={event => setEntityDraft({ ...entityDraft, role: event.target.value })} /></Field>
            <Field label="状态">
              <select style={inputStyle} value={entityDraft.status ?? 'confirmed'} onChange={event => setEntityDraft({ ...entityDraft, status: event.target.value })}>
                <option value="confirmed">已确认</option><option value="planned">计划中</option><option value="draft">草稿</option><option value="cancelled">已取消</option>
              </select>
            </Field>
            <Field label="一句话简介"><input style={inputStyle} value={entityDraft.summary ?? ''} onChange={event => setEntityDraft({ ...entityDraft, summary: event.target.value })} /></Field>
            <Field label="重要度 1–5"><input style={inputStyle} type="number" min={1} max={5} value={entityDraft.importance ?? 3} onChange={event => setEntityDraft({ ...entityDraft, importance: Number(event.target.value) })} /></Field>
            <Field label="目标"><input style={inputStyle} value={entityDraft.goal ?? ''} onChange={event => setEntityDraft({ ...entityDraft, goal: event.target.value })} /></Field>
            <Field label="动机"><input style={inputStyle} value={entityDraft.motivation ?? ''} onChange={event => setEntityDraft({ ...entityDraft, motivation: event.target.value })} /></Field>
            <Field label="缺陷"><input style={inputStyle} value={entityDraft.flaw ?? ''} onChange={event => setEntityDraft({ ...entityDraft, flaw: event.target.value })} /></Field>
            <Field label="秘密"><input style={inputStyle} value={entityDraft.secret ?? ''} onChange={event => setEntityDraft({ ...entityDraft, secret: event.target.value })} /></Field>
            <Field label="说话方式"><input style={inputStyle} value={entityDraft.voice ?? ''} onChange={event => setEntityDraft({ ...entityDraft, voice: event.target.value })} /></Field>
            <Field label="人物弧光"><input style={inputStyle} value={entityDraft.arc ?? ''} onChange={event => setEntityDraft({ ...entityDraft, arc: event.target.value })} /></Field>
          </div>
        </Modal>
      )}

      {newChapterTitle !== null && (
        <Modal title="新建章节" onClose={() => setNewChapterTitle(null)}
          footer={<><button type="button" style={btnStyle} onClick={() => setNewChapterTitle(null)}>取消</button><button type="button" style={{ ...btnStyle, borderColor: 'rgba(216,166,87,0.5)', color: C.accent }} disabled={busy !== null} onClick={() => { void createChapter() }}>创建</button></>}>
          <Field label="章节标题"><input autoFocus style={inputStyle} value={newChapterTitle} onChange={event => setNewChapterTitle(event.target.value)} placeholder="例如：雨夜访客" /></Field>
        </Modal>
      )}

      {threadDraft && (
        <Modal title={threadDraft.id ? '编辑剧情线' : '新建剧情线'} onClose={() => setThreadDraft(null)}
          footer={<><button type="button" style={btnStyle} onClick={() => setThreadDraft(null)}>取消</button><button type="button" style={{ ...btnStyle, borderColor: 'rgba(216,166,87,0.5)', color: C.accent }} disabled={busy !== null} onClick={() => { void saveThread() }}>保存</button></>}>
          <div style={{ display: 'grid', gap: 10 }}>
            <Field label="名称"><input style={inputStyle} value={threadDraft.name ?? ''} onChange={event => setThreadDraft({ ...threadDraft, name: event.target.value })} /></Field>
            <Field label="类型">
              <select style={inputStyle} value={threadDraft.kind ?? 'main'} onChange={event => setThreadDraft({ ...threadDraft, kind: event.target.value })}>
                {Object.entries(THREAD_TEXT).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </Field>
            <Field label="目标"><input style={inputStyle} value={threadDraft.goal ?? ''} onChange={event => setThreadDraft({ ...threadDraft, goal: event.target.value })} /></Field>
            <Field label="简介"><textarea style={{ ...inputStyle, minHeight: 70 }} value={threadDraft.summary ?? ''} onChange={event => setThreadDraft({ ...threadDraft, summary: event.target.value })} /></Field>
            <Field label="状态">
              <select style={inputStyle} value={threadDraft.status ?? 'active'} onChange={event => setThreadDraft({ ...threadDraft, status: event.target.value })}>
                <option value="active">进行中</option><option value="advancing">推进中</option><option value="paused">暂停</option><option value="resolved">已结束</option><option value="abandoned">已放弃</option>
              </select>
            </Field>
          </div>
        </Modal>
      )}

      {relationDraft && (
        <Modal title="新建人物关系" onClose={() => setRelationDraft(null)}
          footer={<><button type="button" style={btnStyle} onClick={() => setRelationDraft(null)}>取消</button><button type="button" style={{ ...btnStyle, borderColor: 'rgba(216,166,87,0.5)', color: C.accent }} disabled={busy !== null || (!relationDraft.id && (!relationDraft.sourceId || !relationDraft.targetId))} onClick={() => { void saveRelation() }}>保存</button></>}>
          <div style={{ display: 'grid', gap: 10 }}>
            {relationDraft.id && <div style={{ color: C.muted, fontSize: 11 }}>两端不可改（如需换人，删掉重建）。</div>}
            {!relationDraft.id && (<Field label="起点">
              <select style={inputStyle} value={relationDraft.sourceId} onChange={event => setRelationDraft({ ...relationDraft, sourceId: event.target.value })}>
                <option value="">选择…</option>
                {entities.map(entity => <option key={entity.id} value={entity.id}>{entity.name}</option>)}
              </select>
            </Field>)}
            {!relationDraft.id && (<Field label="终点">
              <select style={inputStyle} value={relationDraft.targetId} onChange={event => setRelationDraft({ ...relationDraft, targetId: event.target.value })}>
                <option value="">选择…</option>
                {entities.map(entity => <option key={entity.id} value={entity.id}>{entity.name}</option>)}
              </select>
            </Field>)}
            <Field label="关系类型"><input style={inputStyle} value={relationDraft.kind} onChange={event => setRelationDraft({ ...relationDraft, kind: event.target.value })} placeholder="搭档 / 师徒 / 敌对 / 父子…" /></Field>
            <Field label="张力"><input style={inputStyle} value={relationDraft.tension} onChange={event => setRelationDraft({ ...relationDraft, tension: event.target.value })} placeholder="例如：曾隐瞒上级命令" /></Field>
          </div>
        </Modal>
      )}
    </div>
  )
}

export function NovelForgeIcon() {
  return <span style={{ fontSize: 14, lineHeight: 1 }} aria-hidden>墨</span>
}
