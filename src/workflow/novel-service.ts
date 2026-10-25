import { diffLines } from 'diff'
import type { Change } from 'diff'
import { NovelStore } from '../database/store.js'
import type { Chapter, ChapterRevision, Project, ReviewIssue } from '../database/store.js'
import type { ChapterPlan, NovelBlueprint, OutlinePlan, ReviewResult, ReviewIssueInput } from '../domain/schemas.js'
import { blueprintSchema, chapterPlanSchema, outlinePlanSchema, reviewResultSchema } from '../domain/schemas.js'
import { DeepSeekClient } from '../llm/client.js'
import type { LlmClient } from '../llm/client.js'
import { completeStructured } from '../llm/structured.js'
import { ContextBuilder } from '../retrieval/context.js'
import type { ContextPack } from '../retrieval/context.js'
import type { RuntimeConfig } from '../shared/config.js'
import { NovelForgeError, errorMessage, requireNonEmpty } from '../shared/errors.js'
import {
  blueprintMessages,
  chapterPlanMessages,
  continueMessages,
  draftMessages,
  outlineMessages,
  reviewMessages,
  revisionMessages,
  rewriteMessages,
} from './prompts.js'

export class NovelService {
  readonly context: ContextBuilder

  constructor(
    readonly store: NovelStore,
    readonly llm: LlmClient,
    readonly config: RuntimeConfig,
  ) {
    this.context = new ContextBuilder(store, config)
  }

  close(): void {
    this.store.close()
  }

  createProject(input: { title: string; genre: string; premise?: string | undefined; styleGuide?: string | undefined }): Project {
    return this.store.createProject(input)
  }

  async generateSetting(idea: string, signal?: AbortSignal): Promise<{ project: Project; blueprint: NovelBlueprint }> {
    const normalized = requireNonEmpty(idea, '创作意图')
    const { data } = await completeStructured(this.llm, {
      messages: blueprintMessages(normalized),
      temperature: Math.min(1.2, this.config.temperature + 0.1),
      maxTokens: this.config.maxTokens,
    }, blueprintSchema, signal)
    const { project } = this.store.createGeneratedProject(data)
    return { project, blueprint: data }
  }

