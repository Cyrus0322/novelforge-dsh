import type {
  AuditEntry, ChangeProposal, Chapter, ChapterDetail, ChapterRevision, ChapterSummary, CompareResult, ContextMeta,
  ContextPack, Entity, Foreshadowing, HealthInfo, IngestBatch, IngestOutcome, KnowledgeFact, Outline, PlotThread, Project,
  ProjectOverview, Relation, ReviewIssue, ReviewRun, ReviewRunSummary, Scene, SearchResult, StoryEvent, WorkflowRun,
} from './types.ts'

const TOKEN_KEY = 'novelforge.studio.token'

function readToken(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('token')
  if (fromQuery) {
    window.sessionStorage.setItem(TOKEN_KEY, fromQuery)
    return fromQuery
  }
  return window.sessionStorage.getItem(TOKEN_KEY) ?? ''
}

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly details?: unknown) {
    super(message)
    this.name = 'ApiError'
  }
}

interface Envelope<T> { ok: boolean; data?: T; error?: { code: string; message: string; details?: unknown } }

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const token = readToken()
  if (token) headers['x-novelforge-token'] = token
  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    throw new ApiError('NETWORK', `无法连接 NovelForge 本地服务：${error instanceof Error ? error.message : String(error)}`, 0)
  }
  const text = await response.text()
  let envelope: Envelope<T>
  try {
    envelope = JSON.parse(text) as Envelope<T>
  } catch {
    throw new ApiError('BAD_RESPONSE', `服务返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 200)}`, response.status)
  }
  if (!response.ok || !envelope.ok) {
    throw new ApiError(envelope.error?.code ?? 'HTTP_ERROR', envelope.error?.message ?? `请求失败（HTTP ${response.status}）`, response.status, envelope.error?.details)
  }
  return envelope.data as T
}

/** 导出接口返回 Markdown 文本而不是 JSON 信封。 */
async function requestText(path: string): Promise<string> {
  const token = readToken()
  const response = await fetch(path, { headers: token ? { 'x-novelforge-token': token } : {} })
  const text = await response.text()
  if (!response.ok) throw new ApiError('HTTP_ERROR', `导出失败（HTTP ${response.status}）`, response.status)
  return text
}

const enc = encodeURIComponent

