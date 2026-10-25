import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferArgs, ParameterSchemaSpec, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { NovelForgeError } from '../shared/errors.js'
import { DEFAULT_CONFIG, validateRuntimeConfig } from '../shared/config.js'
import type { RuntimeConfig } from '../shared/config.js'
import { toJson } from '../shared/json.js'
import { createNovelService } from '../workflow/novel-service.js'
import { createHostLlmClient } from '../llm/dsh-llm.js'
import type { NovelService } from '../workflow/novel-service.js'
import { z } from 'zod'

const proposeChangeInputSchema = z.object({
  projectId: z.string().min(1),
  targetType: z.enum(['entity', 'event', 'foreshadowing']),
  operation: z.enum(['create', 'update']),
  payload: z.record(z.string(), z.unknown()),
  targetId: z.string().optional(),
  chapterId: z.string().optional(),
  sourceRevisionId: z.string().optional(),
  expectedVersion: z.number().int().optional(),
})

export const name = 'novelforge'
export const inject = ['tools', 'approval']

export interface Config extends RuntimeConfig {}

export const Config: Schema<Config> = Schema.object({
  databasePath: Schema.string().default(DEFAULT_CONFIG.databasePath),
  provider: Schema.string().default(''),
  apiKey: Schema.string().default(''),
  apiKeyEnv: Schema.string().default(DEFAULT_CONFIG.apiKeyEnv),
  baseURL: Schema.string().default(DEFAULT_CONFIG.baseURL),
  model: Schema.string().default(''),
  temperature: Schema.number().default(DEFAULT_CONFIG.temperature),
  maxTokens: Schema.number().default(DEFAULT_CONFIG.maxTokens),
  timeoutMs: Schema.number().default(DEFAULT_CONFIG.timeoutMs),
  maxRetries: Schema.number().default(DEFAULT_CONFIG.maxRetries),
  retryBaseDelayMs: Schema.number().default(DEFAULT_CONFIG.retryBaseDelayMs),
  maxInputTokens: Schema.number().default(DEFAULT_CONFIG.maxInputTokens),
  maxContextTokens: Schema.number().default(DEFAULT_CONFIG.maxContextTokens),
  recentChapters: Schema.number().default(DEFAULT_CONFIG.recentChapters),
  maxRevisionRounds: Schema.number().default(DEFAULT_CONFIG.maxRevisionRounds),
})

interface ToolOptions<S extends ParameterSchemaSpec> {
  name: string
  description: string
  parameters: S
  timeoutMs?: number
  execute: (args: InferArgs<S>, exec: ToolRunContext) => Promise<unknown> | unknown
}

function register(ctx: Context, options: ToolOptions<ParameterSchemaSpec>): void {
  ctx.tools.register(defineTool({
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args, exec) {
      return toJson(await options.execute(args as never, exec))
    },
  }))
}