  async planOutline(projectId: string, chapterCount = 10, signal?: AbortSignal): Promise<OutlinePlan & { chapterIds: string[] }> {
    if (!Number.isInteger(chapterCount) || chapterCount < 1 || chapterCount > 100) {
      throw new NovelForgeError('INVALID_INPUT', 'chapterCount 必须是 1 到 100 的整数。')
    }
    const project = this.store.getProject(projectId)
    return this.runWorkflow(projectId, 'plan_outline', undefined, async runId => {
      const entitiesText = this.store.listEntities(projectId, undefined, 'confirmed')
        .map(row => `[${row.kind}] ${row.name}: ${row.summary} ${row.attributesJson}`).join('\n').slice(0, 12_000) || '暂无'
      const { data } = await completeStructured(this.llm, {
        messages: outlineMessages(project, entitiesText, chapterCount), maxTokens: this.config.maxTokens,
      }, outlinePlanSchema, signal)
      const actualCount = data.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0)
      if (actualCount !== chapterCount) {
        throw new NovelForgeError('LLM_ERROR', `模型返回 ${actualCount} 章，要求的数量为 ${chapterCount}；未写入数据库，请重试。`)
      }
      this.store.checkpointWorkflow(runId, 'outline_validated', { chapterCount })
      const saved = this.store.appendOutline(projectId, data)
      return { ...data, chapterIds: saved.chapters.map(chapter => chapter.id) }
    }, { chapterCount })
  }

  async planChapter(chapterId: string, signal?: AbortSignal): Promise<{ plan: ChapterPlan; context: ContextPack }> {
    const chapter = this.store.getChapter(chapterId)
    const context = this.context.build(chapterId, Math.min(this.config.maxTokens, 2048))
    const { data } = await completeStructured(this.llm, {
      messages: chapterPlanMessages(context.text), maxTokens: Math.min(this.config.maxTokens, 2048),
    }, chapterPlanSchema, signal)
    this.store.updateChapterStatus(chapter.id, 'context_ready')
    return { plan: data, context }
  }

  async writeDraft(chapterId: string, signal?: AbortSignal): Promise<{ revision: ChapterRevision; plan: ChapterPlan; context: ContextPack }> {
    const chapter = this.store.getChapter(chapterId)
    return this.runWorkflow(chapter.projectId, 'write_draft', chapterId, async runId => {
      this.store.checkpointWorkflow(runId, 'context_ready', { chapterId })
      const { plan, context } = await this.planChapter(chapterId, signal)
      this.store.checkpointWorkflow(runId, 'chapter_planned', { plan })
      const result = await this.llm.complete({
        messages: draftMessages(context.text, plan), maxTokens: this.config.maxTokens,
      }, signal)
      const revision = this.store.createRevision(chapterId, stripModelWrapper(result.content), 'draft')
      this.store.checkpointWorkflow(runId, 'draft_generated', { revisionId: revision.id })
      return { revision, plan, context }
    }, { chapterId })
  }

  async continueChapter(revisionId: string, instruction = '', signal?: AbortSignal): Promise<ChapterRevision> {
    const base = this.store.getRevision(revisionId)
    const chapter = this.store.getChapter(base.chapterId)
    return this.runWorkflow(chapter.projectId, 'continue_chapter', chapter.id, async () => {
      const context = this.context.build(chapter.id)
      const result = await this.llm.complete({
        messages: continueMessages(context.text, base.content, instruction), maxTokens: this.config.maxTokens,
      }, signal)
      const addition = stripModelWrapper(result.content)
      return this.store.createRevision(chapter.id, `${base.content.trimEnd()}\n\n${addition}`, 'continue')
    }, { revisionId })
  }

  async rewriteChapter(revisionId: string, instruction: string, signal?: AbortSignal): Promise<ChapterRevision> {
    const normalized = requireNonEmpty(instruction, '改写要求')
    const base = this.store.getRevision(revisionId)
    const chapter = this.store.getChapter(base.chapterId)
    return this.runWorkflow(chapter.projectId, 'rewrite_chapter', chapter.id, async () => {
      const context = this.context.build(chapter.id)
      const result = await this.llm.complete({
        messages: rewriteMessages(context.text, base.content, normalized), maxTokens: this.config.maxTokens,
      }, signal)
      return this.store.createRevision(chapter.id, stripModelWrapper(result.content), 'rewrite')
    }, { revisionId })
  }

  async reviewChapter(revisionId: string, signal?: AbortSignal): Promise<{ run: unknown; issues: ReviewIssue[]; result: ReviewResult }> {
    const revision = this.store.getRevision(revisionId)
    const chapter = this.store.getChapter(revision.chapterId)
    return this.runWorkflow(chapter.projectId, 'review_chapter', chapter.id, async runId => {
      this.store.updateChapterStatus(chapter.id, 'reviewing')
      const context = this.context.build(chapter.id, Math.min(this.config.maxTokens, 2048))
      const { data } = await completeStructured(this.llm, {
        messages: reviewMessages(context.text, revision.content),
        temperature: Math.min(0.3, this.config.temperature), maxTokens: Math.min(this.config.maxTokens, 4096),
      }, reviewResultSchema, signal)
      const deterministic = this.deterministicChecks(chapter.projectId, revision.content)
      const result: ReviewResult = { summary: data.summary, issues: [...deterministic, ...data.issues] }
      const saved = this.store.createReview(revisionId, result)
      this.store.checkpointWorkflow(runId, 'reviewed', { reviewRunId: saved.run.id, issueCount: saved.issues.length })
      return { ...saved, result }
    }, { revisionId })
  }

  async reviseChapter(revisionId: string, issueIds: string[], extraInstruction = '', signal?: AbortSignal): Promise<{
    revision: ChapterRevision
    review: { run: unknown; issues: ReviewIssue[]; result: ReviewResult }
  }> {
    const base = this.store.getRevision(revisionId)
    const chapter = this.store.getChapter(base.chapterId)
    const latestReview = this.store.getLatestReview(revisionId)
    if (!latestReview) throw new NovelForgeError('WORKFLOW_ERROR', '修订前必须先审查当前版本。')
    const reviewIssues = this.store.listReviewIssues(latestReview.id)
    const selected = reviewIssues.filter(issue => issueIds.includes(issue.id) && issue.resolutionStatus === 'open')
    if (!selected.length || selected.length !== new Set(issueIds).size) {
      throw new NovelForgeError('INVALID_INPUT', 'issueIds 必须全部对应该版本最新审查中的未解决问题。')
    }
    const revisionRounds = this.store.listRevisions(chapter.id).filter(row => row.kind === 'revise').length
    if (revisionRounds >= this.config.maxRevisionRounds) {
      this.store.updateChapterStatus(chapter.id, 'needs_author_decision')
      throw new NovelForgeError('WORKFLOW_ERROR', `已达到最大自动修订轮次 ${this.config.maxRevisionRounds}，请人工处理后再继续。`)
    }
    return this.runWorkflow(chapter.projectId, 'revise_chapter', chapter.id, async runId => {
      const context = this.context.build(chapter.id)
      const result = await this.llm.complete({
        messages: revisionMessages(context.text, base.content, selected, extraInstruction), maxTokens: this.config.maxTokens,
      }, signal)
      const revision = this.store.createRevision(chapter.id, stripModelWrapper(result.content), 'revise')
      this.store.resolveIssues(selected.map(issue => issue.id))
      this.store.checkpointWorkflow(runId, 'revision_created', { revisionId: revision.id })
      const review = await this.reviewChapter(revision.id, signal)
      return { revision, review }
    }, { revisionId, issueIds })
  }

  finalizeChapter(revisionId: string, approved: boolean, approvedChangeIds: string[] = [], allowUnreviewed = false): Chapter {
    const revision = this.store.getRevision(revisionId)
    const latest = this.store.getLatestRevision(revision.chapterId)
    if (latest?.id !== revisionId) {
      throw new NovelForgeError('CONFLICT', `只能定稿最新版本 ${latest?.id ?? '无'}；旧版本可比较或回滚为新草稿。`)
    }
    return this.store.finalizeChapter(revisionId, approved, approvedChangeIds, allowUnreviewed)
  }

  rollbackRevision(revisionId: string): ChapterRevision {
    const source = this.store.getRevision(revisionId)
    return this.store.createRevision(source.chapterId, source.content, 'rollback')
  }

  compareRevisions(leftId: string, rightId: string): { leftId: string; rightId: string; changes: Change[] } {
    const left = this.store.getRevision(leftId)
    const right = this.store.getRevision(rightId)
    if (left.chapterId !== right.chapterId) throw new NovelForgeError('INVALID_INPUT', '只能比较同一章节的版本。')
    return { leftId, rightId, changes: diffLines(left.content, right.content) }
  }

  getContext(chapterId: string): ContextPack {
    return this.context.build(chapterId)
  }

  exportMarkdown(projectId: string): string {
    const project = this.store.getProject(projectId)
    const chapters = this.store.listFinalChapters(projectId)
    const body = chapters.map(({ chapter, revision }) => `## 第${chapter.chapterNo}章 ${chapter.title}\n\n${revision.content}`).join('\n\n')
    return `# ${project.title}\n\n> ${project.premise}\n\n${body}\n`
  }

  private deterministicChecks(projectId: string, content: string): ReviewIssueInput[] {
    const issues: ReviewIssueInput[] = []
    const rules = this.store.listEntities(projectId, 'world_rule', 'confirmed')
    for (const rule of rules) {
      let attributes: Record<string, unknown>
      try {
        attributes = JSON.parse(rule.attributesJson) as Record<string, unknown>
      } catch {
        continue
      }
      const forbidden = attributes.forbiddenTerms ?? attributes.forbidden_terms
      if (!Array.isArray(forbidden)) continue
      for (const term of forbidden) {
        if (typeof term !== 'string' || !term) continue
        const start = content.indexOf(term)
        if (start >= 0) {
          issues.push({
            category: 'continuity', severity: 'critical', start, end: start + term.length,
            issue: `正文包含正式世界规则禁止的内容“${term}”。`,
            evidence: [{ sourceId: rule.id, description: `${rule.name}：${rule.summary}` }],
            suggestedFix: `删除或改写“${term}”，使其符合规则 ${rule.name}。`,
          })
        }
      }
    }
    return issues
  }

  private async runWorkflow<T>(
    projectId: string,
    taskType: string,
    chapterId: string | undefined,
    operation: (runId: string) => Promise<T>,
    checkpoint: unknown,
  ): Promise<T> {
    const run = this.store.startWorkflow(projectId, taskType, chapterId)
    try {
      const result = await operation(run.id)
      this.store.finishWorkflow(run.id, 'completed', { ...asCheckpoint(checkpoint), result: summarizeResult(result) })
      return result
    } catch (error) {
      this.store.finishWorkflow(run.id, 'failed', checkpoint, errorMessage(error))
      throw error
    }
  }
}

function stripModelWrapper(content: string): string {
  const trimmed = content.trim()
  const fenced = trimmed.match(/^```(?:text|markdown|md)?\s*([\s\S]*?)\s*```$/i)
  return (fenced?.[1] ?? trimmed).trim()
}

function asCheckpoint(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : { value }
}

function summarizeResult(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && 'revision' in value) {
    const revision = (value as { revision?: { id?: string } }).revision
    return { revisionId: revision?.id }
  }
  if (Array.isArray(value)) return { count: value.length }
  return undefined
}

export function createNovelService(config: RuntimeConfig, llm?: LlmClient): NovelService {
  const store = new NovelStore(config.databasePath)
  return new NovelService(store, llm ?? new DeepSeekClient(config), config)
}
