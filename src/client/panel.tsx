/**
 * NovelForge 内嵌面板（DSH Web GUI 客户端插件）。
 *
 * 只依赖 React（DSH 基座提供），不引入任何额外运行时依赖。
 * 数据来自本机 NovelForge 工作台服务（宿主插件自动启动，默认 127.0.0.1:4319）。
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

// ── 类型（与 src/database/store.ts 返回结构一致）─────────────────
interface Project { id: string; title: string; genre: string; premise: string; pov: string; tense: string; status: string }
interface OverviewCounts { chapters: number; finalizedChapters: number; entities: number; foreshadowingOpen: number; threads: number; relations: number; scenes: number; openIssues: number; pendingProposals: number; ingestBatches: number }
interface ProjectOverview { project: Project; counts: OverviewCounts }
interface ChapterSummary {
  chapter: { id: string; chapterNo: number; title: string; status: string; updatedAt: string; summary?: string }
  revisionCount: number
  latest: { revisionNo: number; status: string; kind: string; words: number; createdAt: string } | null
}
interface Entity {
  id: string; kind: string; name: string; summary: string; status: string
  role: string; goal: string; motivation: string; flaw: string; secret: string; voice: string; arc: string
  importance: number; aliasesJson: string
}
interface StoryEvent { id: string; summary: string; eventTime: string; status: string; participantsJson: string }
interface Foreshadowing { id: string; name: string; description: string; status: string; kind: string; importance: number }
interface PlotThread { id: string; name: string; kind: string; goal: string; summary: string; status: string }
interface Relation { id: string; sourceName: string; targetName: string; kind: string; tension: string; status: string }
interface Scene { id: string; sceneNo: number; beat: string; goal: string; conflict: string; outcome: string; castNames: string[] }
interface SearchHit { recordId: string; recordType: string; status: string; snippet: string }
interface ChapterDetail {
  chapter: { id: string; chapterNo: number; title: string; status: string; summary: string }
  latestRevision: { id: string; revisionNo: number; content: string; status: string; kind: string } | null
  latestReview: { run: { status: string }; issues: Array<{ id: string; severity: string; issue: string }> } | null
}

type Tab = 'chapters' | 'entities' | 'threads' | 'relations' | 'timeline' | 'foreshadowing'

// ── 数据访问：带重试的服务发现 ────────────────────────────────

let cachedBase: string | null = null

async function probe(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
    if (!response.ok) return null
    const payload = await response.json() as { ok?: boolean; data?: { version?: string } }
    if (payload.ok && payload.data?.version) return `http://127.0.0.1:${port}`
    return null
  } catch {
    return null
  }
}

/**
 * 面板可能在宿主插件完成启动前就渲染，所以不能只探测一次；
 * 这里按退避重试若干轮，避免「服务其实已经起来但面板显示连不上」。
 */
async function discoverBase(force = false): Promise<string> {
  if (cachedBase && !force) return cachedBase
  for (let round = 0; round < RETRY_DELAYS.length; round += 1) {
    for (const port of CANDIDATE_PORTS) {
      const base = await probe(port)
      if (base) {
        cachedBase = base
        return base
      }
    }
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[round]))
  }
  cachedBase = null
  throw new Error('连不上 NovelForge 本地服务（端口 4319–4331）。\n· 确认插件已启用：设置 → 插件 → novelforge-dsh\n· 或手动启动：npx novelforge-dsh studio')
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

// ── 基础小件 ────────────────────────────────────────────────

const STATUS_TEXT: Record<string, string> = {
  planned: '计划中', context_ready: '上下文就绪', draft_generated: '草稿', manual_draft: '人工草稿',
  revising: '修订中', reviewing: '审查中', awaiting_approval: '待定稿', needs_author_decision: '待决策',
  finalized: '已定稿', open: '未回收', reinforced: '已强化', payoff: '已回收', abandoned: '已废弃',
  confirmed: '已确认', draft: '草稿', cancelled: '已取消', active: '进行中', paused: '已暂停', resolved: '已解决',
}

const KIND_TEXT: Record<string, string> = {
  character: '人物', world_rule: '规则', location: '地点', faction: '势力', item: '物品', ability: '能力', other: '其它',
}

const THREAD_TEXT: Record<string, string> = {
  main: '主线', sub: '支线', romance: '感情', mystery: '悬疑', revenge: '复仇', growth: '成长',
}