async function approve(ctx: Context, exec: ToolRunContext, toolName: string, reason: string): Promise<void> {
  if (!exec.agent) {
    throw new NovelForgeError('APPROVAL_REQUIRED', `${toolName} 需要 DSH 会话内的一次性用户审批；当前调用没有 agent，已拒绝。`)
  }
  const outcome = await ctx.approval.request({
    agent: exec.agent,
    toolName,
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new NovelForgeError('APPROVAL_REQUIRED', `用户审批未通过（${outcome}），未修改正式数据。`)
  }
}

export function apply(ctx: Context, config: Config = DEFAULT_CONFIG): void {
  const runtimeConfig = validateRuntimeConfig({ ...config })
  // 默认走 DSH 宿主模型服务（ctx.llm），无需插件自带 API Key。
  const service = createNovelService(runtimeConfig, createHostLlmClient(ctx, runtimeConfig))
  ctx.effect(() => () => service.close())
  registerTools(ctx, service, config)
}

export function registerTools(ctx: Context, service: NovelService, config: RuntimeConfig = DEFAULT_CONFIG): void {
  const aiTimeout = Math.max(config.timeoutMs * (config.maxRetries + 1), config.timeoutMs) + 10_000
  const registerTool = <S extends ParameterSchemaSpec>(options: ToolOptions<S>): void =>
    register(ctx, options as unknown as ToolOptions<ParameterSchemaSpec>)

  registerTool({
    name: 'novel_list_projects',
    description: '列出本地持久化的小说项目，返回 project_id。',
    parameters: {},
    execute: () => service.store.listProjects(),
  })
  registerTool({
    name: 'novel_create_project',
    description: '创建空小说项目；不会调用模型。题材与设定需要自动生成时改用 novel_generate_setting。',
    parameters: {
      title: { type: 'string', required: true },
      genre: { type: 'string', required: true },
      premise: { type: 'string' },
      style_guide: { type: 'string' },
    },
    execute: args => service.createProject({ title: args.title, genre: args.genre, premise: args.premise, styleGuide: args.style_guide }),
  })
  registerTool({
    name: 'novel_generate_setting',
    description: '根据创作意图生成题材、故事前提、人物与世界规则，并保存为新项目。',
    parameters: { idea: { type: 'string', required: true, description: '题材、风格、核心冲突等创作意图' } },
    timeoutMs: aiTimeout,
    execute: (args, exec) => service.generateSetting(args.idea, exec.signal),
  })
  registerTool({
    name: 'novel_search',
    description: '搜索人物、世界观、事件、伏笔与正文版本；结果包含来源和正式状态。',
    parameters: {
      project_id: { type: 'string', required: true },
      query: { type: 'string', required: true },
      types: { type: 'array', items: { type: 'string' }, description: 'character/world_rule/event/chapter/foreshadowing 等' },
      limit: { type: 'integer' },
    },
    execute: args => service.store.search(args.project_id, args.query, args.types, args.limit),
  })
  registerTool({
    name: 'novel_get_context',
    description: '为指定章节组装有 token 预算、来源和事实状态标注的动态上下文包。',
    parameters: { chapter_id: { type: 'string', required: true } },
    execute: args => service.getContext(args.chapter_id),
  })
  registerTool({
    name: 'novel_get_entity',
    description: '按 ID 读取人物或世界观实体。',
    parameters: { entity_id: { type: 'string', required: true } },
    execute: args => service.store.getEntity(args.entity_id),
  })
  registerTool({
    name: 'novel_get_timeline',
    description: '读取事件时间线；planned/draft 不等于已发生事实。',
    parameters: { project_id: { type: 'string', required: true } },
    execute: args => service.store.listEvents(args.project_id),
  })
  registerTool({
    name: 'novel_get_foreshadowing',
    description: '读取伏笔埋设、回收和废弃状态。',
    parameters: { project_id: { type: 'string', required: true } },
    execute: args => service.store.listForeshadowing(args.project_id),
  })
  registerTool({
    name: 'novel_propose_change',
    description: '提议新增或修改正式资料。仅创建待审批提议，不得直接覆盖事实。',
    parameters: {
      project_id: { type: 'string', required: true },
      target_type: { type: 'string', required: true, enum: ['entity', 'event', 'foreshadowing'] },
      operation: { type: 'string', required: true, enum: ['create', 'update'] },
      payload: { type: 'object', required: true, additionalProperties: true },
      target_id: { type: 'string' },
      chapter_id: { type: 'string' },
      source_revision_id: { type: 'string' },
      expected_version: { type: 'integer' },
    },
    execute: args => {
      const proposalInput = proposeChangeInputSchema.parse({
        projectId: args.project_id,
        targetType: args.target_type,
        operation: args.operation,
        payload: args.payload,
        targetId: args.target_id,
        chapterId: args.chapter_id,
        sourceRevisionId: args.source_revision_id,
        expectedVersion: args.expected_version,
      })
      return service.store.proposeChange(proposalInput)
    },
  })
  registerTool({
    name: 'novel_apply_change',
    description: '请求用户一次性批准后，应用待审核的资料变更；执行乐观版本检查。',
    parameters: { proposal_id: { type: 'string', required: true } },
    execute: async (args, exec) => {
      const proposal = service.store.getProposal(args.proposal_id)
      await approve(ctx, exec, 'novel_apply_change', `应用小说资料变更提议 ${args.proposal_id}，目标：${proposal.targetType}/${proposal.targetId ?? '新建'}。`)
      return service.store.applyChange(args.proposal_id, true)
    },
  })
  registerTool({
    name: 'novel_plan_outline',
    description: '规划指定数量的后续章节并持久化卷纲、章纲和章节记录。',
    parameters: {
      project_id: { type: 'string', required: true },
      chapter_count: { type: 'integer', required: true },
    },
    timeoutMs: aiTimeout,
    execute: (args, exec) => service.planOutline(args.project_id, args.chapter_count, exec.signal),
  })
  registerTool({
    name: 'novel_list_chapters',
    description: '列出章节 ID、编号、状态和正式版本指针。',
    parameters: { project_id: { type: 'string', required: true } },
    execute: args => service.store.listChapters(args.project_id),
  })
  registerTool({
    name: 'novel_plan_chapter',
    description: '根据正式资料和章节大纲生成结构化章节执行计划。',
    parameters: { chapter_id: { type: 'string', required: true } },
    timeoutMs: aiTimeout,
    execute: async (args, exec) => {
      const result = await service.planChapter(args.chapter_id, exec.signal)
      return { plan: result.plan, context: contextMetadata(result.context) }
    },
  })
  registerTool({
    name: 'novel_write_draft',
    description: '完成动态上下文、章节计划和正文初稿；只创建草稿版本，不更新正式事实。',
    parameters: { chapter_id: { type: 'string', required: true } },
    timeoutMs: aiTimeout * 2,
    execute: async (args, exec) => {
      const result = await service.writeDraft(args.chapter_id, exec.signal)
      return { revision: result.revision, plan: result.plan, context: contextMetadata(result.context) }
    },
  })
  registerTool({
    name: 'novel_continue_chapter',
    description: '从指定正文版本续写，保存为新的追加式版本，不覆盖原版本。',
    parameters: {
      revision_id: { type: 'string', required: true },
      instruction: { type: 'string' },
    },
    timeoutMs: aiTimeout,
    execute: (args, exec) => service.continueChapter(args.revision_id, args.instruction, exec.signal),
  })
  registerTool({
    name: 'novel_rewrite_chapter',
    description: '按要求完整改写指定版本，保存为新版本，不覆盖原版本。',
    parameters: {
      revision_id: { type: 'string', required: true },
      instruction: { type: 'string', required: true },
    },
    timeoutMs: aiTimeout,
    execute: (args, exec) => service.rewriteChapter(args.revision_id, args.instruction, exec.signal),
  })
  registerTool({
    name: 'novel_list_revisions',
    description: '列出一章的版本历史（不返回完整正文，避免上下文膨胀）。',
    parameters: { chapter_id: { type: 'string', required: true } },
    execute: args => service.store.listRevisions(args.chapter_id).map(({ content: _content, ...revision }) => ({
      ...revision, contentLength: _content.length,
    })),
  })
  registerTool({
    name: 'novel_review_chapter',
    description: '执行连续性、因果、人物、剧情、文风和伏笔审查，保存带证据的问题列表。',
    parameters: { revision_id: { type: 'string', required: true } },
    timeoutMs: aiTimeout,
    execute: (args, exec) => service.reviewChapter(args.revision_id, exec.signal),
  })
  registerTool({
    name: 'novel_revise_chapter',
    description: '针对作者已选择的审查问题生成新修订版本并自动复检；不得超过配置的轮次上限。',
    parameters: {
      revision_id: { type: 'string', required: true },
      issue_ids: { type: 'array', required: true, items: { type: 'string' } },
      instruction: { type: 'string' },
    },
    timeoutMs: aiTimeout * 2,
    execute: (args, exec) => service.reviseChapter(args.revision_id, args.issue_ids, args.instruction, exec.signal),
  })
  registerTool({
    name: 'novel_compare_revisions',
    description: '比较同一章节的两个不可覆盖版本，返回逐行差异。',
    parameters: {
      left_revision_id: { type: 'string', required: true },
      right_revision_id: { type: 'string', required: true },
    },
    execute: args => service.compareRevisions(args.left_revision_id, args.right_revision_id),
  })
  registerTool({
    name: 'novel_rollback_chapter',
    description: '以历史版本内容创建一个新的回滚草稿；不删除或重写历史。',
    parameters: { revision_id: { type: 'string', required: true } },
    execute: args => service.rollbackRevision(args.revision_id),
  })
  registerTool({
    name: 'novel_finalize_chapter',
    description: '请求用户一次性批准后定稿最新已审查版本，可在同一事务中应用指定变更提议。',
    parameters: {
      revision_id: { type: 'string', required: true },
      approved_change_ids: { type: 'array', items: { type: 'string' } },
    },
    execute: async (args, exec) => {
      await approve(ctx, exec, 'novel_finalize_chapter', `定稿正文版本 ${args.revision_id}，并应用 ${args.approved_change_ids?.length ?? 0} 个资料变更提议。`)
      return service.finalizeChapter(args.revision_id, true, args.approved_change_ids)
    },
  })
  registerTool({
    name: 'novel_list_workflows',
    description: '查看写作、审查、修订任务的持久化状态、检查点与错误。',
    parameters: { project_id: { type: 'string', required: true } },
    execute: args => service.store.listWorkflowRuns(args.project_id),
  })
  registerTool({
    name: 'novel_export_markdown',
    description: '导出仅包含已定稿章节的 Markdown；草稿不会混入。',
    parameters: { project_id: { type: 'string', required: true } },
    execute: args => ({ project_id: args.project_id, markdown: service.exportMarkdown(args.project_id) }),
  })
}

function contextMetadata(context: { estimatedTokens: number; budgetTokens: number; truncated: boolean; omittedSections: string[]; sources: unknown[] }) {
  return {
    estimatedTokens: context.estimatedTokens,
    budgetTokens: context.budgetTokens,
    truncated: context.truncated,
    omittedSections: context.omittedSections,
    sources: context.sources,
  }
}
