// 与 src/database/schema.ts、src/database/store.ts 的返回结构一一对应。
// 工作台只消费 REST 接口返回的 JSON，不接触 SQLite 文件。

export interface Project {
  id: string
  title: string
  genre: string
  premise: string
  styleGuide: string
  status: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface Entity {
  id: string
  projectId: string
  kind: string
  name: string
  summary: string
  attributesJson: string
  status: string
  sourceChapterId: string | null
  sourceRevisionId: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface Outline {
  id: string
  projectId: string
  parentId: string | null
  level: 'volume' | 'chapter' | string
  chapterNo: number | null
  title: string
  content: string
  status: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface Chapter {
  id: string
  projectId: string
  outlineId: string | null
  chapterNo: number
  title: string
  status: string
  currentRevisionId: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface ChapterRevision {
  id: string
  chapterId: string
  revisionNo: number
  /** 注意：`GET /api/chapters/:id/revisions?full=0`（列表模式）会剥离该字段，只给 `contentLength`；
   *  需要全文请用 `api.getRevision(id)` 或 `api.listRevisions(chapterId, true)`。
   *  `getChapterDetail` 返回的 revisions 始终带全文。 */
  content: string
  kind: 'draft' | 'continue' | 'rewrite' | 'revise' | 'rollback' | 'manual' | string
  status: string
  summary: string
  createdAt: string
  /** 列表接口（不带 full=1）才有 */
  contentLength?: number
}

export interface StoryEvent {
  id: string
  projectId: string
  chapterId: string | null
  eventTime: string
  summary: string
  status: string
  sourceRevisionId: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface Foreshadowing {
  id: string
  projectId: string
  name: string
  description: string
  plantChapterId: string | null
  payoffChapterId: string | null
  status: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface ReviewRun {
  id: string
  chapterId: string
  revisionId: string
  status: string
  summary: string
  createdAt: string
}

export interface ReviewIssue {
  id: string
  reviewRunId: string
  category: string
  severity: 'critical' | 'major' | 'minor' | string
  locationStart: number | null
  locationEnd: number | null
  issue: string
  evidenceJson: string
  suggestedFix: string
  resolutionStatus: 'open' | 'resolved' | 'wontfix' | string
}

export interface ReviewRunSummary {
  run: ReviewRun
  chapter: { id: string; chapterNo: number; title: string }
  issueCount: number
  openCount: number
}

export interface WorkflowRun {
  id: string
  projectId: string
  chapterId: string | null
  taskType: string
  state: string
  checkpointJson: string
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface ChangeProposal {
  id: string
  projectId: string
  chapterId: string | null
  sourceRevisionId: string | null
  targetType: 'entity' | 'event' | 'foreshadowing' | string
  targetId: string | null
  operation: 'create' | 'update' | string
  payloadJson: string
  expectedVersion: number | null
  status: string
  createdAt: string
  appliedAt: string | null
}

export interface AuditEntry {
  id: string
  projectId: string
  action: string
  entityId: string
  beforeJson: string | null
  afterJson: string | null
  createdAt: string
}

export interface ContextSource {
  id: string
  type: string
  status: string
}

export interface ContextPack {
  projectId: string
  chapterId: string
  text: string
  estimatedTokens: number
  budgetTokens: number
  truncated: boolean
  omittedSections: string[]
  sources: ContextSource[]
}

export interface ContextMeta {
  estimatedTokens: number
  budgetTokens: number
  truncated: boolean
  omittedSections: string[]
  sources: ContextSource[]
  text?: string
  preview?: string
}

export interface SearchResult {
  recordId: string
  recordType: string
  sourceId: string
  status: string
  snippet: string
}

export interface ChapterSummary {
  chapter: Chapter
  revisionCount: number
  latest: { id: string; revisionNo: number; status: string; kind: string; words: number; createdAt: string } | null
}

export interface ChapterDetail {
  chapter: Chapter
  outline: Outline | null
  revisions: ChapterRevision[]
  latestRevision: ChapterRevision | null
  latestReview: { run: ReviewRun; issues: ReviewIssue[] } | null
}

export interface ProjectOverview {
  project: Project
  counts: {
    chapters: number
    finalizedChapters: number
    entities: number
    events: number
    foreshadowingOpen: number
    pendingProposals: number
    openIssues: number
    revisions: number
  }
  currentChapter: Chapter | null
  openIssues: Array<ReviewIssue & { chapterId: string; chapterNo: number; chapterTitle: string }>
  openForeshadowing: Foreshadowing[]
  pendingProposals: ChangeProposal[]
  recentWorkflows: WorkflowRun[]
  recentRevisions: ChapterRevision[]
  lastFinalized: { chapter: Chapter; revision: ChapterRevision } | null
}

export interface HealthInfo {
  version: string
  hasApiKey: boolean
  databasePath: string
  studioBuilt: boolean
}

export interface DiffChange {
  value: string
  added?: boolean
  removed?: boolean
  count?: number
}

export interface CompareResult {
  leftId: string
  rightId: string
  changes: DiffChange[]
}