function text(value: string): string { return STATUS_TEXT[value] ?? value }

function toneOf(status: string): string {
  if (['finalized', 'confirmed', 'resolved', 'payoff', 'active'].includes(status)) return C.ok
  if (['failed', 'rejected', 'critical', 'cancelled'].includes(status)) return C.danger
  if (['pending', 'awaiting_approval', 'needs_author_decision', 'revising', 'reviewing', 'open'].includes(status)) return C.warn
  if (['planned', 'draft', 'draft_generated', 'manual_draft'].includes(status)) return C.info
  return C.muted
}

function Pill({ children, color }: { children: ReactNode; color?: string }) {
  const tone = color ?? C.muted
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '0 7px', borderRadius: 999,
      border: `1px solid ${tone}`, color: tone, fontSize: 11, lineHeight: '18px', whiteSpace: 'nowrap',
    }}>{children}</span>
  )
}

function StatusPill({ status }: { status: string }) {
  return <Pill color={toneOf(status)}>{text(status)}</Pill>
}

const btn: React.CSSProperties = {
  border: `1px solid ${C.line}`, background: C.bg3, color: C.text, borderRadius: 8,
  padding: '4px 10px', fontSize: 12, cursor: 'pointer', font: 'inherit',
}

function Row({ children, onClick, active }: { children: ReactNode; onClick?: () => void; active?: boolean }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: '8px 10px', borderRadius: 8, cursor: onClick ? 'pointer' : 'default',
        background: active ? 'rgba(216,166,87,0.12)' : 'transparent',
        border: `1px solid ${active ? 'rgba(216,166,87,0.38)' : 'transparent'}`,
      }}
      onMouseEnter={event => { if (onClick && !active) (event.currentTarget as HTMLDivElement).style.background = C.bg3 }}
      onMouseLeave={event => { if (!active) (event.currentTarget as HTMLDivElement).style.background = 'transparent' }}
    >{children}</div>
  )
}

