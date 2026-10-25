import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { openDatabase } from './database.js'
import type { DatabaseHandle, NovelDatabase } from './database.js'
import {
  auditLog,
  changeProposals,
  chapterRevisions,
  chapters,
  characterStates,
  entities,
  events,
  foreshadowing,
  ingestBatches,
  knowledgeFacts,
  outlines,
  plotThreads,
  projects,
  relations,
  reviewIssues,
  reviewRuns,
  scenes,
  workflowRuns,
} from './schema.js'
import type { NovelBlueprint, OutlinePlan, ReviewResult } from '../domain/schemas.js'
import { changePayloadSchema } from '../domain/schemas.js'
import { z } from 'zod'
import { NovelForgeError, requireNonEmpty } from '../shared/errors.js'
import { id, now } from '../shared/id.js'
import { parseJson } from '../shared/json.js'

export type Project = typeof projects.$inferSelect
export type Entity = typeof entities.$inferSelect
export type Outline = typeof outlines.$inferSelect
export type Chapter = typeof chapters.$inferSelect
export type ChapterRevision = typeof chapterRevisions.$inferSelect
export type StoryEvent = typeof events.$inferSelect
export type Foreshadowing = typeof foreshadowing.$inferSelect
export type ReviewRun = typeof reviewRuns.$inferSelect
export type ReviewIssue = typeof reviewIssues.$inferSelect
export type WorkflowRun = typeof workflowRuns.$inferSelect
export type ChangeProposal = typeof changeProposals.$inferSelect
export type AuditEntry = typeof auditLog.$inferSelect
export type Relation = typeof relations.$inferSelect
export type PlotThread = typeof plotThreads.$inferSelect
export type Scene = typeof scenes.$inferSelect
export type CharacterState = typeof characterStates.$inferSelect
export type IngestBatch = typeof ingestBatches.$inferSelect
export type KnowledgeFact = typeof knowledgeFacts.$inferSelect

export interface KnowerEntry {
  entityId: string
  state: 'knows' | 'suspects' | 'misbelieves' | 'unaware'
  sinceChapterId?: string | null
  notes?: string
}

export interface KnowledgeView extends KnowledgeFact {
  knowers: Array<KnowerEntry & { name: string }>
  chapterNo: number | null
}

export interface RelationView extends Relation {
  sourceName: string
  targetName: string
}

export interface SceneView extends Scene {
  castNames: string[]
  locationName: string | null
}

/** 正文版本来源：模型生成（draft/continue/rewrite/revise）与人工撰写/回滚都只追加不覆盖。 */
export type RevisionKind = 'draft' | 'continue' | 'rewrite' | 'revise' | 'rollback' | 'manual'

/** 章节列表 + 最新版本摘要，供工作台的章节列表与总览使用。 */
export interface ChapterSummary {
  chapter: Chapter
  revisionCount: number
  latest: { id: string; revisionNo: number; status: string; kind: string; words: number; createdAt: string } | null
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
    relations: number
    threads: number
    scenes: number
    ingestBatches: number
    overdueForeshadowing: number
  }
  currentChapter: Chapter | null
  openIssues: Array<ReviewIssue & { chapterId: string; chapterNo: number; chapterTitle: string }>
  openForeshadowing: Foreshadowing[]
  pendingProposals: ChangeProposal[]
  recentWorkflows: WorkflowRun[]
  recentRevisions: ChapterRevision[]
  lastFinalized: { chapter: Chapter; revision: ChapterRevision } | null
}

export interface ProjectInput {
  title: string
  genre: string
  premise?: string | undefined
  styleGuide?: string | undefined
  pov?: string | undefined
  tense?: string | undefined
  chapterWordsMin?: number | undefined
  chapterWordsMax?: number | undefined
  targetChapters?: number | undefined
  themes?: string[] | undefined
}

export type ProposalTargetType = 'entity' | 'event' | 'foreshadowing' | 'relation' | 'thread' | 'knowledge'

export interface ProposalInput {
  projectId: string
  chapterId?: string | undefined
  sourceRevisionId?: string | undefined
  targetType: ProposalTargetType
  targetId?: string | undefined
  operation: 'create' | 'update'
  payload: unknown
  expectedVersion?: number | undefined
  batchId?: string | undefined
  source?: string | undefined
  confidence?: number | undefined
}

export interface SearchResult {
  recordId: string
  recordType: string
  sourceId: string
  status: string
  snippet: string
}

export class NovelStore {
  readonly handle: DatabaseHandle
  readonly db: NovelDatabase

  constructor(databasePath: string) {
    this.handle = openDatabase(databasePath)
    this.db = this.handle.db
  }

  close(): void {
    this.handle.close()
  }

  private audit(projectId: string, action: string, entityId: string, before: unknown, after: unknown): void {
    this.db.insert(auditLog).values({
      id: id('audit'), projectId, action, entityId,
      beforeJson: before === undefined ? null : JSON.stringify(before),
      afterJson: after === undefined ? null : JSON.stringify(after),
      createdAt: now(),
    }).run()
  }

  private index(recordId: string, projectId: string, recordType: string, sourceId: string, status: string, content: string): void {
    this.handle.sqlite.prepare('DELETE FROM knowledge_fts WHERE record_id = ?').run(recordId)
    this.handle.sqlite.prepare(
      'INSERT INTO knowledge_fts(content, record_id, project_id, record_type, source_id, status) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(content, recordId, projectId, recordType, sourceId, status)
  }

  private unindex(recordId: string): void {
    this.handle.sqlite.prepare('DELETE FROM knowledge_fts WHERE record_id = ?').run(recordId)
  }

  listProjects(): Project[] {
    return this.db.select().from(projects).orderBy(desc(projects.updatedAt)).all()
  }

  getProject(projectId: string): Project {
    const row = this.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!row) throw new NovelForgeError('NOT_FOUND', `小说项目不存在：${projectId}`)
    return row
  }

  createProject(input: ProjectInput): Project {
    const timestamp = now()
    const row: Project = {
      id: id('project'),
      title: requireNonEmpty(input.title, 'title'),
      genre: requireNonEmpty(input.genre, 'genre'),
      premise: input.premise?.trim() ?? '',
      styleGuide: input.styleGuide?.trim() ?? '',
      pov: input.pov?.trim() ?? '', tense: input.tense?.trim() ?? '',
      chapterWordsMin: input.chapterWordsMin ?? 0, chapterWordsMax: input.chapterWordsMax ?? 0,
      targetChapters: input.targetChapters ?? 0, themesJson: JSON.stringify(input.themes ?? []),
      status: 'active', version: 1, createdAt: timestamp, updatedAt: timestamp,
    }
    this.db.insert(projects).values(row).run()
    this.audit(row.id, 'project.create', row.id, undefined, row)
    return row
  }

  createGeneratedProject(blueprint: NovelBlueprint): { project: Project; entities: Entity[] } {
    return this.db.transaction(() => {
      const project = this.createProject(blueprint)
      const created = [
        ...blueprint.characters.map(item => ({ ...item, kind: 'character' })),
        ...blueprint.worldRules.map(item => ({ ...item, kind: 'world_rule' })),
      ].map(item => this.createEntity({
        projectId: project.id,
        kind: item.kind,
        name: item.name,
        summary: item.summary,
        attributes: item.attributes,
        status: 'confirmed',
      }))
      return { project, entities: created }
    })
  }

  createEntity(input: {
    projectId: string
    kind: string
    name: string
    summary?: string | undefined
    attributes?: Record<string, unknown> | undefined
    status?: string | undefined
    sourceChapterId?: string | undefined
    sourceRevisionId?: string | undefined
    role?: string | undefined
    goal?: string | undefined
    motivation?: string | undefined
    flaw?: string | undefined
    secret?: string | undefined
    voice?: string | undefined
    arc?: string | undefined
    aliases?: string[] | undefined
    firstAppearanceChapterId?: string | null | undefined
    importance?: number | undefined
  }): Entity {
    this.getProject(input.projectId)
    const timestamp = now()
    const row: Entity = {
      id: id('entity'), projectId: input.projectId, kind: input.kind,
      name: requireNonEmpty(input.name, 'name'), summary: input.summary?.trim() ?? '',
      attributesJson: JSON.stringify(input.attributes ?? {}), status: input.status ?? 'confirmed',
      sourceChapterId: input.sourceChapterId ?? null, sourceRevisionId: input.sourceRevisionId ?? null,
      role: input.role?.trim() ?? '', goal: input.goal?.trim() ?? '', motivation: input.motivation?.trim() ?? '',
      flaw: input.flaw?.trim() ?? '', secret: input.secret?.trim() ?? '', voice: input.voice?.trim() ?? '',
      arc: input.arc?.trim() ?? '', aliasesJson: JSON.stringify(input.aliases ?? []),
      firstAppearanceChapterId: input.firstAppearanceChapterId ?? null, importance: input.importance ?? 3,
      version: 1, createdAt: timestamp, updatedAt: timestamp,
    }
    this.db.insert(entities).values(row).run()
    this.index(row.id, row.projectId, row.kind, row.id, row.status, `${row.name}\n${row.summary}\n${row.attributesJson}`)
    this.audit(row.projectId, 'entity.create', row.id, undefined, row)
    return row
  }

  getEntity(entityId: string): Entity {
    const row = this.db.select().from(entities).where(eq(entities.id, entityId)).get()
    if (!row) throw new NovelForgeError('NOT_FOUND', `实体不存在：${entityId}`)
    return row
  }

  listEntities(projectId: string, kind?: string, status?: string): Entity[] {
    const conditions = [eq(entities.projectId, projectId)]
    if (kind) conditions.push(eq(entities.kind, kind))
    if (status) conditions.push(eq(entities.status, status))
    return this.db.select().from(entities).where(and(...conditions)).orderBy(asc(entities.kind), asc(entities.name)).all()
  }

