import { existsSync } from 'node:fs'
import type { NovelStore } from '../database/store.js'
import type { NovelService } from '../workflow/novel-service.js'
import { NovelForgeError } from '../shared/errors.js'
import { parseJson } from '../shared/json.js'
import type { Route } from './http.js'
import { sendText } from './http.js'

export interface RouteDeps {
  service: NovelService
  store: NovelStore
  version: string
  databasePath: string
  studioDir: string
  hasApiKey: () => boolean
}

function requireString(source: Record<string, unknown>, key: string, label = key): string {
  const value = source[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new NovelForgeError('INVALID_INPUT', `参数 ${label} 必须是非空字符串。`)
  }
  return value.trim()
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new NovelForgeError('INVALID_INPUT', `参数 ${key} 必须是字符串。`)
  return value
}

function optionalNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new NovelForgeError('INVALID_INPUT', `参数 ${key} 必须是数字。`)
  return value
}

function requiredNumber(source: Record<string, unknown>, key: string): number {
  const value = optionalNumber(source, key)
  if (value === undefined) throw new NovelForgeError('INVALID_INPUT', `参数 ${key} 必填。`)
  return value
}

function stringArray(source: Record<string, unknown>, key: string): string[] | undefined {
  const value = source[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new NovelForgeError('INVALID_INPUT', `参数 ${key} 必须是字符串数组。`)
  }
  return value as string[]
}

