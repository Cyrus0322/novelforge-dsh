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
import { runIngest } from './ingest.js'
import type { IngestInput, IngestOutcome } from './ingest.js'
import type { ContextPack } from '../retrieval/context.js'
import type { RuntimeConfig } from '../shared/config.js'
import { NovelForgeError, errorMessage, requireNonEmpty } from '../shared/errors.js'
import { parseJson } from '../shared/json.js'
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
      const deterministic = [
        ...this.deterministicChecks(chapter.projectId, revision.content),
        ...this.knowledgeChecks(chapter.projectId, revision.content),
        ...this.characterStateChecks(chapter.projectId, chapter.chapterNo, revision.content),
      ]
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

  /** 素材 → 资料库：抽取结构化条目并生成待审批提议（mode='apply' 时立即应用）。 */
  async ingestMaterial(projectId: string, input: IngestInput, signal?: AbortSignal): Promise<IngestOutcome> {
    return runIngest({ store: this.store, llm: this.llm, config: this.config }, projectId, input, signal)
  }

  applyIngestBatch(batchId: string, approved: boolean): ReturnType<NovelStore['applyIngestBatch']> {
    return this.store.applyIngestBatch(batchId, approved)
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

  /**
   * 知情矩阵检查：角色在正文里提到自己「不知道」的事 → 信息泄露（人物开天眼）。
   * 做法是确定性的：以人物名出现的位置为锚，取前后窗口，看窗口里是否命中事实的 n-gram 关键词；
   * 至少命中 2 个不同的 3 字片段才报，避免单个常见词造成误报。
   */
  private knowledgeChecks(projectId: string, content: string): ReviewIssueInput[] {
    const issues: ReviewIssueInput[] = []
    const facts = this.store.listKnowledge(projectId)
    if (!facts.length) return issues
    const entities = this.store.listEntities(projectId)
    const nameById = new Map(entities.map(entity => [entity.id, entity.name]))
    const entityNames = new Set(entities.map(entity => entity.name))

    const gramsOf = (proposition: string): string[] => {
      const cleaned = proposition.replace(/[\s，。、；：！？（）()「」“”"'’·…—]/g, '')
      const size = cleaned.length >= 4 ? 3 : 2
      const grams = new Set<string>()
      for (let index = 0; index + size <= cleaned.length; index += 1) {
        const gram = cleaned.slice(index, index + size)
        if (entityNames.has(gram)) continue
        grams.add(gram)
      }
      return [...grams]
    }

    for (const fact of facts) {
      const grams = gramsOf(fact.proposition)
      if (!grams.length) continue
      for (const knower of fact.knowers) {
        if (knower.state !== 'unaware') continue
        const name = nameById.get(knower.entityId)
        if (!name) continue
        let cursor = content.indexOf(name)
        while (cursor >= 0) {
          const windowText = content.slice(Math.max(0, cursor - 160), cursor + name.length + 160)
          const matched = grams.filter(gram => windowText.includes(gram))
          if (matched.length >= 2) {
            const anchor = windowText.indexOf(matched[0] as string)
            const start = anchor >= 0 ? Math.max(0, cursor - 160) + anchor : cursor
            issues.push({
              category: 'character',
              severity: 'major',
              start,
              end: start + Math.max(...matched.map(gram => gram.length)),
              issue: `${name} 在正文中涉及「${fact.proposition}」，但知情矩阵里TA对该事实是「不知道」，属于信息来源不明。`,
              evidence: [{ sourceId: fact.id, description: `知情事实：${fact.proposition}（${name}=不知道）` }],
              suggestedFix: `要么删掉/改写 ${name} 相关段落，要么在正文里补一个TA获知该信息的场景，再把知情矩阵改成「知道」。`,
            })
            break
          }
          cursor = content.indexOf(name, cursor + name.length)
        }
      }
    }
    return issues
  }

  /**
   * 人物状态快照检查：
   * 1) 伤势未愈却行动自如——快照里 injury.healChapter 晚于当前章，正文里该角色做动作。
   * 2) 等级回退——后一条快照的等级数值低于前一条且没有注明降级。
   * 都是确定性规则，报告里给出快照 ID 作为证据。
   */
  private characterStateChecks(projectId: string, chapterNo: number, content: string): ReviewIssueInput[] {
    const issues: ReviewIssueInput[] = []
    const characters = this.store.listEntities(projectId, 'character')
    if (!characters.length) return issues
    const actionVerbs = ['挥', '拔', '奔', '跃', '踹', '跃起', '举起', '握紧', '疾冲', '翻身', '单手', '搏', '斩', '劈', '冲上去', '扛起']
    const statesByCharacter = new Map<string, Array<{ id: string; chapterNo: number; summary: string; state: Record<string, unknown> }>>()

    for (const character of characters) {
      const snapshots = this.store.listCharacterStates(character.id)
        .map(state => {
          const chapterId = state.chapterId
          const chapter = chapterId ? this.store.getChapter(chapterId) : null
          return {
            id: state.id,
            chapterNo: chapter ? chapter.chapterNo : 0,
            summary: state.summary,
            state: parseJson<Record<string, unknown>>(state.stateJson, {}),
          }
        })
        .sort((left, right) => left.chapterNo - right.chapterNo)
      if (snapshots.length) statesByCharacter.set(character.id, snapshots)
    }

    for (const [characterId, snapshots] of statesByCharacter) {
      const character = characters.find(item => item.id === characterId)
      if (!character) continue
      // 取当前章之前最近的一条快照
      const active = [...snapshots].reverse().find(snapshot => snapshot.chapterNo <= chapterNo) ?? snapshots[0]
      if (!active) continue

      // —— 伤势未愈 ——
      const injuries = normalizeInjuries(active.state.injuries ?? active.state.injury)
      const unhealed = injuries.filter(injury => injury.healChapter !== null && injury.healChapter > chapterNo)
      if (unhealed.length && content.includes(character.name)) {
        let cursor = content.indexOf(character.name)
        while (cursor >= 0) {
          const windowText = content.slice(Math.max(0, cursor - 120), cursor + character.name.length + 120)
          const verb = actionVerbs.find(item => windowText.includes(item))
          const injuryHit = unhealed.find(injury => windowText.includes(injury.desc.slice(0, Math.min(4, injury.desc.length))))
          if (verb && (injuryHit || unhealed.length > 0)) {
            const start = Math.max(0, cursor - 120) + Math.max(0, windowText.indexOf(verb))
            issues.push({
              category: 'continuity',
              severity: 'major',
              start,
              end: start + (verb?.length ?? 2),
              issue: `${character.name} 在快照里仍有未愈伤势（${unhealed.map(injury => `${injury.desc}，第 ${injury.healChapter} 章才痊愈`).join('；')}），本章却出现「${verb}」这类动作描写。`,
              evidence: [{ sourceId: active.id, description: `状态快照（第 ${active.chapterNo} 章）：${active.summary || JSON.stringify(active.state)}` }],
              suggestedFix: `要么把动作改得受限于伤势（只用另一只手 / 咬牙硬撑并写代价），要么把痊愈章提前并同步状态快照。`,
            })
            break
          }
          cursor = content.indexOf(character.name, cursor + character.name.length)
        }
      }

      // —— 等级回退 ——
      const levels = snapshots
        .map(snapshot => ({ snapshot, value: parseLevelNumber(snapshot.state.level) }))
        .filter((entry): entry is { snapshot: typeof snapshots[number]; value: number } => entry.value !== null)
      for (let index = 1; index < levels.length; index += 1) {
        const previous = levels[index - 1]
        const current = levels[index]
        if (!previous || !current) continue
        const marked = current.snapshot.state.levelDown === true || current.snapshot.state.levelDown === 'true'
        if (current.value < previous.value && !marked) {
          issues.push({
            category: 'continuity',
            severity: 'minor',
            start: null,
            end: null,
            issue: `${character.name} 的等级从「第 ${previous.snapshot.chapterNo} 章的 ${String(previous.snapshot.state.level)}」降到「第 ${current.snapshot.chapterNo} 章的 ${String(current.snapshot.state.level)}」，但快照里没有注明降级原因。`,
            evidence: [{ sourceId: current.snapshot.id, description: `状态快照（第 ${current.snapshot.chapterNo} 章）：${current.snapshot.summary}` }],
            suggestedFix: '如果是有意降级（废功/反噬），在快照 state 里加 levelDown: true 并写原因；否则修正等级数值。',
          })
        }
      }
    }
    return issues
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

interface InjuryEntry { desc: string; healChapter: number | null }

function normalizeInjuries(value: unknown): InjuryEntry[] {
  if (!Array.isArray(value)) return []
  const result: InjuryEntry[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      const match = item.match(/第\s*(\d+)\s*章/)
      result.push({ desc: item, healChapter: match?.[1] ? Number(match[1]) : null })
      continue
    }
    if (typeof item === 'object' && item !== null) {
      const entry = item as { desc?: unknown; healChapter?: unknown; heal_chapter?: unknown }
      const desc = typeof entry.desc === 'string' ? entry.desc : ''
      if (!desc) continue
      const heal = typeof entry.healChapter === 'number' ? entry.healChapter
        : typeof entry.heal_chapter === 'number' ? entry.heal_chapter : null
      result.push({ desc, healChapter: heal })
    }
  }
  return result
}

function parseLevelNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const arabic = value.match(/(\d+)/)
  if (arabic?.[1]) return Number(arabic[1])
  // 中文数字：引气七层 / 第三章 / 十七
  const cn = value.match(/[一二三四五六七八九十]{1,3}/)
  if (!cn?.[0]) return null
  const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  const text = cn[0]
  if (text === '十') return 10
  if (text.includes('十')) {
    const [head, tail] = text.split('十')
    const tens = head ? (digits[head] ?? 0) : 1
    const ones = tail ? (digits[tail] ?? 0) : 0
    return tens * 10 + ones
  }
  return digits[text] ?? null
}