  appendOutline(projectId: string, plan: OutlinePlan): { outlines: Outline[]; chapters: Chapter[] } {
    this.getProject(projectId)
    return this.db.transaction(() => {
      const latest = this.db.select({ chapterNo: chapters.chapterNo }).from(chapters)
        .where(eq(chapters.projectId, projectId)).orderBy(desc(chapters.chapterNo)).limit(1).get()
      let chapterNo = (latest?.chapterNo ?? 0) + 1
      const createdOutlines: Outline[] = []
      const createdChapters: Chapter[] = []
      for (const volume of plan.volumes) {
        const timestamp = now()
        const volumeRow: Outline = {
          id: id('outline'), projectId, parentId: null, level: 'volume', chapterNo: null,
          title: volume.title, content: volume.summary, status: 'planned', version: 1,
          createdAt: timestamp, updatedAt: timestamp,
        }
        this.db.insert(outlines).values(volumeRow).run()
        createdOutlines.push(volumeRow)
        for (const chapter of volume.chapters) {
          const content = JSON.stringify({ summary: chapter.summary, goal: chapter.goal, conflict: chapter.conflict, hook: chapter.hook })
          const outlineRow: Outline = {
            id: id('outline'), projectId, parentId: volumeRow.id, level: 'chapter', chapterNo,
            title: chapter.title, content, status: 'planned', version: 1,
            createdAt: timestamp, updatedAt: timestamp,
          }
          const chapterRow: Chapter = {
            id: id('chapter'), projectId, outlineId: outlineRow.id, chapterNo,
            title: chapter.title, status: 'planned', currentRevisionId: null,
            summary: chapter.summary ?? '', povEntityId: null, targetWords: 0,
            version: 1, createdAt: timestamp, updatedAt: timestamp,
          }
          this.db.insert(outlines).values(outlineRow).run()
          this.db.insert(chapters).values(chapterRow).run()
          createdOutlines.push(outlineRow)
          createdChapters.push(chapterRow)
          this.audit(projectId, 'chapter.plan', chapterRow.id, undefined, chapterRow)
          chapterNo += 1
        }
      }
      return { outlines: createdOutlines, chapters: createdChapters }
    })
  }

  listOutlines(projectId: string): Outline[] {
    return this.db.select().from(outlines).where(eq(outlines.projectId, projectId))
      .orderBy(asc(outlines.chapterNo), asc(outlines.createdAt)).all()
  }

  getOutline(outlineId: string): Outline {
    const row = this.db.select().from(outlines).where(eq(outlines.id, outlineId)).get()
    if (!row) throw new NovelForgeError('NOT_FOUND', `大纲不存在：${outlineId}`)
    return row
  }

  listChapters(projectId: string): Chapter[] {
    return this.db.select().from(chapters).where(eq(chapters.projectId, projectId)).orderBy(asc(chapters.chapterNo)).all()
  }

  getChapter(chapterId: string): Chapter {
    const row = this.db.select().from(chapters).where(eq(chapters.id, chapterId)).get()
    if (!row) throw new NovelForgeError('NOT_FOUND', `章节不存在：${chapterId}`)
    return row
  }

  getChapterByNumber(projectId: string, chapterNo: number): Chapter {
    const row = this.db.select().from(chapters).where(and(eq(chapters.projectId, projectId), eq(chapters.chapterNo, chapterNo))).get()
    if (!row) throw new NovelForgeError('NOT_FOUND', `第 ${chapterNo} 章不存在，请先规划章节。`)
    return row
  }

  getRevision(revisionId: string): ChapterRevision {
    const row = this.db.select().from(chapterRevisions).where(eq(chapterRevisions.id, revisionId)).get()
    if (!row) throw new NovelForgeError('NOT_FOUND', `正文版本不存在：${revisionId}`)
    return row
  }

  getLatestRevision(chapterId: string): ChapterRevision | undefined {
    return this.db.select().from(chapterRevisions).where(eq(chapterRevisions.chapterId, chapterId))
      .orderBy(desc(chapterRevisions.revisionNo)).limit(1).get()
  }

  listRevisions(chapterId: string): ChapterRevision[] {
    return this.db.select().from(chapterRevisions).where(eq(chapterRevisions.chapterId, chapterId))
      .orderBy(desc(chapterRevisions.revisionNo)).all()
  }

  listFinalChapters(projectId: string, beforeChapterNo?: number): Array<{ chapter: Chapter; revision: ChapterRevision }> {
    const conditions = [eq(chapters.projectId, projectId), eq(chapters.status, 'finalized')]
    if (beforeChapterNo !== undefined) conditions.push(sql`${chapters.chapterNo} < ${beforeChapterNo}`)
    const rows = this.db.select({ chapter: chapters, revision: chapterRevisions }).from(chapters)
      .innerJoin(chapterRevisions, eq(chapterRevisions.id, chapters.currentRevisionId))
      .where(and(...conditions)).orderBy(asc(chapters.chapterNo)).all()
    return rows
  }

  createRevision(chapterId: string, content: string, kind: RevisionKind): ChapterRevision {
    const chapter = this.getChapter(chapterId)
    const normalized = requireNonEmpty(content, '正文')
    return this.db.transaction(() => {
      const previous = this.getLatestRevision(chapterId)
      const row: ChapterRevision = {
        id: id('revision'), chapterId, revisionNo: (previous?.revisionNo ?? 0) + 1,
        content: normalized, kind, status: 'draft', summary: '', createdAt: now(),
      }
      this.db.insert(chapterRevisions).values(row).run()
      this.db.update(chapters).set({
        status: kind === 'revise' || kind === 'rewrite' ? 'revising'
          : kind === 'manual' ? 'manual_draft' : 'draft_generated',
        version: chapter.version + 1, updatedAt: now(),
      }).where(eq(chapters.id, chapterId)).run()
      this.index(row.id, chapter.projectId, 'chapter', chapterId, row.status, row.content)
      this.audit(chapter.projectId, `revision.${kind}`, row.id, undefined, { revisionNo: row.revisionNo, kind })
      return row
    })
  }

  updateChapterStatus(chapterId: string, status: string): void {
    const chapter = this.getChapter(chapterId)
    this.db.update(chapters).set({ status, version: chapter.version + 1, updatedAt: now() }).where(eq(chapters.id, chapterId)).run()
  }

  updateRevisionSummary(revisionId: string, summary: string): void {
    this.db.update(chapterRevisions).set({ summary }).where(eq(chapterRevisions.id, revisionId)).run()
  }

  listEvents(projectId: string): StoryEvent[] {
    return this.db.select().from(events).where(eq(events.projectId, projectId))
      .orderBy(asc(events.eventTime), asc(events.createdAt)).all()
  }

  listForeshadowing(projectId: string): Foreshadowing[] {
    return this.db.select().from(foreshadowing).where(eq(foreshadowing.projectId, projectId))
      .orderBy(asc(foreshadowing.status), asc(foreshadowing.createdAt)).all()
  }

  createReview(revisionId: string, result: ReviewResult): { run: ReviewRun; issues: ReviewIssue[] } {
    const revision = this.getRevision(revisionId)
    const chapter = this.getChapter(revision.chapterId)
    return this.db.transaction(() => {
      const run: ReviewRun = {
        id: id('review'), chapterId: chapter.id, revisionId,
        status: result.issues.some(issue => issue.severity !== 'minor') ? 'issues_found' : 'passed',
        summary: result.summary, createdAt: now(),
      }
      this.db.insert(reviewRuns).values(run).run()
      const rows = result.issues.map(issue => ({
        id: id('issue'), reviewRunId: run.id, category: issue.category, severity: issue.severity,
        locationStart: issue.start, locationEnd: issue.end, issue: issue.issue,
        evidenceJson: JSON.stringify(issue.evidence), suggestedFix: issue.suggestedFix, resolutionStatus: 'open',
      }))
      if (rows.length) this.db.insert(reviewIssues).values(rows).run()
      this.db.update(chapterRevisions).set({ status: 'reviewed' }).where(eq(chapterRevisions.id, revisionId)).run()
      this.index(revision.id, chapter.projectId, 'chapter', chapter.id, 'reviewed', revision.content)
      this.db.update(chapters).set({
        status: run.status === 'passed' ? 'awaiting_approval' : 'needs_author_decision',
        version: chapter.version + 1, updatedAt: now(),
      }).where(eq(chapters.id, chapter.id)).run()
      this.audit(chapter.projectId, 'review.create', run.id, undefined, { status: run.status, issueCount: rows.length })
      return { run, issues: rows }
    })
  }

  getLatestReview(revisionId: string): ReviewRun | undefined {
    return this.db.select().from(reviewRuns).where(eq(reviewRuns.revisionId, revisionId))
      .orderBy(desc(reviewRuns.createdAt)).limit(1).get()
  }

  getReviewRun(runId: string): ReviewRun {
    const row = this.db.select().from(reviewRuns).where(eq(reviewRuns.id, runId)).get()
    if (!row) throw new NovelForgeError('NOT_FOUND', `审查任务不存在：${runId}`)
    return row
  }

  listReviewIssues(runId: string): ReviewIssue[] {
    return this.db.select().from(reviewIssues).where(eq(reviewIssues.reviewRunId, runId)).all()
  }

  listIssuesByIds(issueIds: string[]): ReviewIssue[] {
    if (!issueIds.length) return []
    return this.db.select().from(reviewIssues).where(inArray(reviewIssues.id, issueIds)).all()
  }

  resolveIssues(issueIds: string[]): void {
    if (issueIds.length) {
      this.db.update(reviewIssues).set({ resolutionStatus: 'resolved' }).where(inArray(reviewIssues.id, issueIds)).run()
    }
  }

  proposeChange(input: ProposalInput): ChangeProposal {
    this.getProject(input.projectId)
    let payload: ReturnType<typeof changePayloadSchema.parse>
    try {
      payload = changePayloadSchema.parse(input.payload)
    } catch (error) {
      if (error instanceof z.ZodError) {
        const detail = error.issues.map(issue => `${issue.path.join('.') || 'payload'}：${issue.message}`).join('；')
        throw new NovelForgeError('INVALID_INPUT', `变更 payload 不合法：${detail}`)
      }
      throw error
    }
    if (input.operation === 'update' && !input.targetId) {
      throw new NovelForgeError('INVALID_INPUT', '更新提议必须提供 targetId。')
    }
    const row: ChangeProposal = {
      id: id('proposal'), projectId: input.projectId, chapterId: input.chapterId ?? null,
      sourceRevisionId: input.sourceRevisionId ?? null, targetType: input.targetType,
      targetId: input.targetId ?? null, operation: input.operation, payloadJson: JSON.stringify(payload),
      expectedVersion: input.expectedVersion ?? null,
      batchId: input.batchId ?? null, source: input.source ?? 'manual', confidence: input.confidence ?? null,
      status: 'pending', createdAt: now(), appliedAt: null,
    }
    this.db.insert(changeProposals).values(row).run()
    this.audit(input.projectId, 'proposal.create', row.id, undefined, row)
    return row
  }