function attributes(source: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = source[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new NovelForgeError('INVALID_INPUT', `参数 ${key} 必须是对象。`)
  return value as Record<string, unknown>
}

function queryNumber(query: URLSearchParams, key: string): number | undefined {
  const raw = query.get(key)
  if (!raw) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new NovelForgeError('INVALID_INPUT', `查询参数 ${key} 必须是数字。`)
  return value
}

export function buildRoutes(deps: RouteDeps): Route[] {
  const { service, store } = deps
  const ai = (): void => {
    if (!deps.hasApiKey()) {
      throw new NovelForgeError('CONFIG_ERROR', '未配置 DEEPSEEK_API_KEY，AI 生成类接口不可用；资料管理、编辑、审查查看与导出不需要模型。')
    }
  }
  const routes: Route[] = []
  const add = (method: Route['method'], pattern: string, handler: Route['handler']): void => {
    routes.push({ method, pattern, handler })
  }

  add('GET', '/api/health', () => ({
    version: deps.version,
    hasApiKey: deps.hasApiKey(),
    databasePath: deps.databasePath,
    studioBuilt: existsSync(`${deps.studioDir}/index.html`),
  }))

  // ── 项目 ───────────────────────────────────────────────
  add('GET', '/api/projects', () => store.listProjects())

  add('POST', '/api/projects', async context => {
    const body = await context.body()
    return store.createProject({
      title: requireString(body, 'title', '书名'),
      genre: requireString(body, 'genre', '题材'),
      premise: optionalString(body, 'premise'),
      styleGuide: optionalString(body, 'styleGuide'),
    })
  })

  add('GET', '/api/projects/:projectId', context => store.getProjectOverview(context.params.projectId as string))

  add('PATCH', '/api/projects/:projectId', async context => {
    const body = await context.body()
    return store.updateProject(context.params.projectId as string, {
      title: optionalString(body, 'title'),
      genre: optionalString(body, 'genre'),
      premise: optionalString(body, 'premise'),
      styleGuide: optionalString(body, 'styleGuide'),
      status: optionalString(body, 'status'),
    }, optionalNumber(body, 'expectedVersion'))
  })

  add('POST', '/api/projects/generate', async context => {
    ai()
    const body = await context.body()
    return service.generateSetting(requireString(body, 'idea', '创作意图'))
  })

  add('GET', '/api/projects/:projectId/audit', context => store.listAuditEntries(
    context.params.projectId as string,
    queryNumber(context.query, 'limit') ?? 60,
  ))

  add('GET', '/api/projects/:projectId/search', context => store.search(
    context.params.projectId as string,
    context.query.get('q') ?? '',
    (context.query.get('types') ?? '').split(',').map(item => item.trim()).filter(Boolean),
    queryNumber(context.query, 'limit') ?? 20,
  ))

  add('GET', '/api/projects/:projectId/export.md', context => {
    const markdown = service.exportMarkdown(context.params.projectId as string)
    sendText(context.response, markdown, 'text/markdown; charset=utf-8')
    return undefined
  })

  // ── 资料：人物 / 世界观 / 其他实体 ─────────────────────────
  add('GET', '/api/projects/:projectId/entities', context => store.listEntities(
    context.params.projectId as string,
    context.query.get('kind') ?? undefined,
    context.query.get('status') ?? undefined,
  ))

  add('POST', '/api/projects/:projectId/entities', async context => {
    const body = await context.body()
    return store.createEntity({
      projectId: context.params.projectId as string,
      kind: requireString(body, 'kind', '实体类型'),
      name: requireString(body, 'name', '名称'),
      summary: optionalString(body, 'summary'),
      attributes: attributes(body, 'attributes'),
      status: optionalString(body, 'status'),
    })
  })

  add('GET', '/api/entities/:entityId', context => store.getEntity(context.params.entityId as string))

  add('PATCH', '/api/entities/:entityId', async context => {
    const body = await context.body()
    return store.updateEntity(context.params.entityId as string, {
      name: optionalString(body, 'name'),
      kind: optionalString(body, 'kind'),
      summary: optionalString(body, 'summary'),
      attributes: attributes(body, 'attributes'),
      status: optionalString(body, 'status'),
    }, optionalNumber(body, 'expectedVersion'))
  })

  // ── 大纲 ───────────────────────────────────────────────
  add('GET', '/api/projects/:projectId/outlines', context => store.listOutlines(context.params.projectId as string))

  add('PATCH', '/api/outlines/:outlineId', async context => {
    const body = await context.body()
    return store.updateOutline(context.params.outlineId as string, {
      title: optionalString(body, 'title'),
      content: optionalString(body, 'content'),
      status: optionalString(body, 'status'),
    }, optionalNumber(body, 'expectedVersion'))
  })

  add('POST', '/api/projects/:projectId/outlines/plan', async context => {
    ai()
    const body = await context.body()
    return service.planOutline(context.params.projectId as string, requiredNumber(body, 'chapterCount'))
  })

  // ── 章节 ───────────────────────────────────────────────
  add('GET', '/api/projects/:projectId/chapters', context => store.listChapters(context.params.projectId as string))

  add('GET', '/api/projects/:projectId/chapter-summaries', context => store.listChapterSummaries(context.params.projectId as string))

  add('POST', '/api/projects/:projectId/chapters', async context => {
    const body = await context.body()
    return store.createChapter(context.params.projectId as string, {
      title: requireString(body, 'title', '章节标题'),
      chapterNo: optionalNumber(body, 'chapterNo'),
    })
  })

  add('GET', '/api/chapters/:chapterId', context => store.getChapterDetail(context.params.chapterId as string))

  add('PATCH', '/api/chapters/:chapterId', async context => {
    const body = await context.body()
    return store.updateChapter(context.params.chapterId as string, {
      title: optionalString(body, 'title'),
      status: optionalString(body, 'status'),
    }, optionalNumber(body, 'expectedVersion'))
  })

  add('GET', '/api/chapters/:chapterId/context', context => service.getContext(context.params.chapterId as string))

  add('GET', '/api/chapters/:chapterId/revisions', context => {
    const full = context.query.get('full') === '1'
    const revisions = store.listRevisions(context.params.chapterId as string)
    return full ? revisions : revisions.map(({ content, ...row }) => ({ ...row, contentLength: content.length }))
  })

  add('POST', '/api/chapters/:chapterId/revisions', async context => {
    const body = await context.body()
    return store.createRevision(context.params.chapterId as string, requireString(body, 'content', '正文'), 'manual')
  })

  add('POST', '/api/chapters/:chapterId/plan', async context => {
    ai()
    const result = await service.planChapter(context.params.chapterId as string)
    return { plan: result.plan, context: metadata(result.context) }
  })

  add('POST', '/api/chapters/:chapterId/draft', async context => {
    ai()
    const result = await service.writeDraft(context.params.chapterId as string)
    return { revision: result.revision, plan: result.plan, context: metadata(result.context) }
  })

  // ── 正文版本 ───────────────────────────────────────────
  add('GET', '/api/revisions/:revisionId', context => store.getRevision(context.params.revisionId as string))

  add('GET', '/api/compare', context => service.compareRevisions(
    context.query.get('left') ?? '',
    context.query.get('right') ?? '',
  ))

  add('POST', '/api/revisions/:revisionId/review', async context => {
    ai()
    return service.reviewChapter(context.params.revisionId as string)
  })

  add('POST', '/api/revisions/:revisionId/revise', async context => {
    ai()
    const body = await context.body()
    const issueIds = stringArray(body, 'issueIds')
    if (!issueIds?.length) throw new NovelForgeError('INVALID_INPUT', 'issueIds 不能为空。')
    return service.reviseChapter(context.params.revisionId as string, issueIds, optionalString(body, 'instruction') ?? '')
  })

  add('POST', '/api/revisions/:revisionId/continue', async context => {
    ai()
    const body = await context.body()
    return service.continueChapter(context.params.revisionId as string, optionalString(body, 'instruction') ?? '')
  })

  add('POST', '/api/revisions/:revisionId/rewrite', async context => {
    ai()
    const body = await context.body()
    return service.rewriteChapter(context.params.revisionId as string, requireString(body, 'instruction', '改写要求'))
  })

  add('POST', '/api/revisions/:revisionId/rollback', context => service.rollbackRevision(context.params.revisionId as string))

  add('POST', '/api/revisions/:revisionId/finalize', async context => {
    const body = await context.body()
    const revisionId = context.params.revisionId as string
    const revision = store.getRevision(revisionId)
    const reviewed = Boolean(store.getLatestReview(revisionId))
    // 人工工作台：作者本人逐字确认过的版本允许跳过模型审查，但审计日志会标记 finalize_manual。
    const allowUnreviewed = body.allowUnreviewed !== false && !reviewed
    return service.finalizeChapter(revisionId, true, stringArray(body, 'approvedChangeIds') ?? [], allowUnreviewed)
  })

  // ── 事件与伏笔 ─────────────────────────────────────────
  add('GET', '/api/projects/:projectId/events', context => store.listEvents(context.params.projectId as string))

  add('PATCH', '/api/events/:eventId', async context => {
    const body = await context.body()
    return store.updateEvent(context.params.eventId as string, {
      summary: optionalString(body, 'summary'),
      eventTime: optionalString(body, 'eventTime'),
      status: optionalString(body, 'status'),
      chapterId: body.chapterId === undefined ? undefined : (body.chapterId === null ? null : String(body.chapterId)),
    }, optionalNumber(body, 'expectedVersion'))
  })

  add('POST', '/api/projects/:projectId/events', async context => {
    const body = await context.body()
    return store.createEvent({
      projectId: context.params.projectId as string,
      summary: requireString(body, 'summary', '事件摘要'),
      eventTime: optionalString(body, 'eventTime'),
      status: optionalString(body, 'status'),
      chapterId: optionalString(body, 'chapterId'),
    })
  })

  add('GET', '/api/projects/:projectId/foreshadowing', context => store.listForeshadowing(context.params.projectId as string))

  add('POST', '/api/projects/:projectId/foreshadowing', async context => {
    const body = await context.body()
    return store.createForeshadowing({
      projectId: context.params.projectId as string,
      name: requireString(body, 'name', '伏笔名称'),
      description: optionalString(body, 'description'),
      status: optionalString(body, 'status'),
      plantChapterId: optionalString(body, 'plantChapterId'),
      payoffChapterId: optionalString(body, 'payoffChapterId'),
    })
  })

  add('PATCH', '/api/foreshadowing/:foreshadowingId', async context => {
    const body = await context.body()
    return store.updateForeshadowing(context.params.foreshadowingId as string, {
      name: optionalString(body, 'name'),
      description: optionalString(body, 'description'),
      status: optionalString(body, 'status'),
      plantChapterId: body.plantChapterId === undefined ? undefined : (body.plantChapterId === null ? null : String(body.plantChapterId)),
      payoffChapterId: body.payoffChapterId === undefined ? undefined : (body.payoffChapterId === null ? null : String(body.payoffChapterId)),
    }, optionalNumber(body, 'expectedVersion'))
  })

  // ── 审查 ───────────────────────────────────────────────
  add('GET', '/api/projects/:projectId/reviews', context => store.listReviewRuns(context.params.projectId as string))

  add('GET', '/api/reviews/:reviewRunId', context => {
    const run = store.getReviewRun(context.params.reviewRunId as string)
    const chapter = store.getChapter(run.chapterId)
    return { run, chapter, issues: store.listReviewIssues(run.id) }
  })

  add('PATCH', '/api/issues/:issueId', async context => {
    const body = await context.body()
    const status = requireString(body, 'status', '状态')
    if (!['open', 'resolved', 'wontfix'].includes(status)) throw new NovelForgeError('INVALID_INPUT', 'status 只能是 open / resolved / wontfix。')
    return store.updateIssueStatus(context.params.issueId as string, status)
  })

  // ── 变更提议 ───────────────────────────────────────────
  add('GET', '/api/projects/:projectId/proposals', context => store.listProposals(
    context.params.projectId as string,
    context.query.get('status') ?? undefined,
  ))

  add('POST', '/api/projects/:projectId/proposals', async context => {
    const body = await context.body()
    const targetType = requireString(body, 'targetType', '目标类型')
    if (targetType !== 'entity' && targetType !== 'event' && targetType !== 'foreshadowing') {
      throw new NovelForgeError('INVALID_INPUT', 'targetType 只能是 entity / event / foreshadowing。')
    }
    const operation = requireString(body, 'operation', '操作')
    if (operation !== 'create' && operation !== 'update') {
      throw new NovelForgeError('INVALID_INPUT', 'operation 只能是 create / update。')
    }
    return store.proposeChange({
      projectId: context.params.projectId as string,
      targetType,
      operation,
      payload: attributes(body, 'payload') ?? {},
      targetId: optionalString(body, 'targetId'),
      chapterId: optionalString(body, 'chapterId'),
      sourceRevisionId: optionalString(body, 'sourceRevisionId'),
      expectedVersion: optionalNumber(body, 'expectedVersion'),
    })
  })

  add('POST', '/api/proposals/:proposalId/apply', context => store.applyChange(context.params.proposalId as string, true))

  add('POST', '/api/proposals/:proposalId/reject', context => store.rejectProposal(context.params.proposalId as string))

  // ── 工作流 ─────────────────────────────────────────────
  add('GET', '/api/projects/:projectId/workflows', context => store.listWorkflowRuns(context.params.projectId as string))

  return routes
}

function metadata(context: { estimatedTokens: number; budgetTokens: number; truncated: boolean; omittedSections: string[]; sources: unknown[]; text: string }) {
  return {
    estimatedTokens: context.estimatedTokens,
    budgetTokens: context.budgetTokens,
    truncated: context.truncated,
    omittedSections: context.omittedSections,
    sources: context.sources,
    text: context.text,
    preview: context.text.slice(0, 1200),
  }
}

export function proposalPayload(proposalPayloadJson: string): unknown {
  return parseJson(proposalPayloadJson, {})
}