function StatCard({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: string }) {
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: '8px 11px', background: C.bg2, minWidth: 78 }}>
      <div style={{ color: C.muted, fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: tone ?? C.text, lineHeight: 1.3 }}>{value}</div>
      {hint && <div style={{ color: C.muted, fontSize: 10.5 }}>{hint}</div>}
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
  const [hits, setHits] = useState<SearchHit[]>([])
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<Tab>('chapters')
  const [reader, setReader] = useState<ChapterDetail | null>(null)
  const [readerScenes, setReaderScenes] = useState<Scene[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const mounted = useRef(true)
  const projectIdRef = useRef('')

  useEffect(() => () => { mounted.current = false }, [])

  const loadProject = useCallback(async (id: string): Promise<void> => {
    setError(null)
    try {
      const encoded = encodeURIComponent(id)
      const [detail, chapterList, entityList, threadList, relationList, eventList, shadowList] = await Promise.all([
        apiGet<ProjectOverview>(`/api/projects/${encoded}`),
        apiGet<ChapterSummary[]>(`/api/projects/${encoded}/chapter-summaries`),
        apiGet<Entity[]>(`/api/projects/${encoded}/entities`),
        apiGet<PlotThread[]>(`/api/projects/${encoded}/threads`),
        apiGet<Relation[]>(`/api/projects/${encoded}/relations`),
        apiGet<StoryEvent[]>(`/api/projects/${encoded}/events`),
        apiGet<Foreshadowing[]>(`/api/projects/${encoded}/foreshadowing`),
      ])
      if (!mounted.current) return
      setOverview(detail)
      setChapters(chapterList)
      setEntities(entityList)
      setThreads(threadList)
      setRelations(relationList)
      setEvents(eventList)
      setForeshadowing(shadowList)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const list = await apiGet<Project[]>('/api/projects')
      if (!mounted.current) return
      setProjects(list)
      const next = projectIdRef.current && list.some(item => item.id === projectIdRef.current)
        ? projectIdRef.current
        : (list[0]?.id ?? '')
      projectIdRef.current = next
      setProjectId(next)
      if (next) await loadProject(next)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [loadProject])

  // 依赖 attempt：点「重新连接」时重跑
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

  const project = useMemo(() => projects.find(item => item.id === projectId) ?? null, [projects, projectId])
  const counts = overview?.counts
  const characters = useMemo(() => entities.filter(item => item.kind === 'character'), [entities])
  const others = useMemo(() => entities.filter(item => item.kind !== 'character'), [entities])

  const openChapter = (id: string): void => {
    setReader(null)
    setReaderScenes([])
    void apiGet<ChapterDetail>(`/api/chapters/${encodeURIComponent(id)}`)
      .then(detail => {
        if (!mounted.current) return
        setReader(detail)
        void apiGet<Scene[]>(`/api/chapters/${encodeURIComponent(id)}/scenes`).then(setReaderScenes).catch(() => setReaderScenes([]))
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  const openWorkbench = (): void => {
    void discoverBase().then(base => { window.open(base, '_blank', 'noopener') }).catch(cause => {
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const retry = (): void => {
    cachedBase = null
    setLoading(true)
    setAttempt(value => value + 1)
  }

  // —— 章节阅读 ——
  if (reader) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: `1px solid ${C.line}`, flexWrap: 'wrap' }}>
          <button type="button" style={btn} onClick={() => setReader(null)}>← 返回</button>
          <div style={{ fontWeight: 600 }}>第 {reader.chapter.chapterNo} 章 {reader.chapter.title}</div>
          <StatusPill status={reader.chapter.status} />
          {reader.latestRevision && <Pill>v{reader.latestRevision.revisionNo} · {reader.latestRevision.content.length} 字符</Pill>}
          {reader.latestReview && <Pill color={C.warn}>审查 {text(reader.latestReview.run.status)} · {reader.latestReview.issues.length} 问题</Pill>}
          <div style={{ flex: 1 }} />
          <button type="button" style={btn} onClick={openWorkbench}>完整工作台</button>
        </div>
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div style={{ flex: 1, overflow: 'auto', padding: '22px 28px', lineHeight: 1.95, fontSize: 15.5, fontFamily: 'var(--dsw-alias-font-serif, "Songti SC", "Source Han Serif SC", Georgia, serif)', whiteSpace: 'pre-wrap' }}>
            {reader.chapter.summary && (
              <div style={{ marginBottom: 16, padding: '8px 12px', border: `1px solid ${C.line}`, borderRadius: 8, color: C.dim, fontSize: 13, fontFamily: 'inherit', whiteSpace: 'normal' }}>
                章节摘要：{reader.chapter.summary}
              </div>
            )}
            {reader.latestRevision?.content ?? '这一章还没有正文。到完整工作台里写，或让模型生成草稿。'}
          </div>
          {readerScenes.length > 0 && (
            <div style={{ width: 280, borderLeft: `1px solid ${C.line}`, overflow: 'auto', padding: '12px 14px', background: C.bg2 }}>
              <div style={{ color: C.muted, fontSize: 11, letterSpacing: 1, marginBottom: 8 }}>场景 / 节拍 {readerScenes.length}</div>
              {readerScenes.map(scene => (
                <div key={scene.id} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: '8px 10px', marginBottom: 8, background: C.bg }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ color: C.accent, fontSize: 11 }}>S{scene.sceneNo}</span>
                    {scene.beat && <Pill>{scene.beat}</Pill>}
                  </div>
                  {scene.goal && <div style={{ fontSize: 12, marginTop: 4 }}>目标：{scene.goal}</div>}
                  {scene.conflict && <div style={{ fontSize: 12, color: C.dim }}>冲突：{scene.conflict}</div>}
                  {scene.outcome && <div style={{ fontSize: 12, color: C.dim }}>结果：{scene.outcome}</div>}
                  {scene.castNames.length > 0 && <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>{scene.castNames.join('、')}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  const tabs: Array<[Tab, string, number]> = [
    ['chapters', '章节', chapters.length],
    ['entities', '资料', entities.length],
    ['threads', '剧情线', threads.length],
    ['relations', '关系', relations.length],
    ['timeline', '时间线', events.length],
    ['foreshadowing', '伏笔', foreshadowing.length],
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text, fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: `1px solid ${C.line}`, flexWrap: 'wrap' }}>
        <strong style={{ fontFamily: 'var(--dsw-alias-font-serif, "Songti SC", Georgia, serif)', letterSpacing: '0.04em' }}>NovelForge</strong>
        <select
          value={projectId}
          onChange={event => { const id = event.target.value; projectIdRef.current = id; setProjectId(id); setReader(null); void loadProject(id) }}
          style={{ ...btn, maxWidth: 240 }}
        >
          {projects.length === 0 && <option value="">（暂无项目）</option>}
          {projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索章节、人物、事件、伏笔…"
          style={{ ...btn, width: 260, fontWeight: 'normal' }}
        />
        <div style={{ flex: 1 }} />
        {project && <span style={{ color: C.muted }}>{project.genre}{project.pov ? ` · ${project.pov}` : ''}</span>}
        <button type="button" style={btn} onClick={() => { cachedBase = null; void refresh() }}>刷新</button>
        <button type="button" style={{ ...btn, borderColor: 'rgba(216,166,87,0.45)', color: C.accent }} onClick={openWorkbench}>完整工作台</button>
      </div>

      {counts && (
        <div style={{ display: 'flex', gap: 8, padding: '10px 16px', borderBottom: `1px solid ${C.line}`, overflowX: 'auto' }}>
          <StatCard label="章节" value={counts.chapters} hint={`已定稿 ${counts.finalizedChapters}`} />
          <StatCard label="人物" value={characters.length} hint={`设定 ${others.length}`} />
          <StatCard label="剧情线" value={counts.threads} />
          <StatCard label="关系" value={counts.relations} />
          <StatCard label="场景" value={counts.scenes} />
          <StatCard label="未回收伏笔" value={counts.foreshadowingOpen} tone={counts.foreshadowingOpen ? C.warn : undefined} />
          <StatCard label="待审批" value={counts.pendingProposals} tone={counts.pendingProposals ? C.warn : undefined} />
          <StatCard label="审查问题" value={counts.openIssues} tone={counts.openIssues ? C.danger : undefined} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, padding: '8px 16px', borderBottom: `1px solid ${C.line}`, flexWrap: 'wrap' }}>
        {tabs.map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            style={{
              ...btn,
              background: tab === key ? 'rgba(216,166,87,0.14)' : 'transparent',
              borderColor: tab === key ? 'rgba(216,166,87,0.45)' : C.line,
              color: tab === key ? C.accent : C.dim,
            }}
          >{label} {count}</button>
        ))}
      </div>

      {error && (
        <div style={{ margin: '10px 16px', padding: '10px 12px', border: `1px solid ${C.danger}`, borderRadius: 8, color: C.danger, whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
          <div style={{ marginBottom: 8 }}>{error}</div>
          <button type="button" style={btn} onClick={retry}>重新连接</button>
        </div>
      )}
      {loading && <div style={{ padding: 16, color: C.muted }}>正在连接 NovelForge 本地服务…（服务刚启动时会自动重试约 20 秒）</div>}

      {!loading && !error && projects.length === 0 && (
        <div style={{ padding: 24, color: C.muted, lineHeight: 1.9 }}>
          还没有小说项目。<br />点「完整工作台」在新窗口创建，或在对话里说「新建一本小说」。
        </div>
      )}

      {!loading && query.trim() && (
        <div style={{ overflow: 'auto', padding: '6px 10px' }}>
          <div style={{ padding: '4px 8px', color: C.muted, fontSize: 11 }}>搜索「{query.trim()}」命中 {hits.length} 条</div>
          {hits.map(hit => (
            <Row key={hit.recordId}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Pill color={C.info}>{KIND_TEXT[hit.recordType] ?? hit.recordType}</Pill>
                <StatusPill status={hit.status} />
              </div>
              <div style={{ marginTop: 3, color: C.dim, whiteSpace: 'pre-wrap' }}>{hit.snippet.slice(0, 240)}</div>
            </Row>
          ))}
        </div>
      )}

      {!loading && !query.trim() && (
        <div style={{ overflow: 'auto', flex: 1 }}>
          {tab === 'chapters' && (
            <div style={{ padding: '6px 10px' }}>
              {chapters.length === 0 && <div style={{ padding: 16, color: C.muted }}>还没有章节。到完整工作台规划大纲或手动新建。</div>}
              {chapters.map(item => (
                <Row key={item.chapter.id} onClick={() => openChapter(item.chapter.id)}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ color: C.muted, fontVariantNumeric: 'tabular-nums', minWidth: 30 }}>{item.chapter.chapterNo}</span>
                    <span style={{ fontFamily: 'var(--dsw-alias-font-serif, "Songti SC", Georgia, serif)' }}>{item.chapter.title}</span>
                    <StatusPill status={item.chapter.status} />
                    <div style={{ flex: 1 }} />
                    <span style={{ color: C.muted, fontSize: 11 }}>{item.latest ? `${item.latest.words} 字` : '无正文'} · v{item.latest?.revisionNo ?? 0}</span>
                  </div>
                  {item.chapter.summary && <div style={{ color: C.muted, fontSize: 11.5, marginTop: 2 }}>{item.chapter.summary.slice(0, 60)}</div>}
                </Row>
              ))}
            </div>
          )}

          {tab === 'entities' && (
            <div style={{ padding: '6px 10px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 8 }}>
              {entities.length === 0 && <div style={{ padding: 16, color: C.muted }}>资料库还是空的。到「素材导入」页贴一段设定，让 AI 抽成结构化资料。</div>}
              {characters.map(entity => (
                <div key={entity.id} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: '9px 11px', background: C.bg2 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong>{entity.name}</strong>
                    {entity.role && <Pill color={C.accent}>{entity.role}</Pill>}
                    <StatusPill status={entity.status} />
                  </div>
                  {entity.goal && <div style={{ color: C.dim, marginTop: 4, fontSize: 12 }}>目标：{entity.goal}</div>}
                  {entity.summary && <div style={{ color: C.muted, marginTop: 3, fontSize: 11.5 }}>{entity.summary.slice(0, 80)}</div>}
                  {(entity.flaw || entity.secret) && (
                    <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {entity.flaw && <Pill color={C.warn}>缺陷 {entity.flaw.slice(0, 12)}</Pill>}
                      {entity.secret && <Pill color={C.info}>秘密 {entity.secret.slice(0, 12)}</Pill>}
                    </div>
                  )}
                </div>
              ))}
              {others.map(entity => (
                <div key={entity.id} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: '9px 11px', background: C.bg2 }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong>{entity.name}</strong>
                    <Pill color={C.info}>{KIND_TEXT[entity.kind] ?? entity.kind}</Pill>
                    <StatusPill status={entity.status} />
                  </div>
                  <div style={{ color: C.dim, marginTop: 4, fontSize: 12 }}>{entity.summary || '（无简介）'}</div>
                </div>
              ))}
            </div>
          )}

          {tab === 'threads' && (
            <div style={{ padding: '6px 10px' }}>
              {threads.length === 0 && <div style={{ padding: 16, color: C.muted }}>还没有剧情线。主线和支线是长篇不跑偏的骨架，建议先立 3–5 条。</div>}
              {threads.map(thread => (
                <Row key={thread.id}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Pill color={thread.kind === 'main' ? C.accent : C.info}>{THREAD_TEXT[thread.kind] ?? thread.kind}</Pill>
                    <strong style={{ fontWeight: 500 }}>{thread.name}</strong>
                    <StatusPill status={thread.status} />
                  </div>
                  {thread.goal && <div style={{ color: C.dim, fontSize: 12, marginTop: 3 }}>目标：{thread.goal}</div>}
                  {thread.summary && <div style={{ color: C.muted, fontSize: 11.5, marginTop: 2 }}>{thread.summary.slice(0, 100)}</div>}
                </Row>
              ))}
            </div>
          )}

          {tab === 'relations' && (
            <div style={{ padding: '6px 10px' }}>
              {relations.length === 0 && <div style={{ padding: 16, color: C.muted }}>还没有人物关系。关系张力是冲突的来源，AI 从素材里能抽出来。</div>}
              {relations.map(relation => (
                <Row key={relation.id}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong style={{ fontWeight: 500 }}>{relation.sourceName}</strong>
                    <span style={{ color: C.muted }}>—{relation.kind}→</span>
                    <strong style={{ fontWeight: 500 }}>{relation.targetName}</strong>
                    {relation.status !== 'active' && <StatusPill status={relation.status} />}
                  </div>
                  {relation.tension && <div style={{ color: C.dim, fontSize: 12, marginTop: 3 }}>张力：{relation.tension}</div>}
                </Row>
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
                    <StatusPill status={event.status} />
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
                    <StatusPill status={item.status} />
                    {item.kind && <Pill>{item.kind}</Pill>}
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