  getProposal(proposalId: string): ChangeProposal {
    const row = this.db.select().from(changeProposals).where(eq(changeProposals.id, proposalId)).get()
    if (!row) throw new NovelForgeError('NOT_FOUND', `变更提议不存在：${proposalId}`)
    return row
  }

  listProposals(projectId: string, status?: string): ChangeProposal[] {
    const conditions = [eq(changeProposals.projectId, projectId)]
    if (status) conditions.push(eq(changeProposals.status, status))
    return this.db.select().from(changeProposals).where(and(...conditions)).orderBy(desc(changeProposals.createdAt)).all()
  }

  private applyProposalTx(proposal: ChangeProposal): void {
    if (proposal.status !== 'pending') throw new NovelForgeError('CONFLICT', `提议 ${proposal.id} 当前状态为 ${proposal.status}，不能重复应用。`)
    const payload = changePayloadSchema.parse(parseJson(proposal.payloadJson, {}))
    let targetVersion = 0
    if (proposal.targetType === 'entity') {
      if (proposal.operation === 'create') {
        this.createEntity({
          projectId: proposal.projectId, kind: payload.kind ?? 'other', name: payload.name ?? '未命名实体',
          summary: payload.summary, attributes: payload.attributes, status: payload.status ?? 'confirmed',
          ...(payload.role === undefined ? {} : { role: payload.role }),
          ...(payload.goal === undefined ? {} : { goal: payload.goal }),
          ...(payload.motivation === undefined ? {} : { motivation: payload.motivation }),
          ...(payload.flaw === undefined ? {} : { flaw: payload.flaw }),
          ...(payload.secret === undefined ? {} : { secret: payload.secret }),
          ...(payload.voice === undefined ? {} : { voice: payload.voice }),
          ...(payload.arc === undefined ? {} : { arc: payload.arc }),
          ...(payload.aliases === undefined ? {} : { aliases: payload.aliases }),
          ...(payload.firstAppearanceChapterId === undefined ? {} : { firstAppearanceChapterId: payload.firstAppearanceChapterId }),
          ...(payload.importance === undefined ? {} : { importance: payload.importance }),
          ...(proposal.chapterId ? { sourceChapterId: proposal.chapterId } : {}),
          ...(proposal.sourceRevisionId ? { sourceRevisionId: proposal.sourceRevisionId } : {}),
        })
      } else {
        const current = this.getEntity(proposal.targetId ?? '')
        targetVersion = current.version
        if (proposal.expectedVersion !== null && proposal.expectedVersion !== current.version) {
          throw new NovelForgeError('CONFLICT', `实体版本已变化：期望 ${proposal.expectedVersion}，实际 ${current.version}。`)
        }
        const next = {
          name: payload.name ?? current.name,
          summary: payload.summary ?? current.summary,
          attributesJson: JSON.stringify(payload.attributes ?? parseJson(current.attributesJson, {})),
          status: payload.status ?? current.status,
          role: payload.role ?? current.role,
          goal: payload.goal ?? current.goal,
          motivation: payload.motivation ?? current.motivation,
          flaw: payload.flaw ?? current.flaw,
          secret: payload.secret ?? current.secret,
          voice: payload.voice ?? current.voice,
          arc: payload.arc ?? current.arc,
          aliasesJson: payload.aliases === undefined ? current.aliasesJson : JSON.stringify(payload.aliases),
          firstAppearanceChapterId: payload.firstAppearanceChapterId === undefined
            ? current.firstAppearanceChapterId : payload.firstAppearanceChapterId,
          importance: payload.importance ?? current.importance,
          version: current.version + 1, updatedAt: now(),
        }
        this.db.update(entities).set(next).where(and(eq(entities.id, current.id), eq(entities.version, current.version))).run()
        this.index(current.id, current.projectId, current.kind, current.id, next.status, `${next.name}\n${next.summary}\n${next.attributesJson}`)
        this.audit(current.projectId, 'entity.apply_proposal', current.id, current, next)
      }
    } else if (proposal.targetType === 'event') {
      const timestamp = now()
      const row: StoryEvent = {
        id: proposal.targetId ?? id('event'), projectId: proposal.projectId, chapterId: proposal.chapterId,
        eventTime: payload.eventTime ?? '', summary: payload.summary ?? payload.description ?? '',
        status: payload.status ?? 'confirmed', sourceRevisionId: proposal.sourceRevisionId,
        participantsJson: JSON.stringify(payload.participants ?? []), locationEntityId: payload.locationEntityId ?? null,
        importance: payload.importance ?? 3,
        version: 1, createdAt: timestamp, updatedAt: timestamp,
      }
      if (!row.summary) throw new NovelForgeError('INVALID_INPUT', '事件提议必须包含 summary。')
      this.db.insert(events).values(row).run()
      this.index(row.id, row.projectId, 'event', row.chapterId ?? row.id, row.status, row.summary)
      this.audit(row.projectId, 'event.apply_proposal', row.id, undefined, row)
    } else if (proposal.targetType === 'relation') {
      const timestamp = now()
      const sourceId = payload.sourceId ?? this.resolveEntityIdByName(proposal.projectId, payload.sourceName)
      const targetId = payload.targetId ?? this.resolveEntityIdByName(proposal.projectId, payload.targetName)
      if (!sourceId || !targetId) {
        throw new NovelForgeError('INVALID_INPUT', `关系提议的两端在资料库中不存在：${payload.sourceName ?? payload.sourceId ?? '?'} / ${payload.targetName ?? payload.targetId ?? '?'}。请先应用人物提议。`)
      }
      const existing = this.db.select().from(relations).where(and(
        eq(relations.projectId, proposal.projectId),
        eq(relations.sourceId, sourceId),
        eq(relations.targetId, targetId),
        eq(relations.kind, payload.relationType ?? 'other'),
      )).get()
      if (existing) {
        this.db.update(relations).set({
          tension: payload.tension ?? existing.tension,
          notes: payload.notes ?? existing.notes,
          version: existing.version + 1,
          updatedAt: timestamp,
        }).where(eq(relations.id, existing.id)).run()
        this.audit(proposal.projectId, 'relation.apply_proposal', existing.id, existing, { ...existing, version: existing.version + 1 })
      } else {
        this.createRelation({
          projectId: proposal.projectId, sourceId, targetId,
          kind: payload.relationType ?? 'other',
          ...(payload.tension === undefined ? {} : { tension: payload.tension }),
          ...(payload.notes === undefined ? {} : { notes: payload.notes }),
        })
      }
    } else if (proposal.targetType === 'knowledge') {
      const proposition = payload.proposition?.trim()
      if (!proposition) throw new NovelForgeError('INVALID_INPUT', '知情事实提议必须包含 proposition。')
      const knowers = (payload.knowers ?? [])
        .map(entry => {
          const entityId = this.resolveEntityIdByName(proposal.projectId, entry.name)
          return entityId ? { entityId, state: entry.state } : null
        })
        .filter((entry): entry is { entityId: string; state: 'knows' | 'suspects' | 'misbelieves' | 'unaware' } => entry !== null)
      this.createKnowledge({
        projectId: proposal.projectId,
        proposition,
        ...(payload.truth === undefined ? {} : { truth: payload.truth }),
        ...(payload.publicLevel === undefined ? {} : { publicLevel: payload.publicLevel }),
        ...(proposal.chapterId === undefined || proposal.chapterId === null ? {} : { chapterId: proposal.chapterId }),
        knowers,
      })
    } else if (proposal.targetType === 'thread') {
      const timestamp = now()
      const name = payload.name?.trim()
      if (!name) throw new NovelForgeError('INVALID_INPUT', '剧情线提议必须包含 name。')
      const existing = this.db.select().from(plotThreads)
        .where(and(eq(plotThreads.projectId, proposal.projectId), eq(plotThreads.name, name))).get()
      if (existing) {
        this.db.update(plotThreads).set({
          kind: payload.threadKind ?? existing.kind,
          goal: payload.goal ?? existing.goal,
          summary: payload.summary ?? existing.summary,
          version: existing.version + 1,
          updatedAt: timestamp,
        }).where(eq(plotThreads.id, existing.id)).run()
        this.audit(proposal.projectId, 'thread.apply_proposal', existing.id, existing, { ...existing, version: existing.version + 1 })
      } else {
        this.createPlotThread({
          projectId: proposal.projectId, name,
          ...(payload.threadKind === undefined ? {} : { kind: payload.threadKind }),
          ...(payload.goal === undefined ? {} : { goal: payload.goal }),
          ...(payload.summary === undefined ? {} : { summary: payload.summary }),
        })
      }
    } else {
      const timestamp = now()
      const row: Foreshadowing = {
        id: proposal.targetId ?? id('foreshadowing'), projectId: proposal.projectId,
        name: payload.name ?? '未命名伏笔', description: payload.description ?? payload.summary ?? '',
        plantChapterId: payload.plantChapterId ?? proposal.chapterId,
        payoffChapterId: payload.payoffChapterId ?? null, status: payload.status === 'cancelled' ? 'abandoned' : 'open',
        kind: payload.kind ?? '', importance: payload.importance ?? 3, notes: payload.notes ?? '',
        deadlineChapterId: null,
        version: 1, createdAt: timestamp, updatedAt: timestamp,
      }
      this.db.insert(foreshadowing).values(row).run()
      this.index(row.id, row.projectId, 'foreshadowing', row.plantChapterId ?? row.id, row.status, `${row.name}\n${row.description}`)
      this.audit(row.projectId, 'foreshadowing.apply_proposal', row.id, undefined, row)
    }
    this.db.update(changeProposals).set({ status: 'applied', appliedAt: now() }).where(eq(changeProposals.id, proposal.id)).run()
  }