export const api = {
  health: () => request<HealthInfo>('GET', '/api/health'),

  listProjects: () => request<Project[]>('GET', '/api/projects'),
  createProject: (input: { title: string; genre: string; premise?: string; styleGuide?: string }) =>
    request<Project>('POST', '/api/projects', input),
  getOverview: (projectId: string) => request<ProjectOverview>('GET', `/api/projects/${enc(projectId)}`),
  updateProject: (projectId: string, patch: Partial<Pick<Project,
    'title' | 'genre' | 'premise' | 'styleGuide' | 'status' | 'pov' | 'tense' | 'chapterWordsMin' | 'chapterWordsMax' | 'targetChapters'
  >> & { themes?: string[]; expectedVersion?: number }) =>
    request<Project>('PATCH', `/api/projects/${enc(projectId)}`, patch),
  generateSetting: (idea: string) =>
    request<{ project: Project; blueprint: unknown }>('POST', '/api/projects/generate', { idea }),
  audit: (projectId: string, limit = 60) => request<AuditEntry[]>('GET', `/api/projects/${enc(projectId)}/audit?limit=${limit}`),
  search: (projectId: string, q: string, types: string[] = [], limit = 20) =>
    request<SearchResult[]>('GET', `/api/projects/${enc(projectId)}/search?q=${enc(q)}&types=${enc(types.join(','))}&limit=${limit}`),
  exportMarkdown: (projectId: string) => requestText(`/api/projects/${enc(projectId)}/export.md`),

  listEntities: (projectId: string, kind?: string, status?: string) => {
    const query = new URLSearchParams()
    if (kind) query.set('kind', kind)
    if (status) query.set('status', status)
    const suffix = query.toString()
    return request<Entity[]>('GET', `/api/projects/${enc(projectId)}/entities${suffix ? `?${suffix}` : ''}`)
  },
  getEntity: (entityId: string) => request<Entity>('GET', `/api/entities/${enc(entityId)}`),
  createEntity: (projectId: string, input: {
    kind: string
    name: string
    summary?: string
    attributes?: Record<string, unknown>
    status?: string
    role?: string
    goal?: string
    motivation?: string
    flaw?: string
    secret?: string
    voice?: string
    arc?: string
    aliases?: string[]
    firstAppearanceChapterId?: string | null
    importance?: number
  }) => request<Entity>('POST', `/api/projects/${enc(projectId)}/entities`, input),
  updateEntity: (entityId: string, patch: {
    name?: string
    kind?: string
    summary?: string
    attributes?: Record<string, unknown>
    status?: string
    role?: string
    goal?: string
    motivation?: string
    flaw?: string
    secret?: string
    voice?: string
    arc?: string
    aliases?: string[]
    firstAppearanceChapterId?: string | null
    importance?: number
    expectedVersion?: number
  }) => request<Entity>('PATCH', `/api/entities/${enc(entityId)}`, patch),

  listOutlines: (projectId: string) => request<Outline[]>('GET', `/api/projects/${enc(projectId)}/outlines`),
  updateOutline: (outlineId: string, patch: { title?: string; content?: string; status?: string; expectedVersion?: number }) =>
    request<Outline>('PATCH', `/api/outlines/${enc(outlineId)}`, patch),
  planOutline: (projectId: string, chapterCount: number) =>
    request<unknown>('POST', `/api/projects/${enc(projectId)}/outlines/plan`, { chapterCount }),

  listChapters: (projectId: string) => request<Chapter[]>('GET', `/api/projects/${enc(projectId)}/chapters`),
  listChapterSummaries: (projectId: string) =>
    request<ChapterSummary[]>('GET', `/api/projects/${enc(projectId)}/chapter-summaries`),
  getChapterDetail: (chapterId: string) => request<ChapterDetail>('GET', `/api/chapters/${enc(chapterId)}`),
  getContext: (chapterId: string) => request<ContextPack>('GET', `/api/chapters/${enc(chapterId)}/context`),
  /** full=false（默认）时不返回 content，只返回 contentLength，用于列表与下拉；渲染正文请用 getRevision。 */
  listRevisions: (chapterId: string, full = false) =>
    request<ChapterRevision[]>('GET', `/api/chapters/${enc(chapterId)}/revisions?full=${full ? 1 : 0}`),
  saveManualRevision: (chapterId: string, content: string) =>
    request<ChapterRevision>('POST', `/api/chapters/${enc(chapterId)}/revisions`, { content }),
  createChapter: (projectId: string, input: { title: string; chapterNo?: number }) =>
    request<{ chapter: Chapter; outline: Outline }>('POST', `/api/projects/${enc(projectId)}/chapters`, input),
  updateChapter: (chapterId: string, patch: { title?: string; status?: string; expectedVersion?: number }) =>
    request<Chapter>('PATCH', `/api/chapters/${enc(chapterId)}`, patch),
  planChapter: (chapterId: string) => request<{ plan: unknown; context: ContextMeta }>('POST', `/api/chapters/${enc(chapterId)}/plan`),
  writeDraft: (chapterId: string) =>
    request<{ revision: ChapterRevision; plan: unknown; context: ContextMeta }>('POST', `/api/chapters/${enc(chapterId)}/draft`),

  getRevision: (revisionId: string) => request<ChapterRevision>('GET', `/api/revisions/${enc(revisionId)}`),
  compare: (left: string, right: string) => request<CompareResult>('GET', `/api/compare?left=${enc(left)}&right=${enc(right)}`),
  review: (revisionId: string) => request<{ run: ReviewRun; issues: ReviewIssue[] }>('POST', `/api/revisions/${enc(revisionId)}/review`),
  revise: (revisionId: string, issueIds: string[], instruction = '') =>
    request<unknown>('POST', `/api/revisions/${enc(revisionId)}/revise`, { issueIds, instruction }),
  continueWriting: (revisionId: string, instruction = '') =>
    request<ChapterRevision>('POST', `/api/revisions/${enc(revisionId)}/continue`, { instruction }),
  rewrite: (revisionId: string, instruction: string) =>
    request<ChapterRevision>('POST', `/api/revisions/${enc(revisionId)}/rewrite`, { instruction }),
  rollback: (revisionId: string) => request<ChapterRevision>('POST', `/api/revisions/${enc(revisionId)}/rollback`),
  finalize: (revisionId: string, approvedChangeIds: string[] = []) =>
    request<Chapter>('POST', `/api/revisions/${enc(revisionId)}/finalize`, { approvedChangeIds }),

  listEntityStates: (entityId: string) =>
    request<Array<{ id: string; characterId: string; chapterId: string | null; summary: string; stateJson: string; createdAt: string }>>(
      'GET', `/api/entities/${enc(entityId)}/states`,
    ),
  createEntityState: (entityId: string, input: { chapterId?: string; summary?: string; state?: Record<string, unknown> }) =>
    request<{ id: string; characterId: string; chapterId: string | null; summary: string; stateJson: string; createdAt: string }>(
      'POST', `/api/entities/${enc(entityId)}/states`, input,
    ),

  listEvents: (projectId: string) => request<StoryEvent[]>('GET', `/api/projects/${enc(projectId)}/events`),
  createEvent: (projectId: string, input: { summary: string; eventTime?: string; status?: string; chapterId?: string }) =>
    request<StoryEvent>('POST', `/api/projects/${enc(projectId)}/events`, input),
  updateEvent: (eventId: string, patch: { summary?: string; eventTime?: string; status?: string; chapterId?: string | null; expectedVersion?: number }) =>
    request<StoryEvent>('PATCH', `/api/events/${enc(eventId)}`, patch),
  listForeshadowing: (projectId: string) => request<Foreshadowing[]>('GET', `/api/projects/${enc(projectId)}/foreshadowing`),
  createForeshadowing: (projectId: string, input: { name: string; description?: string; status?: string; plantChapterId?: string; payoffChapterId?: string }) =>
    request<Foreshadowing>('POST', `/api/projects/${enc(projectId)}/foreshadowing`, input),
  updateForeshadowing: (id: string, patch: { name?: string; description?: string; status?: string; plantChapterId?: string | null; payoffChapterId?: string | null; expectedVersion?: number }) =>
    request<Foreshadowing>('PATCH', `/api/foreshadowing/${enc(id)}`, patch),

  listReviews: (projectId: string) => request<ReviewRunSummary[]>('GET', `/api/projects/${enc(projectId)}/reviews`),
  getReview: (reviewRunId: string) =>
    request<{ run: ReviewRun; chapter: Chapter; issues: ReviewIssue[] }>('GET', `/api/reviews/${enc(reviewRunId)}`),
  updateIssue: (issueId: string, status: 'open' | 'resolved' | 'wontfix') =>
    request<ReviewIssue>('PATCH', `/api/issues/${enc(issueId)}`, { status }),

  listProposals: (projectId: string, status?: string) =>
    request<ChangeProposal[]>('GET', `/api/projects/${enc(projectId)}/proposals${status ? `?status=${enc(status)}` : ''}`),
  applyProposal: (proposalId: string) => request<ChangeProposal>('POST', `/api/proposals/${enc(proposalId)}/apply`),
  rejectProposal: (proposalId: string) => request<ChangeProposal>('POST', `/api/proposals/${enc(proposalId)}/reject`),

  listWorkflows: (projectId: string) => request<WorkflowRun[]>('GET', `/api/projects/${enc(projectId)}/workflows`),

  // ── 主线关系 / 剧情线 / 场景 ──────────────────────────
  listRelations: (projectId: string) => request<Relation[]>('GET', `/api/projects/${enc(projectId)}/relations`),
  createRelation: (projectId: string, input: { sourceId: string; targetId: string; kind: string; tension?: string; notes?: string }) =>
    request<Relation>('POST', `/api/projects/${enc(projectId)}/relations`, input),
  updateRelation: (relationId: string, patch: { kind?: string; tension?: string; notes?: string; status?: string; expectedVersion?: number }) =>
    request<Relation>('PATCH', `/api/relations/${enc(relationId)}`, patch),

  listKnowledge: (projectId: string) => request<KnowledgeFact[]>('GET', `/api/projects/${enc(projectId)}/knowledge`),
  createKnowledge: (projectId: string, input: { proposition: string; truth?: string; publicLevel?: string; chapterId?: string | null; knowers?: Array<{ entityId: string; state: string }>; notes?: string }) =>
    request<KnowledgeFact>('POST', `/api/projects/${enc(projectId)}/knowledge`, input),
  updateKnowledge: (factId: string, patch: { proposition?: string; truth?: string; publicLevel?: string; chapterId?: string | null; knowers?: Array<{ entityId: string; state: string }>; notes?: string; expectedVersion?: number }) =>
    request<KnowledgeFact>('PATCH', `/api/knowledge/${enc(factId)}`, patch),
  deleteKnowledge: (factId: string) => request<{ ok: true }>('DELETE', `/api/knowledge/${enc(factId)}`),
  listOverdueForeshadowing: (projectId: string) =>
    request<Array<Foreshadowing & { deadlineChapterId: number; progressChapterNo: number }>>('GET', `/api/projects/${enc(projectId)}/foreshadowing-overdue`),
  deleteRelation: (relationId: string) => request<{ ok: true }>('DELETE', `/api/relations/${enc(relationId)}`),
  deleteThread: (threadId: string) => request<{ ok: true }>('DELETE', `/api/threads/${enc(threadId)}`),

  listThreads: (projectId: string) => request<PlotThread[]>('GET', `/api/projects/${enc(projectId)}/threads`),
  createThread: (projectId: string, input: { name: string; kind?: string; goal?: string; summary?: string }) =>
    request<PlotThread>('POST', `/api/projects/${enc(projectId)}/threads`, input),
  updateThread: (threadId: string, patch: { name?: string; kind?: string; goal?: string; summary?: string; status?: string; expectedVersion?: number }) =>
    request<PlotThread>('PATCH', `/api/threads/${enc(threadId)}`, patch),

  listScenes: (chapterId: string) => request<Scene[]>('GET', `/api/chapters/${enc(chapterId)}/scenes`),
  createScene: (chapterId: string, input: { beat?: string; goal?: string; conflict?: string; outcome?: string; locationEntityId?: string; cast?: string[]; povEntityId?: string; notes?: string }) =>
    request<Scene>('POST', `/api/chapters/${enc(chapterId)}/scenes`, input),
  updateScene: (sceneId: string, patch: { beat?: string; goal?: string; conflict?: string; outcome?: string; notes?: string; status?: string; expectedVersion?: number }) =>
    request<Scene>('PATCH', `/api/scenes/${enc(sceneId)}`, patch),
  deleteScene: (sceneId: string) => request<{ ok: true }>('DELETE', `/api/scenes/${enc(sceneId)}`),

  // ── 素材导入 ──────────────────────────────────────────
  ingest: (projectId: string, input: { material: string; title?: string; focus?: string; mode?: 'propose' | 'apply' }) =>
    request<IngestOutcome>('POST', `/api/projects/${enc(projectId)}/ingest`, input),
  listIngestBatches: (projectId: string) => request<IngestBatch[]>('GET', `/api/projects/${enc(projectId)}/ingest-batches`),
  getIngestBatch: (batchId: string) =>
    request<{ batch: IngestBatch; proposals: ChangeProposal[] }>('GET', `/api/ingest-batches/${enc(batchId)}`),
  applyIngestBatch: (batchId: string) =>
    request<{ applied: string[]; failed: Array<{ id: string; error: string }>; batch: IngestBatch }>('POST', `/api/ingest-batches/${enc(batchId)}/apply`),
}
