import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { openDatabase } from './database.js'
import type { DatabaseHandle, NovelDatabase } from './database.js'
import {
  auditLog,
  changeProposals,
  chapterRevisions,
  chapters,
  entities,
  events,
  foreshadowing,
  outlines,
  projects,
  reviewIssues,
  reviewRuns,
  workflowRuns,
} from './schema.js'
import type { NovelBlueprint, OutlinePlan, ReviewResult } from '../domain/schemas.js'
import { changePayloadSchema } from '../domain/schemas.js'
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

export interface ProjectInput {
  title: string
  genre: string
  premise?: string | undefined
  styleGuide?: string | undefined
}

export interface ProposalInput {
  projectId: string
  chapterId?: string | undefined
  sourceRevisionId?: string | undefined
  targetType: 'entity' | 'event' | 'foreshadowing'
  targetId?: string | undefined
  operation: 'create' | 'update'
  payload: unknown
  expectedVersion?: number | undefined
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
  }): Entity {
    this.getProject(input.projectId)
    const timestamp = now()
    const row: Entity = {
      id: id('entity'), projectId: input.projectId, kind: input.kind,
      name: requireNonEmpty(input.name, 'name'), summary: input.summary?.trim() ?? '',
      attributesJson: JSON.stringify(input.attributes ?? {}), status: input.status ?? 'confirmed',
      sourceChapterId: input.sourceChapterId ?? null, sourceRevisionId: input.sourceRevisionId ?? null,
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
            title: chapter.title, status: 'planned', currentRevisionId: null, version: 1,
            createdAt: timestamp, updatedAt: timestamp,
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

  createRevision(chapterId: string, content: string, kind: 'draft' | 'continue' | 'rewrite' | 'revise' | 'rollback'): ChapterRevision {
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
        status: kind === 'revise' || kind === 'rewrite' ? 'revising' : 'draft_generated',
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
    const payload = changePayloadSchema.parse(input.payload)
    if (input.operation === 'update' && !input.targetId) {
      throw new NovelForgeError('INVALID_INPUT', '更新提议必须提供 targetId。')
    }
    const row: ChangeProposal = {
      id: id('proposal'), projectId: input.projectId, chapterId: input.chapterId ?? null,
      sourceRevisionId: input.sourceRevisionId ?? null, targetType: input.targetType,
      targetId: input.targetId ?? null, operation: input.operation, payloadJson: JSON.stringify(payload),
      expectedVersion: input.expectedVersion ?? null, status: 'pending', createdAt: now(), appliedAt: null,
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
        version: 1, createdAt: timestamp, updatedAt: timestamp,
      }
      if (!row.summary) throw new NovelForgeError('INVALID_INPUT', '事件提议必须包含 summary。')
      this.db.insert(events).values(row).run()
      this.index(row.id, row.projectId, 'event', row.chapterId ?? row.id, row.status, row.summary)
      this.audit(row.projectId, 'event.apply_proposal', row.id, undefined, row)
    } else {
      const timestamp = now()
      const row: Foreshadowing = {
        id: proposal.targetId ?? id('foreshadowing'), projectId: proposal.projectId,
        name: payload.name ?? '未命名伏笔', description: payload.description ?? payload.summary ?? '',
        plantChapterId: payload.plantChapterId ?? proposal.chapterId,
        payoffChapterId: payload.payoffChapterId ?? null, status: payload.status === 'cancelled' ? 'abandoned' : 'open',
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

  finalizeChapter(revisionId: string, approved: boolean, approvedChangeIds: string[]): Chapter {
    if (!approved) throw new NovelForgeError('APPROVAL_REQUIRED', '未获得用户批准：定稿必须显式传入 approved: true，章节仍为草稿状态。')
    const revision = this.getRevision(revisionId)
    const chapter = this.getChapter(revision.chapterId)
    const review = this.getLatestReview(revisionId)
    if (!review) throw new NovelForgeError('WORKFLOW_ERROR', '该版本尚未审查，不能定稿。')
    const blockers = this.listReviewIssues(review.id).filter(issue => issue.resolutionStatus === 'open' && issue.severity !== 'minor')
    if (blockers.length) {
      throw new NovelForgeError('WORKFLOW_ERROR', `仍有 ${blockers.length} 个未解决的 major/critical 审查问题，不能定稿。`, { issueIds: blockers.map(issue => issue.id) })
    }
    return this.db.transaction(() => {
      const timestamp = now()
      this.db.update(chapterRevisions).set({ status: 'finalized', summary: revision.summary || review.summary })
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
      this.audit(chapter.projectId, 'chapter.finalize', chapter.id, chapter, { ...chapter, currentRevisionId: revisionId, status: 'finalized' })
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
    return rows.slice(0, safeLimit)
  }
}