  applyChange(proposalId: string, approved: boolean): ChangeProposal {
    if (!approved) throw new NovelForgeError('APPROVAL_REQUIRED', '未获得用户批准：应用设定变更必须显式传入 approved: true，未修改任何正式数据。')
    return this.db.transaction(() => {
      const proposal = this.getProposal(proposalId)
      this.applyProposalTx(proposal)
      return this.getProposal(proposalId)
    })
  }

  /**
   * 定稿：只有作者显式批准才能移动章节的正式版本指针。
   * `allowUnreviewed` 仅由「人工工作台」使用（作者本人逐字读过草稿），
   * DSH 工具路径永不传 true，从而保持「模型必须走审查」的硬约束。
   */
  finalizeChapter(revisionId: string, approved: boolean, approvedChangeIds: string[], allowUnreviewed = false): Chapter {
    if (!approved) throw new NovelForgeError('APPROVAL_REQUIRED', '未获得用户批准：定稿必须显式传入 approved: true，章节仍为草稿状态。')
    const revision = this.getRevision(revisionId)
    const chapter = this.getChapter(revision.chapterId)
    const review = this.getLatestReview(revisionId)
    if (!review && !allowUnreviewed) throw new NovelForgeError('WORKFLOW_ERROR', '该版本尚未审查，不能定稿。')
    const blockers = review
      ? this.listReviewIssues(review.id).filter(issue => issue.resolutionStatus === 'open' && issue.severity !== 'minor')
      : []
    if (blockers.length) {
      throw new NovelForgeError('WORKFLOW_ERROR', `仍有 ${blockers.length} 个未解决的 major/critical 审查问题，不能定稿。`, { issueIds: blockers.map(issue => issue.id) })
    }
    return this.db.transaction(() => {
      const timestamp = now()
      this.db.update(chapterRevisions).set({ status: 'finalized', summary: revision.summary || review?.summary || '' })
        .where(eq(chapterRevisions.id, revisionId)).run()
      this.db.update(chapters).set({
        currentRevisionId: revisionId, status: 'finalized', version: chapter.version + 1, updatedAt: timestamp,
      }).where(eq(chapters.id, chapter.id)).run()
      this.index(revision.id, chapter.projectId, 'chapter', chapter.id, 'finalized', revision.content)
      for (const proposalId of approvedChangeIds) {
        const proposal = this.getProposal(proposalId)
        if (proposal.projectId !== chapter.projectId) throw new NovelForgeError('INVALID_INPUT', '定稿附带的变更提议不属于同一小说项目。')
        this.applyProposalTx(proposal)
      }
      this.audit(chapter.projectId, allowUnreviewed && !review ? 'chapter.finalize_manual' : 'chapter.finalize', chapter.id, chapter, { ...chapter, currentRevisionId: revisionId, status: 'finalized' })
      return this.getChapter(chapter.id)
    })
  }

  startWorkflow(projectId: string, taskType: string, chapterId?: string): WorkflowRun {
    const timestamp = now()
    const row: WorkflowRun = {
      id: id('workflow'), projectId, chapterId: chapterId ?? null, taskType,
      state: 'running', checkpointJson: '{}', error: null, createdAt: timestamp, updatedAt: timestamp,
    }
    this.db.insert(workflowRuns).values(row).run()
    return row
  }

  checkpointWorkflow(runId: string, state: string, checkpoint: unknown): void {
    this.db.update(workflowRuns).set({ state, checkpointJson: JSON.stringify(checkpoint), updatedAt: now() })
      .where(eq(workflowRuns.id, runId)).run()
  }

  finishWorkflow(runId: string, state: 'completed' | 'failed' | 'paused', checkpoint: unknown, error?: string): void {
    this.db.update(workflowRuns).set({ state, checkpointJson: JSON.stringify(checkpoint), error: error ?? null, updatedAt: now() })
      .where(eq(workflowRuns.id, runId)).run()
  }

  listWorkflowRuns(projectId: string): WorkflowRun[] {
    return this.db.select().from(workflowRuns).where(eq(workflowRuns.projectId, projectId))
      .orderBy(desc(workflowRuns.updatedAt)).limit(100).all()
  }

  search(projectId: string, query: string, types: string[] = [], limit = 10): SearchResult[] {
    this.getProject(projectId)
    const normalized = requireNonEmpty(query, 'query')
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)))
    const typeFilter = types.length ? ` AND record_type IN (${types.map(() => '?').join(',')})` : ''
    if ([...normalized].length >= 3) {
      try {
        const ftsQuery = normalized.split(/\s+/).map(token => `"${token.replaceAll('"', '""')}"`).join(' OR ')
        return this.handle.sqlite.prepare(
          `SELECT record_id AS recordId, record_type AS recordType, source_id AS sourceId, status,
                  substr(content, 1, 600) AS snippet
           FROM knowledge_fts WHERE project_id = ? AND knowledge_fts MATCH ?${typeFilter}
           ORDER BY rank LIMIT ?`,
        ).all(projectId, ftsQuery, ...types, safeLimit) as SearchResult[]
      } catch {
        // Fall through to substring search for tokenizer/query syntax differences.
      }
    }
    const like = `%${normalized}%`
    const rows: SearchResult[] = []
    for (const row of this.listEntities(projectId)) {
      if (types.length && !types.includes(row.kind)) continue
      const text = `${row.name}\n${row.summary}\n${row.attributesJson}`
      if (text.includes(normalized)) rows.push({ recordId: row.id, recordType: row.kind, sourceId: row.id, status: row.status, snippet: text.slice(0, 600) })
    }
    if (!types.length || types.includes('chapter')) {
      const revisions = this.db.select({ revision: chapterRevisions, chapter: chapters }).from(chapterRevisions)
        .innerJoin(chapters, eq(chapters.id, chapterRevisions.chapterId)).where(eq(chapters.projectId, projectId)).all()
      for (const { revision, chapter } of revisions) {
        if (revision.content.includes(normalized)) rows.push({ recordId: revision.id, recordType: 'chapter', sourceId: chapter.id, status: revision.status, snippet: revision.content.slice(0, 600) })
      }
    }
    if (!types.length || types.includes('event')) {
      for (const row of this.listEvents(projectId)) {
        if (row.summary.includes(normalized)) rows.push({ recordId: row.id, recordType: 'event', sourceId: row.chapterId ?? row.id, status: row.status, snippet: row.summary.slice(0, 600) })
      }
    }
    if (!types.length || types.includes('foreshadowing')) {
      for (const row of this.listForeshadowing(projectId)) {
        const text = `${row.name}
${row.description}`
        if (text.includes(normalized)) rows.push({ recordId: row.id, recordType: 'foreshadowing', sourceId: row.plantChapterId ?? row.id, status: row.status, snippet: text.slice(0, 600) })
      }
    }
    return rows.slice(0, safeLimit)
  }

  // ── 以下是人工工作台（Studio）使用的方法：作者本人可以直接编辑资料，
  //    但所有变更同样写审计日志，并遵循乐观版本检查，绝不静默覆盖。

  updateProject(projectId: string, patch: {
    title?: string | undefined
    genre?: string | undefined
    premise?: string | undefined
    styleGuide?: string | undefined
    status?: string | undefined
    pov?: string | undefined
    tense?: string | undefined
    chapterWordsMin?: number | undefined
    chapterWordsMax?: number | undefined
    targetChapters?: number | undefined
    themes?: string[] | undefined
  }, expectedVersion?: number): Project {
    const current = this.getProject(projectId)
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new NovelForgeError('CONFLICT', `项目版本已变化：期望 ${expectedVersion}，实际 ${current.version}。`)
    }
    const next = {
      title: patch.title === undefined ? current.title : requireNonEmpty(patch.title, 'title'),
      genre: patch.genre === undefined ? current.genre : requireNonEmpty(patch.genre, 'genre'),
      premise: patch.premise === undefined ? current.premise : patch.premise.trim(),
      styleGuide: patch.styleGuide === undefined ? current.styleGuide : patch.styleGuide.trim(),
      status: patch.status ?? current.status,
      pov: patch.pov === undefined ? current.pov : patch.pov.trim(),
      tense: patch.tense === undefined ? current.tense : patch.tense.trim(),
      chapterWordsMin: patch.chapterWordsMin ?? current.chapterWordsMin,
      chapterWordsMax: patch.chapterWordsMax ?? current.chapterWordsMax,
      targetChapters: patch.targetChapters ?? current.targetChapters,
      themesJson: patch.themes === undefined ? current.themesJson : JSON.stringify(patch.themes),
      version: current.version + 1,
      updatedAt: now(),
    }
    this.db.update(projects).set(next).where(and(eq(projects.id, projectId), eq(projects.version, current.version))).run()
    this.audit(projectId, 'project.update', projectId, current, next)
    return this.getProject(projectId)
  }

  updateEntity(entityId: string, patch: {
    name?: string | undefined
    summary?: string | undefined
    kind?: string | undefined
    attributes?: Record<string, unknown> | undefined
    status?: string | undefined
    role?: string | undefined
    goal?: string | undefined
    motivation?: string | undefined
    flaw?: string | undefined
    secret?: string | undefined
    voice?: string | undefined
    arc?: string | undefined
    aliases?: string[] | undefined
    firstAppearanceChapterId?: string | null | undefined
    importance?: number | undefined
  }, expectedVersion?: number): Entity {
    const current = this.getEntity(entityId)
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new NovelForgeError('CONFLICT', `实体版本已变化：期望 ${expectedVersion}，实际 ${current.version}。`)
    }
    const next = {
      name: patch.name === undefined ? current.name : requireNonEmpty(patch.name, 'name'),
      kind: patch.kind ?? current.kind,
      summary: patch.summary === undefined ? current.summary : patch.summary.trim(),
      attributesJson: patch.attributes === undefined ? current.attributesJson : JSON.stringify(patch.attributes),
      status: patch.status ?? current.status,
      role: patch.role === undefined ? current.role : patch.role.trim(),
      goal: patch.goal === undefined ? current.goal : patch.goal.trim(),
      motivation: patch.motivation === undefined ? current.motivation : patch.motivation.trim(),
      flaw: patch.flaw === undefined ? current.flaw : patch.flaw.trim(),
      secret: patch.secret === undefined ? current.secret : patch.secret.trim(),
      voice: patch.voice === undefined ? current.voice : patch.voice.trim(),
      arc: patch.arc === undefined ? current.arc : patch.arc.trim(),
      aliasesJson: patch.aliases === undefined ? current.aliasesJson : JSON.stringify(patch.aliases),
      firstAppearanceChapterId: patch.firstAppearanceChapterId === undefined
        ? current.firstAppearanceChapterId : patch.firstAppearanceChapterId,
      importance: patch.importance ?? current.importance,
      version: current.version + 1,
      updatedAt: now(),
    }
    this.db.update(entities).set(next).where(and(eq(entities.id, entityId), eq(entities.version, current.version))).run()
    this.index(entityId, current.projectId, next.kind, entityId, next.status, `${next.name}\n${next.summary}\n${next.attributesJson}`)
    this.audit(current.projectId, 'entity.update', entityId, current, next)
    return this.getEntity(entityId)
  }

  updateOutline(outlineId: string, patch: {
    title?: string | undefined
    content?: string | undefined
    status?: string | undefined
  }, expectedVersion?: number): Outline {
    const current = this.getOutline(outlineId)
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new NovelForgeError('CONFLICT', `大纲版本已变化：期望 ${expectedVersion}，实际 ${current.version}。`)
    }
    const next = {
      title: patch.title === undefined ? current.title : requireNonEmpty(patch.title, 'title'),
      content: patch.content === undefined ? current.content : patch.content,
      status: patch.status ?? current.status,
      version: current.version + 1,
      updatedAt: now(),
    }
    this.db.update(outlines).set(next).where(and(eq(outlines.id, outlineId), eq(outlines.version, current.version))).run()
    this.audit(current.projectId, 'outline.update', outlineId, current, next)
    return this.getOutline(outlineId)
  }

  updateEvent(eventId: string, patch: {
    summary?: string | undefined
    eventTime?: string | undefined
    status?: string | undefined
    chapterId?: string | null | undefined
  }, expectedVersion?: number): StoryEvent {
    const current = this.db.select().from(events).where(eq(events.id, eventId)).get()
    if (!current) throw new NovelForgeError('NOT_FOUND', `事件不存在：${eventId}`)
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new NovelForgeError('CONFLICT', `事件版本已变化：期望 ${expectedVersion}，实际 ${current.version}。`)
    }
    const next = {
      summary: patch.summary === undefined ? current.summary : requireNonEmpty(patch.summary, 'summary'),
      eventTime: patch.eventTime === undefined ? current.eventTime : patch.eventTime,
      status: patch.status ?? current.status,
      chapterId: patch.chapterId === undefined ? current.chapterId : patch.chapterId,
      version: current.version + 1,
      updatedAt: now(),
    }
    this.db.update(events).set(next).where(and(eq(events.id, eventId), eq(events.version, current.version))).run()
    this.index(eventId, current.projectId, 'event', next.chapterId ?? eventId, next.status, next.summary)
    this.audit(current.projectId, 'event.update', eventId, current, next)
    return this.db.select().from(events).where(eq(events.id, eventId)).get() as StoryEvent
  }

  updateForeshadowing(foreshadowingId: string, patch: {
    name?: string | undefined
    description?: string | undefined
    status?: string | undefined
    plantChapterId?: string | null | undefined
    payoffChapterId?: string | null | undefined
    kind?: string | undefined
    importance?: number | undefined
    notes?: string | undefined
    deadlineChapterId?: number | null | undefined
  }, expectedVersion?: number): Foreshadowing {
    const current = this.db.select().from(foreshadowing).where(eq(foreshadowing.id, foreshadowingId)).get()
    if (!current) throw new NovelForgeError('NOT_FOUND', `伏笔不存在：${foreshadowingId}`)
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new NovelForgeError('CONFLICT', `伏笔版本已变化：期望 ${expectedVersion}，实际 ${current.version}。`)
    }
    const next = {
      name: patch.name === undefined ? current.name : requireNonEmpty(patch.name, 'name'),
      description: patch.description === undefined ? current.description : patch.description,
      status: patch.status ?? current.status,
      plantChapterId: patch.plantChapterId === undefined ? current.plantChapterId : patch.plantChapterId,
      payoffChapterId: patch.payoffChapterId === undefined ? current.payoffChapterId : patch.payoffChapterId,
      kind: patch.kind ?? current.kind,
      importance: patch.importance ?? current.importance,
      notes: patch.notes === undefined ? current.notes : patch.notes,
      deadlineChapterId: patch.deadlineChapterId === undefined ? current.deadlineChapterId : patch.deadlineChapterId,
      version: current.version + 1,
      updatedAt: now(),
    }
    this.db.update(foreshadowing).set(next).where(and(eq(foreshadowing.id, foreshadowingId), eq(foreshadowing.version, current.version))).run()
    this.index(foreshadowingId, current.projectId, 'foreshadowing', next.plantChapterId ?? foreshadowingId, next.status, `${next.name}\n${next.description}`)
    this.audit(current.projectId, 'foreshadowing.update', foreshadowingId, current, next)
    return this.db.select().from(foreshadowing).where(eq(foreshadowing.id, foreshadowingId)).get() as Foreshadowing
  }

  rejectProposal(proposalId: string): ChangeProposal {
    const proposal = this.getProposal(proposalId)
    if (proposal.status !== 'pending') throw new NovelForgeError('CONFLICT', `提议 ${proposalId} 当前状态为 ${proposal.status}，不能驳回。`)
    this.db.update(changeProposals).set({ status: 'rejected', appliedAt: now() }).where(eq(changeProposals.id, proposalId)).run()
    this.audit(proposal.projectId, 'proposal.reject', proposalId, proposal, { ...proposal, status: 'rejected' })
    return this.getProposal(proposalId)
  }

  updateIssueStatus(issueId: string, status: string): ReviewIssue {
    const current = this.db.select().from(reviewIssues).where(eq(reviewIssues.id, issueId)).get()
    if (!current) throw new NovelForgeError('NOT_FOUND', `审查问题不存在：${issueId}`)
    this.db.update(reviewIssues).set({ resolutionStatus: status }).where(eq(reviewIssues.id, issueId)).run()
    const run = this.getReviewRun(current.reviewRunId)
    const chapter = this.getChapter(run.chapterId)
    this.audit(chapter.projectId, 'issue.update', issueId, current, { ...current, resolutionStatus: status })
    return this.db.select().from(reviewIssues).where(eq(reviewIssues.id, issueId)).get() as ReviewIssue
  }

  getProjectOverview(projectId: string): ProjectOverview {
    const project = this.getProject(projectId)
    const chapterRows = this.listChapters(projectId)
    const totalRevisions = this.db.select({ count: sql<number>`count(*)` }).from(chapterRevisions)
      .innerJoin(chapters, eq(chapters.id, chapterRevisions.chapterId))
      .where(eq(chapters.projectId, projectId)).get()?.count ?? 0
    const revisionRows = this.db.select().from(chapterRevisions)
      .innerJoin(chapters, eq(chapters.id, chapterRevisions.chapterId))
      .where(eq(chapters.projectId, projectId)).orderBy(desc(chapterRevisions.createdAt)).limit(12).all()
      .map(row => row.chapter_revisions)
    const openIssues = this.db.select({
        id: reviewIssues.id, reviewRunId: reviewIssues.reviewRunId, category: reviewIssues.category,
        severity: reviewIssues.severity, locationStart: reviewIssues.locationStart, locationEnd: reviewIssues.locationEnd,
        issue: reviewIssues.issue, evidenceJson: reviewIssues.evidenceJson,
        suggestedFix: reviewIssues.suggestedFix, resolutionStatus: reviewIssues.resolutionStatus,
        chapterId: chapters.id, chapterNo: chapters.chapterNo, chapterTitle: chapters.title,
      }).from(reviewIssues)
      .innerJoin(reviewRuns, eq(reviewRuns.id, reviewIssues.reviewRunId))
      .innerJoin(chapters, eq(chapters.id, reviewRuns.chapterId))
      .where(and(eq(chapters.projectId, projectId), eq(reviewIssues.resolutionStatus, 'open')))
      .all().filter(row => row.severity !== 'minor')
    const pendingProposals = this.listProposals(projectId, 'pending')
    const openForeshadowing = this.listForeshadowing(projectId).filter(row => row.status === 'open' || row.status === 'reinforced')
    const finalList = this.listFinalChapters(projectId)
    const currentChapter = chapterRows.find(chapter => chapter.status !== 'finalized') ?? null
    return {
      project,
      counts: {
        chapters: chapterRows.length,
        finalizedChapters: finalList.length,
        entities: this.listEntities(projectId).length,
        events: this.listEvents(projectId).length,
        foreshadowingOpen: openForeshadowing.length,
        pendingProposals: pendingProposals.length,
        openIssues: openIssues.length,
        revisions: totalRevisions,
        relations: this.listRelations(projectId).length,
        threads: this.listPlotThreads(projectId).length,
        scenes: this.db.select({ count: sql<number>`count(*)` }).from(scenes).where(eq(scenes.projectId, projectId)).get()?.count ?? 0,
        ingestBatches: this.listIngestBatches(projectId).length,
        overdueForeshadowing: this.listOverdueForeshadowing(projectId).length,
      },
      currentChapter,
      openIssues,
      openForeshadowing,
      pendingProposals,
      recentWorkflows: this.listWorkflowRuns(projectId).slice(0, 8),
      recentRevisions: revisionRows,
      lastFinalized: finalList.at(-1) ?? null,
    }
  }

  getChapterDetail(chapterId: string): {
    chapter: Chapter
    outline: Outline | null
    revisions: ChapterRevision[]
    latestRevision: ChapterRevision | null
    latestReview: { run: ReviewRun; issues: ReviewIssue[] } | null
  } {
    const chapter = this.getChapter(chapterId)
    const outline = chapter.outlineId ? this.getOutline(chapter.outlineId) : null
    const revisions = this.listRevisions(chapterId)
    const latestRevision = revisions[0] ?? null
    const run = latestRevision ? this.getLatestReview(latestRevision.id) : undefined
    return {
      chapter,
      outline,
      revisions,
      latestRevision,
      latestReview: run ? { run, issues: this.listReviewIssues(run.id) } : null,
    }
  }

  listReviewRuns(projectId: string): Array<{ run: ReviewRun; chapter: { id: string; chapterNo: number; title: string }; issueCount: number; openCount: number }> {
    const rows = this.db.select({ run: reviewRuns, chapter: chapters }).from(reviewRuns)
      .innerJoin(chapters, eq(chapters.id, reviewRuns.chapterId))
      .where(eq(chapters.projectId, projectId))
      .orderBy(desc(reviewRuns.createdAt)).all()
    return rows.map(({ run, chapter }) => {
      const issues = this.listReviewIssues(run.id)
      return {
        run,
        chapter: { id: chapter.id, chapterNo: chapter.chapterNo, title: chapter.title },
        issueCount: issues.length,
        openCount: issues.filter(issue => issue.resolutionStatus === 'open').length,
      }
    })
  }

  /** 作者手动新增事件（工作台不需要模型也能管理时间线）。 */
  createEvent(input: {
    projectId: string
    summary: string
    eventTime?: string | undefined
    status?: string | undefined
    chapterId?: string | undefined
    participants?: string[] | undefined
    locationEntityId?: string | null | undefined
    importance?: number | undefined
  }): StoryEvent {
    this.getProject(input.projectId)
    const timestamp = now()
    const row: StoryEvent = {
      id: id('event'), projectId: input.projectId, chapterId: input.chapterId ?? null,
      eventTime: input.eventTime?.trim() ?? '', summary: requireNonEmpty(input.summary, 'summary'),
      status: input.status ?? 'confirmed', sourceRevisionId: null,
      participantsJson: JSON.stringify(input.participants ?? []), locationEntityId: input.locationEntityId ?? null,
      importance: input.importance ?? 3,
      version: 1, createdAt: timestamp, updatedAt: timestamp,
    }
    this.db.insert(events).values(row).run()
    this.index(row.id, row.projectId, 'event', row.chapterId ?? row.id, row.status, row.summary)
    this.audit(row.projectId, 'event.create', row.id, undefined, row)
    return row
  }

  /** 作者手动新增伏笔。 */
  createForeshadowing(input: {
    projectId: string
    name: string
    description?: string | undefined
    status?: string | undefined
    plantChapterId?: string | undefined
    payoffChapterId?: string | undefined
    kind?: string | undefined
    importance?: number | undefined
    notes?: string | undefined
  }): Foreshadowing {
    this.getProject(input.projectId)
    const timestamp = now()
    const row: Foreshadowing = {
      id: id('foreshadowing'), projectId: input.projectId, name: requireNonEmpty(input.name, 'name'),
      description: input.description?.trim() ?? '', plantChapterId: input.plantChapterId ?? null,
      payoffChapterId: input.payoffChapterId ?? null, status: input.status ?? 'open',
      kind: input.kind ?? '', importance: input.importance ?? 3, notes: input.notes ?? '',
      deadlineChapterId: null,
      version: 1, createdAt: timestamp, updatedAt: timestamp,
    }
    this.db.insert(foreshadowing).values(row).run()
    this.index(row.id, row.projectId, 'foreshadowing', row.plantChapterId ?? row.id, row.status, `${row.name}
${row.description}`)
    this.audit(row.projectId, 'foreshadowing.create', row.id, undefined, row)
    return row
  }

  /** 作者手动新增章节：同时建一条章级大纲，保证工作台里始终有可编辑的章节目标。 */
  createChapter(projectId: string, input: { title: string; chapterNo?: number | undefined }): { chapter: Chapter; outline: Outline } {
    this.getProject(projectId)
    return this.db.transaction(() => {
      const latest = this.db.select({ chapterNo: chapters.chapterNo }).from(chapters)
        .where(eq(chapters.projectId, projectId)).orderBy(desc(chapters.chapterNo)).limit(1).get()
      let chapterNo = input.chapterNo ?? (latest?.chapterNo ?? 0) + 1
      if (!Number.isInteger(chapterNo) || chapterNo < 1) chapterNo = (latest?.chapterNo ?? 0) + 1
      while (this.db.select({ id: chapters.id }).from(chapters)
        .where(and(eq(chapters.projectId, projectId), eq(chapters.chapterNo, chapterNo))).get()) {
        chapterNo += 1
      }
      const timestamp = now()
      const title = requireNonEmpty(input.title, '章节标题')
      const outlineRow: Outline = {
        id: id('outline'), projectId, parentId: null, level: 'chapter', chapterNo,
        title, content: JSON.stringify({ summary: '', goal: '', conflict: '', hook: '' }),
        status: 'planned', version: 1, createdAt: timestamp, updatedAt: timestamp,
      }
      this.db.insert(outlines).values(outlineRow).run()
      const chapterRow: Chapter = {
        id: id('chapter'), projectId, outlineId: outlineRow.id, chapterNo,
        title, status: 'planned', currentRevisionId: null,
        summary: '', povEntityId: null, targetWords: 0, version: 1,
        createdAt: timestamp, updatedAt: timestamp,
      }
      this.db.insert(chapters).values(chapterRow).run()
      this.audit(projectId, 'chapter.create', chapterRow.id, undefined, chapterRow)
      return { chapter: chapterRow, outline: outlineRow }
    })
  }

  updateChapter(chapterId: string, patch: { title?: string | undefined; status?: string | undefined }, expectedVersion?: number): Chapter {
    const current = this.getChapter(chapterId)
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new NovelForgeError('CONFLICT', `章节版本已变化：期望 ${expectedVersion}，实际 ${current.version}。`)
    }
    const next = {
      title: patch.title === undefined ? current.title : requireNonEmpty(patch.title, '章节标题'),
      status: patch.status ?? current.status,
      version: current.version + 1,
      updatedAt: now(),
    }
    this.db.update(chapters).set(next).where(and(eq(chapters.id, chapterId), eq(chapters.version, current.version))).run()
    if (current.outlineId) {
      const outline = this.getOutline(current.outlineId)
      this.db.update(outlines).set({ title: next.title, version: outline.version + 1, updatedAt: now() })
        .where(eq(outlines.id, current.outlineId)).run()
    }
    this.audit(current.projectId, 'chapter.update', chapterId, current, next)
    return this.getChapter(chapterId)
  }

  listChapterSummaries(projectId: string): ChapterSummary[] {
    const chapterRows = this.listChapters(projectId)
    const revisionRows = this.db.select({
      id: chapterRevisions.id, chapterId: chapterRevisions.chapterId, revisionNo: chapterRevisions.revisionNo,
      status: chapterRevisions.status, kind: chapterRevisions.kind, createdAt: chapterRevisions.createdAt,
    }).from(chapterRevisions).innerJoin(chapters, eq(chapters.id, chapterRevisions.chapterId))
      .where(eq(chapters.projectId, projectId)).all()
    const lengths = new Map<string, number>()
    for (const row of this.handle.sqlite.prepare(
      'SELECT r.id AS id, length(r.content) AS len FROM chapter_revisions r JOIN chapters c ON c.id = r.chapter_id WHERE c.project_id = ?',
    ).all(projectId) as Array<{ id: string; len: number }>) {
      lengths.set(row.id, row.len)
    }
    const grouped = new Map<string, typeof revisionRows>()
    for (const row of revisionRows) {
      const list = grouped.get(row.chapterId)
      if (list) list.push(row)
      else grouped.set(row.chapterId, [row])
    }
    return chapterRows.map(chapter => {
      const list = (grouped.get(chapter.id) ?? []).slice().sort((a, b) => b.revisionNo - a.revisionNo)
      const head = list[0]
      return {
        chapter,
        revisionCount: list.length,
        latest: head
          ? {
            id: head.id, revisionNo: head.revisionNo, status: head.status, kind: head.kind,
            words: lengths.get(head.id) ?? 0, createdAt: head.createdAt,
          }
          : null,
      }
    })
  }

  listAuditEntries(projectId: string, limit = 50): AuditEntry[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)))
    return this.db.select().from(auditLog).where(eq(auditLog.projectId, projectId))
      .orderBy(desc(auditLog.createdAt)).limit(safeLimit).all()
  }

  // ── 关系 ──────────────────────────────────────────────
  listRelations(projectId: string): RelationView[] {
    const rows = this.db.select().from(relations)
      .where(eq(relations.projectId, projectId))
      .orderBy(asc(relations.kind), asc(relations.createdAt)).all()
    const names = new Map<string, string>()
    for (const entity of this.listEntities(projectId)) names.set(entity.id, entity.name)
    return rows.map(row => ({
      ...row,
      sourceName: names.get(row.sourceId) ?? row.sourceId,
      targetName: names.get(row.targetId) ?? row.targetId,
    }))
  }

  createRelation(input: {
    projectId: string
    sourceId: string
    targetId: string
    kind: string
    tension?: string | undefined
    notes?: string | undefined
    sinceChapterId?: string | null | undefined
  }): Relation {
    this.getProject(input.projectId)
    const timestamp = now()
    const row: Relation = {
      id: id('relation'), projectId: input.projectId, sourceId: input.sourceId, targetId: input.targetId,
      kind: requireNonEmpty(input.kind, 'kind'), tension: input.tension?.trim() ?? '',
      notes: input.notes?.trim() ?? '', sinceChapterId: input.sinceChapterId ?? null,
      status: 'active', version: 1, createdAt: timestamp, updatedAt: timestamp,
    }
    this.db.insert(relations).values(row).run()
    this.audit(row.projectId, 'relation.create', row.id, undefined, row)
    return row
  }

  updateRelation(relationId: string, patch: {
    kind?: string | undefined
    tension?: string | undefined
    notes?: string | undefined
    status?: string | undefined
    sinceChapterId?: string | null | undefined
  }, expectedVersion?: number): Relation {
    const current = this.db.select().from(relations).where(eq(relations.id, relationId)).get()
    if (!current) throw new NovelForgeError('NOT_FOUND', `关系不存在：${relationId}`)
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new NovelForgeError('CONFLICT', `关系版本已变化：期望 ${expectedVersion}，实际 ${current.version}。`)
    }
    const next = {
      kind: patch.kind === undefined ? current.kind : requireNonEmpty(patch.kind, 'kind'),
      tension: patch.tension === undefined ? current.tension : patch.tension,
      notes: patch.notes === undefined ? current.notes : patch.notes,
      status: patch.status ?? current.status,
      sinceChapterId: patch.sinceChapterId === undefined ? current.sinceChapterId : patch.sinceChapterId,
      version: current.version + 1, updatedAt: now(),
    }
    this.db.update(relations).set(next).where(and(eq(relations.id, relationId), eq(relations.version, current.version))).run()
    this.audit(current.projectId, 'relation.update', relationId, current, next)
    return this.db.select().from(relations).where(eq(relations.id, relationId)).get() as Relation
  }

  // ── 剧情线 ────────────────────────────────────────────
  listPlotThreads(projectId: string): PlotThread[] {
    return this.db.select().from(plotThreads).where(eq(plotThreads.projectId, projectId))
      .orderBy(asc(plotThreads.kind), asc(plotThreads.createdAt)).all()
  }

  createPlotThread(input: {
    projectId: string
    name: string
    kind?: string | undefined
    goal?: string | undefined
    summary?: string | undefined
    currentChapterId?: string | undefined
  }): PlotThread {
    this.getProject(input.projectId)
    const timestamp = now()
    const row: PlotThread = {
      id: id('thread'), projectId: input.projectId, name: requireNonEmpty(input.name, 'name'),
      kind: input.kind ?? 'main', goal: input.goal?.trim() ?? '', summary: input.summary?.trim() ?? '',
      status: 'active', currentChapterId: input.currentChapterId ?? null,
      version: 1, createdAt: timestamp, updatedAt: timestamp,
    }
    this.db.insert(plotThreads).values(row).run()
    this.audit(row.projectId, 'thread.create', row.id, undefined, row)
    return row
  }

  updatePlotThread(threadId: string, patch: {
    name?: string | undefined
    kind?: string | undefined
    goal?: string | undefined
    summary?: string | undefined
    status?: string | undefined
    currentChapterId?: string | null | undefined
  }, expectedVersion?: number): PlotThread {
    const current = this.db.select().from(plotThreads).where(eq(plotThreads.id, threadId)).get()
    if (!current) throw new NovelForgeError('NOT_FOUND', `剧情线不存在：${threadId}`)
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new NovelForgeError('CONFLICT', `剧情线版本已变化：期望 ${expectedVersion}，实际 ${current.version}。`)
    }
    const next = {
      name: patch.name === undefined ? current.name : requireNonEmpty(patch.name, 'name'),
      kind: patch.kind ?? current.kind,
      goal: patch.goal === undefined ? current.goal : patch.goal,
      summary: patch.summary === undefined ? current.summary : patch.summary,
      status: patch.status ?? current.status,
      currentChapterId: patch.currentChapterId === undefined ? current.currentChapterId : patch.currentChapterId,
      version: current.version + 1, updatedAt: now(),
    }
    this.db.update(plotThreads).set(next).where(and(eq(plotThreads.id, threadId), eq(plotThreads.version, current.version))).run()
    this.audit(current.projectId, 'thread.update', threadId, current, next)
    return this.db.select().from(plotThreads).where(eq(plotThreads.id, threadId)).get() as PlotThread
  }

  // ── 场景 / 节拍 ───────────────────────────────────────
  listScenes(chapterId: string): SceneView[] {
    const chapter = this.getChapter(chapterId)
    const rows = this.db.select().from(scenes).where(eq(scenes.chapterId, chapterId)).orderBy(asc(scenes.sceneNo)).all()
    const names = new Map<string, string>()
    for (const entity of this.listEntities(chapter.projectId)) names.set(entity.id, entity.name)
    return rows.map(row => ({
      ...row,
      castNames: (parseJson(row.castJson, []) as string[]).map(castId => names.get(castId) ?? castId),
      locationName: row.locationEntityId ? (names.get(row.locationEntityId) ?? row.locationEntityId) : null,
    }))
  }

  createScene(input: {
    chapterId: string
    sceneNo?: number | undefined
    beat?: string | undefined
    goal?: string | undefined
    conflict?: string | undefined
    outcome?: string | undefined
    locationEntityId?: string | null | undefined
    cast?: string[] | undefined
    povEntityId?: string | null | undefined
    notes?: string | undefined
  }): Scene {
    const chapter = this.getChapter(input.chapterId)
    const latest = this.db.select({ sceneNo: scenes.sceneNo }).from(scenes).where(eq(scenes.chapterId, chapter.id))
      .orderBy(desc(scenes.sceneNo)).limit(1).get()
    const timestamp = now()
    const row: Scene = {
      id: id('scene'), projectId: chapter.projectId, chapterId: chapter.id,
      sceneNo: input.sceneNo ?? (latest?.sceneNo ?? 0) + 1,
      beat: input.beat?.trim() ?? '', goal: input.goal?.trim() ?? '', conflict: input.conflict?.trim() ?? '',
      outcome: input.outcome?.trim() ?? '', locationEntityId: input.locationEntityId ?? null,
      castJson: JSON.stringify(input.cast ?? []), povEntityId: input.povEntityId ?? null,
      notes: input.notes?.trim() ?? '', status: 'planned', version: 1,
      createdAt: timestamp, updatedAt: timestamp,
    }
    this.db.insert(scenes).values(row).run()
    this.audit(chapter.projectId, 'scene.create', row.id, undefined, row)
    return row
  }

  updateScene(sceneId: string, patch: {
    beat?: string | undefined
    goal?: string | undefined
    conflict?: string | undefined
    outcome?: string | undefined
    locationEntityId?: string | null | undefined
    cast?: string[] | undefined
    povEntityId?: string | null | undefined
    notes?: string | undefined
    status?: string | undefined
  }, expectedVersion?: number): Scene {
    const current = this.db.select().from(scenes).where(eq(scenes.id, sceneId)).get()
    if (!current) throw new NovelForgeError('NOT_FOUND', `场景不存在：${sceneId}`)
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new NovelForgeError('CONFLICT', `场景版本已变化：期望 ${expectedVersion}，实际 ${current.version}。`)
    }
    const next = {
      beat: patch.beat === undefined ? current.beat : patch.beat,
      goal: patch.goal === undefined ? current.goal : patch.goal,
      conflict: patch.conflict === undefined ? current.conflict : patch.conflict,
      outcome: patch.outcome === undefined ? current.outcome : patch.outcome,
      locationEntityId: patch.locationEntityId === undefined ? current.locationEntityId : patch.locationEntityId,
      castJson: patch.cast === undefined ? current.castJson : JSON.stringify(patch.cast),
      povEntityId: patch.povEntityId === undefined ? current.povEntityId : patch.povEntityId,
      notes: patch.notes === undefined ? current.notes : patch.notes,
      status: patch.status ?? current.status,
      version: current.version + 1, updatedAt: now(),
    }
    this.db.update(scenes).set(next).where(and(eq(scenes.id, sceneId), eq(scenes.version, current.version))).run()
    this.audit(current.projectId, 'scene.update', sceneId, current, next)
    return this.db.select().from(scenes).where(eq(scenes.id, sceneId)).get() as Scene
  }

  deleteScene(sceneId: string): { ok: true } {
    const current = this.db.select().from(scenes).where(eq(scenes.id, sceneId)).get()
    if (!current) throw new NovelForgeError('NOT_FOUND', `场景不存在：${sceneId}`)
    this.db.delete(scenes).where(eq(scenes.id, sceneId)).run()
    this.audit(current.projectId, 'scene.delete', sceneId, current, undefined)
    return { ok: true }
  }

  // ── 人物状态快照 ───────────────────────────────────────
  listCharacterStates(characterId: string): CharacterState[] {
    return this.db.select().from(characterStates).where(eq(characterStates.characterId, characterId))
      .orderBy(desc(characterStates.createdAt)).all()
  }

  createCharacterState(input: {
    characterId: string
    chapterId?: string | null | undefined
    summary?: string | undefined
    state?: Record<string, unknown> | undefined
  }): CharacterState {
    const entity = this.getEntity(input.characterId)
    const row: CharacterState = {
      id: id('cstate'), projectId: entity.projectId, characterId: entity.id,
      chapterId: input.chapterId ?? null, summary: input.summary?.trim() ?? '',
      stateJson: JSON.stringify(input.state ?? {}), createdAt: now(),
    }
    this.db.insert(characterStates).values(row).run()
    this.audit(entity.projectId, 'character_state.create', row.id, undefined, row)
    return row
  }

  // ── 素材导入 ──────────────────────────────────────────
  createIngestBatch(input: { projectId: string; title?: string; sourceText: string; mode?: string; focus?: string; model?: string }): IngestBatch {
    this.getProject(input.projectId)
    const row: IngestBatch = {
      id: id('ingest'), projectId: input.projectId, title: input.title?.trim() ?? '',
      sourceText: requireNonEmpty(input.sourceText, '素材正文'), mode: input.mode ?? 'propose',
      status: 'analyzing', focus: input.focus?.trim() ?? '', model: input.model ?? '',
      statsJson: '{}', error: null, createdAt: now(), appliedAt: null,
    }
    this.db.insert(ingestBatches).values(row).run()
    this.audit(row.projectId, 'ingest.create', row.id, undefined, { title: row.title, chars: row.sourceText.length })
    return row
  }

  updateIngestBatch(batchId: string, patch: {
    status?: string | undefined
    stats?: unknown
    error?: string | null | undefined
    appliedAt?: string | null | undefined
  }): IngestBatch {
    const current = this.getIngestBatch(batchId)
    const next = {
      status: patch.status ?? current.status,
      statsJson: patch.stats === undefined ? current.statsJson : JSON.stringify(patch.stats),
      error: patch.error === undefined ? current.error : patch.error,
      appliedAt: patch.appliedAt === undefined ? current.appliedAt : patch.appliedAt,
    }
    this.db.update(ingestBatches).set(next).where(eq(ingestBatches.id, batchId)).run()
    return this.getIngestBatch(batchId)
  }

  getIngestBatch(batchId: string): IngestBatch {
    const row = this.db.select().from(ingestBatches).where(eq(ingestBatches.id, batchId)).get()
    if (!row) throw new NovelForgeError('NOT_FOUND', `素材导入批次不存在：${batchId}`)
    return row
  }

  listIngestBatches(projectId: string): IngestBatch[] {
    return this.db.select().from(ingestBatches).where(eq(ingestBatches.projectId, projectId))
      .orderBy(desc(ingestBatches.createdAt)).limit(50).all()
  }

  listProposalsByBatch(batchId: string): ChangeProposal[] {
    return this.db.select().from(changeProposals).where(eq(changeProposals.batchId, batchId))
      .orderBy(asc(changeProposals.createdAt)).all()
  }

  /** 按名称或别名解析实体 ID；用于关系提议在「人物与关系同一批导入」时的延迟解析。 */
  resolveEntityIdByName(projectId: string, name: string | undefined): string | null {
    const target = name?.trim().toLowerCase()
    if (!target) return null
    for (const entity of this.listEntities(projectId)) {
      if (entity.name.trim().toLowerCase() === target) return entity.id
      const aliases = parseJson<string[]>(entity.aliasesJson, [])
      if (aliases.some(alias => alias.trim().toLowerCase() === target)) return entity.id
    }
    return null
  }

  /** 应用一个导入批次里的待审批提议；逐条事务，失败不中止其余，返回成功/失败明细。 */
  applyIngestBatch(batchId: string, approved: boolean): { applied: string[]; failed: Array<{ id: string; error: string }> } {
    if (!approved) throw new NovelForgeError('APPROVAL_REQUIRED', '未获得用户批准：应用素材导入必须显式传入 approved: true。')
    const batch = this.getIngestBatch(batchId)
    const applied: string[] = []
    const failed: Array<{ id: string; error: string }> = []
    // 关系提议依赖两端实体已落库，放在最后应用，避免同批导入时解析不到 ID。
    const order: Record<string, number> = { entity: 0, thread: 1, foreshadowing: 2, event: 3, relation: 9 }
    const proposals = this.listProposalsByBatch(batchId)
      .slice()
      .sort((left, right) => (order[left.targetType] ?? 5) - (order[right.targetType] ?? 5))
    for (const proposal of proposals) {
      if (proposal.status !== 'pending') continue
      try {
        this.applyChange(proposal.id, true)
        applied.push(proposal.id)
      } catch (error) {
        failed.push({ id: proposal.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    this.updateIngestBatch(batchId, {
      status: failed.length ? 'partially_applied' : 'applied',
      appliedAt: now(),
      stats: { ...(parseJson(batch.statsJson, {}) as Record<string, unknown>), applied: applied.length, failed: failed.length },
    })
    this.audit(batch.projectId, 'ingest.apply', batchId, undefined, { applied: applied.length, failed: failed.length })
    return { applied, failed }
  }


  // ── 知情矩阵 ──────────────────────────────────────────
  listKnowledge(projectId: string): KnowledgeView[] {
    const rows = this.db.select().from(knowledgeFacts).where(eq(knowledgeFacts.projectId, projectId))
      .orderBy(asc(knowledgeFacts.publicLevel), desc(knowledgeFacts.updatedAt)).all()
    const entities = this.listEntities(projectId)
    const nameById = new Map(entities.map(entity => [entity.id, entity.name]))
    const chapters = this.listChapters(projectId)
    const chapterNo = new Map(chapters.map(chapter => [chapter.id, chapter.chapterNo]))
    return rows.map(row => ({
      ...row,
      knowers: (parseJson<KnowerEntry[]>(row.knowersJson, [])).map(entry => ({
        ...entry,
        name: nameById.get(entry.entityId) ?? entry.entityId,
      })),
      chapterNo: row.chapterId ? (chapterNo.get(row.chapterId) ?? null) : null,
    }))
  }

  createKnowledge(input: {
    projectId: string
    proposition: string
    truth?: string | undefined
    publicLevel?: string | undefined
    chapterId?: string | null | undefined
    knowers?: KnowerEntry[] | undefined
    notes?: string | undefined
  }): KnowledgeFact {
    this.getProject(input.projectId)
    const timestamp = now()
    const row: KnowledgeFact = {
      id: id('knowledge'), projectId: input.projectId,
      proposition: requireNonEmpty(input.proposition, 'proposition'),
      truth: input.truth ?? 'true', publicLevel: input.publicLevel ?? 'secret',
      chapterId: input.chapterId ?? null, knowersJson: JSON.stringify(input.knowers ?? []),
      notes: input.notes?.trim() ?? '', version: 1, createdAt: timestamp, updatedAt: timestamp,
    }
    this.db.insert(knowledgeFacts).values(row).run()
    this.index(row.id, row.projectId, 'knowledge', row.id, row.truth, `${row.proposition}\n${row.notes}`)
    this.audit(row.projectId, 'knowledge.create', row.id, undefined, row)
    return row
  }

  updateKnowledge(factId: string, patch: {
    proposition?: string | undefined
    truth?: string | undefined
    publicLevel?: string | undefined
    chapterId?: string | null | undefined
    knowers?: KnowerEntry[] | undefined
    notes?: string | undefined
  }, expectedVersion?: number): KnowledgeFact {
    const current = this.db.select().from(knowledgeFacts).where(eq(knowledgeFacts.id, factId)).get()
    if (!current) throw new NovelForgeError('NOT_FOUND', `知情事实不存在：${factId}`)
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new NovelForgeError('CONFLICT', `知情事实版本已变化：期望 ${expectedVersion}，实际 ${current.version}。`)
    }
    const next = {
      proposition: patch.proposition === undefined ? current.proposition : requireNonEmpty(patch.proposition, 'proposition'),
      truth: patch.truth ?? current.truth,
      publicLevel: patch.publicLevel ?? current.publicLevel,
      chapterId: patch.chapterId === undefined ? current.chapterId : patch.chapterId,
      knowersJson: patch.knowers === undefined ? current.knowersJson : JSON.stringify(patch.knowers),
      notes: patch.notes === undefined ? current.notes : patch.notes,
      version: current.version + 1, updatedAt: now(),
    }
    this.db.update(knowledgeFacts).set(next).where(and(eq(knowledgeFacts.id, factId), eq(knowledgeFacts.version, current.version))).run()
    this.index(factId, current.projectId, 'knowledge', factId, next.truth, `${next.proposition}\n${next.notes}`)
    this.audit(current.projectId, 'knowledge.update', factId, current, next)
    return this.db.select().from(knowledgeFacts).where(eq(knowledgeFacts.id, factId)).get() as KnowledgeFact
  }

  deleteKnowledge(factId: string): { ok: true } {
    const current = this.db.select().from(knowledgeFacts).where(eq(knowledgeFacts.id, factId)).get()
    if (!current) throw new NovelForgeError('NOT_FOUND', `知情事实不存在：${factId}`)
    this.db.delete(knowledgeFacts).where(eq(knowledgeFacts.id, factId)).run()
    this.unindex(factId)
    this.audit(current.projectId, 'knowledge.delete', factId, current, undefined)
    return { ok: true }
  }

  /** 某个角色当前知道/怀疑/误信/不知道哪些事——写作时防止「开天眼」。 */
  listKnowledgeForEntity(entityId: string): KnowledgeView[] {
    const entity = this.getEntity(entityId)
    return this.listKnowledge(entity.projectId).filter(view =>
      view.knowers.some(entry => entry.entityId === entityId))
  }

  // ── 伏笔逾期 ──────────────────────────────────────────
  /** 已到（或超过）截止章但仍未回收的伏笔。 */
  listOverdueForeshadowing(projectId: string): Array<Foreshadowing & { deadlineChapterId: number; progressChapterNo: number }> {
    const chapters = this.listChapters(projectId)
    const finalized = chapters.filter(chapter => chapter.status === 'finalized')
    const progress = finalized.length
      ? Math.max(...finalized.map(chapter => chapter.chapterNo))
      : (chapters.length ? Math.min(...chapters.map(chapter => chapter.chapterNo)) - 1 : 0)
    return this.listForeshadowing(projectId)
      .filter(item => (item.status === 'open' || item.status === 'reinforced')
        && item.deadlineChapterId !== null && item.deadlineChapterId > 0
        && item.deadlineChapterId <= progress)
      .map(item => ({ ...item, deadlineChapterId: item.deadlineChapterId as number, progressChapterNo: progress }))
  }

  updateForeshadowingDeadline(foreshadowingId: string, deadlineChapterId: number | null, expectedVersion?: number): Foreshadowing {
    const current = this.db.select().from(foreshadowing).where(eq(foreshadowing.id, foreshadowingId)).get()
    if (!current) throw new NovelForgeError('NOT_FOUND', `伏笔不存在：${foreshadowingId}`)
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new NovelForgeError('CONFLICT', `伏笔版本已变化：期望 ${expectedVersion}，实际 ${current.version}。`)
    }
    this.db.update(foreshadowing)
      .set({ deadlineChapterId, version: current.version + 1, updatedAt: now() })
      .where(and(eq(foreshadowing.id, foreshadowingId), eq(foreshadowing.version, current.version))).run()
    this.audit(current.projectId, 'foreshadowing.deadline', foreshadowingId, current, { deadlineChapterId })
    return this.db.select().from(foreshadowing).where(eq(foreshadowing.id, foreshadowingId)).get() as Foreshadowing
  }

  // ── 删除关系 / 剧情线 ─────────────────────────────────
  deleteRelation(relationId: string): { ok: true } {
    const current = this.db.select().from(relations).where(eq(relations.id, relationId)).get()
    if (!current) throw new NovelForgeError('NOT_FOUND', `关系不存在：${relationId}`)
    this.db.delete(relations).where(eq(relations.id, relationId)).run()
    this.audit(current.projectId, 'relation.delete', relationId, current, undefined)
    return { ok: true }
  }

  deletePlotThread(threadId: string): { ok: true } {
    const current = this.db.select().from(plotThreads).where(eq(plotThreads.id, threadId)).get()
    if (!current) throw new NovelForgeError('NOT_FOUND', `剧情线不存在：${threadId}`)
    this.db.delete(plotThreads).where(eq(plotThreads.id, threadId)).run()
    this.audit(current.projectId, 'thread.delete', threadId, current, undefined)
    return { ok: true }
  }

}
