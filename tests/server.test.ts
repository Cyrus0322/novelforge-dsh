import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startStudioServer } from '../src/server/index.js'
import type { StudioServerHandle } from '../src/server/index.js'
import { DEFAULT_CONFIG } from '../src/shared/config.js'
import type { RuntimeConfig } from '../src/shared/config.js'
import type {
  ChangeProposal, Chapter, ChapterRevision, ChapterSummary, Entity, Foreshadowing, Project,
  ReviewIssue, ReviewRun, StoryEvent,
} from '../src/database/store.js'

/**
 * 真实启动本地工作台服务（127.0.0.1 + 临时 SQLite），用 fetch 走完整 HTTP 链路。
 * 不 mock 路由、store 或领域逻辑；AI 接口只用「未配置 API Key → 400 CONFIG_ERROR」
 * 的短路路径断言，并把 baseURL 指向不可达的本机端口，确保任何误发的模型请求都会立刻失败而不是访问外网。
 */

interface SuccessBody<T> { ok: true; data: T }
interface FailureBody { ok: false; error: { code: string; message: string; details?: unknown } }
type Envelope<T> = SuccessBody<T> | FailureBody

interface ApiResult<T> {
  status: number
  headers: Headers
  body: Envelope<T>
  text: string
}

interface TestServer {
  handle: StudioServerHandle
  config: RuntimeConfig
  directory: string
  studioDir: string
  close: () => Promise<void>
}

interface StartOptions {
  token?: string
  hasApiKey?: () => boolean
  port?: number
  seedStudio?: (studioDir: string) => void
  databaseName?: string
}

const activeServers: TestServer[] = []

async function startServer(options: StartOptions = {}): Promise<TestServer> {
  const directory = mkdtempSync(join(tmpdir(), 'novelforge-server-'))
  const studioDir = join(directory, 'studio')
  mkdirSync(studioDir, { recursive: true })
  options.seedStudio?.(studioDir)
  const config: RuntimeConfig = {
    ...DEFAULT_CONFIG,
    databasePath: join(directory, options.databaseName ?? 'novel.db'),
    apiKey: '',
    // 任何意外发生的模型调用都指向不可达的本机端口，并立即失败（禁止真实网络）。
    baseURL: 'http://127.0.0.1:1',
    timeoutMs: 1000,
    maxRetries: 0,
  }
  const handle = await startStudioServer({
    config,
    port: options.port ?? 0,
    host: '127.0.0.1',
    studioDir,
    hasApiKey: options.hasApiKey ?? (() => false),
    ...(options.token === undefined ? {} : { token: options.token }),
  })
  let closed = false
  const server: TestServer = {
    handle,
    config,
    directory,
    studioDir,
    close: async () => {
      if (closed) return
      closed = true
      await handle.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
  activeServers.push(server)
  return server
}

afterEach(async () => {
  while (activeServers.length) {
    await activeServers.pop()!.close()
  }
})

function jsonInit(method: string, payload?: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }
}

async function api<T>(server: TestServer, path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const response = await fetch(`${server.handle.url}${path}`, init)
  const text = await response.text()
  let body: Envelope<T>
  try {
    body = JSON.parse(text) as Envelope<T>
  } catch {
    throw new Error(`期望 JSON 信封，实际收到 HTTP ${response.status}：${text.slice(0, 200)}`)
  }
  return { status: response.status, headers: response.headers, body, text }
}

function ok<T>(result: ApiResult<T>): T {
  if (!result.body.ok) {
    throw new Error(`期望成功，实际 HTTP ${result.status} ${result.body.error.code}：${result.body.error.message}`)
  }
  return result.body.data
}

function failure(result: ApiResult<unknown>, status: number, code: string): FailureBody['error'] {
  expect(result.status).toBe(status)
  if (result.body.ok) throw new Error(`期望失败，实际成功：${result.text.slice(0, 200)}`)
  expect(result.body.error.code).toBe(code)
  return result.body.error
}

/** 绕过 URL 规范化，直接发送原始 path（用于畸形编码/路径穿越用例）。 */
function rawGet(server: TestServer, path: string): Promise<{ status: number; contentType: string | undefined; text: string }> {
  const url = new URL(server.handle.url)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: url.hostname,
      port: url.port,
      path,
      method: 'GET',
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)))
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        contentType: response.headers['content-type'],
        text: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.on('error', reject)
    request.end()
  })
}

async function createProject(server: TestServer, title = '服务端测试书'): Promise<Project> {
  return ok(await api<Project>(server, '/api/projects', jsonInit('POST', {
    title, genre: '奇幻', premise: '雨夜进城', styleGuide: '冷静',
  })))
}

async function createChapter(server: TestServer, projectId: string, title = '第一章'): Promise<Chapter> {
  const created = ok(await api<{ chapter: Chapter; outline: unknown }>(
    server, `/api/projects/${projectId}/chapters`, jsonInit('POST', { title }),
  ))
  return created.chapter
}

async function createManualRevision(server: TestServer, chapterId: string, content: string): Promise<ChapterRevision> {
  return ok(await api<ChapterRevision>(
    server, `/api/chapters/${chapterId}/revisions`, jsonInit('POST', { content }),
  ))
}

describe('本地工作台 HTTP 服务', () => {
  it('GET /api/health 返回版本、hasApiKey、数据库位置与 JSON 信封', async () => {
    const server = await startServer()
    const result = await api<{ version: string; hasApiKey: boolean; databasePath: string; studioBuilt: boolean }>(server, '/api/health')
    const data = ok(result)
    expect(result.status).toBe(200)
    expect(result.headers.get('content-type')).toContain('application/json')
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(data.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(data.hasApiKey).toBe(false)
    expect(data.databasePath).toBe(server.config.databasePath)
    expect(data.studioBuilt).toBe(false)
  })

  it('设置 token 后：无令牌 401，请求头与 ?token= 均可访问，静态页不受令牌限制', async () => {
    const server = await startServer({ token: 's3cret' })

    const missing = await api<unknown>(server, '/api/projects')
    failure(missing, 401, 'UNAUTHORIZED')

    const wrong = await api<unknown>(server, '/api/projects', { headers: { 'x-novelforge-token': 'wrong' } })
    failure(wrong, 401, 'UNAUTHORIZED')

    const viaHeader = ok(await api<Project[]>(server, '/api/projects', { headers: { 'x-novelforge-token': 's3cret' } }))
    expect(viaHeader).toEqual([])

    const viaQuery = ok(await api<Project[]>(server, '/api/projects?token=s3cret'))
    expect(viaQuery).toEqual([])

    const page = await fetch(`${server.handle.url}/`)
    expect(page.status).toBe(503)
    expect(await page.text()).toContain('pnpm run studio:build')
  })

  it('项目：创建、列表、overview 与参数校验', async () => {
    const server = await startServer()

    failure(await api<unknown>(server, '/api/projects', jsonInit('POST', { title: '缺题材' })), 400, 'INVALID_INPUT')
    failure(await api<unknown>(server, '/api/projects', jsonInit('POST', { title: '   ', genre: '奇幻' })), 400, 'INVALID_INPUT')

    const project = await createProject(server)
    expect(project.id).toMatch(/^project_/)
    expect(project.version).toBe(1)
    expect(project.title).toBe('服务端测试书')

    const list = ok(await api<Project[]>(server, '/api/projects'))
    expect(list.map(row => row.id)).toContain(project.id)

    const overview = ok(await api<{
      project: Project
      counts: Record<string, number>
      currentChapter: Chapter | null
      lastFinalized: unknown
      recentRevisions: ChapterRevision[]
      openIssues: ReviewIssue[]
      pendingProposals: ChangeProposal[]
    }>(server, `/api/projects/${project.id}`))
    expect(overview.project.id).toBe(project.id)
    expect(overview.counts).toEqual({
      chapters: 0, finalizedChapters: 0, entities: 0, events: 0,
      foreshadowingOpen: 0, pendingProposals: 0, openIssues: 0, revisions: 0,
      relations: 0, threads: 0, scenes: 0, ingestBatches: 0,
    })
    expect(overview.currentChapter).toBeNull()
    expect(overview.lastFinalized).toBeNull()
    expect(overview.recentRevisions).toEqual([])

    failure(await api<unknown>(server, '/api/projects/project_missing'), 404, 'NOT_FOUND')
  })

  it('实体：创建、按 kind 过滤、正确版本更新，错误 expectedVersion 返回 409 CONFLICT', async () => {
    const server = await startServer()
    const project = await createProject(server)

    failure(await api<unknown>(server, `/api/projects/${project.id}/entities`, jsonInit('POST', { kind: 'character' })), 400, 'INVALID_INPUT')

    const entity = ok(await api<Entity>(server, `/api/projects/${project.id}/entities`, jsonInit('POST', {
      kind: 'character', name: '林澈', summary: '调查员', attributes: { age: 19 },
    })))
    expect(entity.version).toBe(1)
    expect(JSON.parse(entity.attributesJson)).toEqual({ age: 19 })

    await api<Entity>(server, `/api/projects/${project.id}/entities`, jsonInit('POST', {
      kind: 'location', name: '旧城', summary: '雨夜中的城市',
    }))

    const characters = ok(await api<Entity[]>(server, `/api/projects/${project.id}/entities?kind=character`))
    expect(characters.map(row => row.id)).toEqual([entity.id])
    const locations = ok(await api<Entity[]>(server, `/api/projects/${project.id}/entities?kind=location`))
    expect(locations).toHaveLength(1)
    expect(ok(await api<Entity[]>(server, `/api/projects/${project.id}/entities?kind=item`))).toEqual([])

    const updated = ok(await api<Entity>(server, `/api/entities/${entity.id}`, jsonInit('PATCH', {
      summary: '档案员', expectedVersion: 1,
    })))
    expect(updated.version).toBe(2)
    expect(updated.summary).toBe('档案员')

    const conflict = failure(await api<unknown>(server, `/api/entities/${entity.id}`, jsonInit('PATCH', {
      summary: '过期覆盖', expectedVersion: 1,
    })), 409, 'CONFLICT')
    expect(conflict.message).toContain('版本已变化')
    const unchanged = ok(await api<Entity>(server, `/api/entities/${entity.id}`))
    expect(unchanged.summary).toBe('档案员')
    expect(unchanged.version).toBe(2)
  })

  it('章节与人工正文：追加版本、列表默认不含正文、详情含章纲与最新版本', async () => {
    const server = await startServer()
    const project = await createProject(server)
    const chapter = await createChapter(server, project.id, '雨夜')
    expect(chapter.chapterNo).toBe(1)
    expect(chapter.status).toBe('planned')

    const summaries = ok(await api<ChapterSummary[]>(server, `/api/projects/${project.id}/chapter-summaries`))
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.chapter.id).toBe(chapter.id)
    expect(summaries[0]!.revisionCount).toBe(0)
    expect(summaries[0]!.latest).toBeNull()

    failure(await api<unknown>(server, `/api/chapters/${chapter.id}/revisions`, jsonInit('POST', { content: '   ' })), 400, 'INVALID_INPUT')

    const first = await createManualRevision(server, chapter.id, '人工第一版正文')
    const second = await createManualRevision(server, chapter.id, '人工第二版正文，更长一些')
    expect(first.kind).toBe('manual')
    expect([first.revisionNo, second.revisionNo]).toEqual([1, 2])

    const detail = ok(await api<{
      chapter: Chapter
      outline: { id: string; title: string } | null
      revisions: ChapterRevision[]
      latestRevision: ChapterRevision | null
      latestReview: unknown
    }>(server, `/api/chapters/${chapter.id}`))
    expect(detail.chapter.status).toBe('manual_draft')
    expect(detail.outline?.title).toBe('雨夜')
    expect(detail.revisions.map(row => row.id)).toEqual([second.id, first.id])
    expect(detail.latestRevision?.id).toBe(second.id)
    expect(detail.latestReview).toBeNull()

    const renamed = ok(await api<Chapter>(server, `/api/chapters/${chapter.id}`, jsonInit('PATCH', {
      title: '雨夜（修订）', expectedVersion: detail.chapter.version,
    })))
    expect(renamed.title).toBe('雨夜（修订）')
    expect(renamed.version).toBe(detail.chapter.version + 1)
    const renamedDetail = ok(await api<{ outline: { title: string } | null }>(server, `/api/chapters/${chapter.id}`))
    expect(renamedDetail.outline?.title).toBe('雨夜（修订）')

    const lightList = ok(await api<Array<ChapterRevision & { contentLength: number }>>(
      server, `/api/chapters/${chapter.id}/revisions?full=0`,
    ))
    expect(lightList).toHaveLength(2)
    for (const row of lightList) {
      expect('content' in row).toBe(false)
      expect(row.contentLength).toBeGreaterThan(0)
    }
    const fullList = ok(await api<ChapterRevision[]>(server, `/api/chapters/${chapter.id}/revisions?full=1`))
    expect(fullList.map(row => row.content)).toEqual(['人工第二版正文，更长一些', '人工第一版正文'])

    const full = ok(await api<ChapterRevision>(server, `/api/revisions/${first.id}`))
    expect(full.content).toBe('人工第一版正文')

    const compared = ok(await api<{ leftId: string; rightId: string; changes: unknown[] }>(
      server, `/api/compare?left=${first.id}&right=${second.id}`,
    ))
    expect(compared.leftId).toBe(first.id)
    expect(compared.rightId).toBe(second.id)
    expect(compared.changes.length).toBeGreaterThan(0)

    failure(await api<unknown>(server, `/api/compare?left=${first.id}`), 404, 'NOT_FOUND')

    const context = ok(await api<{
      projectId: string
      chapterId: string
      text: string
      estimatedTokens: number
      budgetTokens: number
      sources: unknown[]
    }>(server, `/api/chapters/${chapter.id}/context`))
    expect(context.projectId).toBe(project.id)
    expect(context.chapterId).toBe(chapter.id)
    expect(context.text).toContain('雨夜（修订）')
    expect(context.budgetTokens).toBeGreaterThan(0)
  })

  it('定稿：未审查人工版本默认跳过模型审查并写 chapter.finalize_manual 审计，旧版本返回 409', async () => {
    const server = await startServer()
    const project = await createProject(server)
    const chapter = await createChapter(server, project.id)
    const oldRevision = await createManualRevision(server, chapter.id, '旧正文')
    const latest = await createManualRevision(server, chapter.id, '最新正文')

    // 非最新版本不能定稿。
    failure(await api<unknown>(server, `/api/revisions/${oldRevision.id}/finalize`, jsonInit('POST', {})), 409, 'CONFLICT')

    const finalized = ok(await api<Chapter>(server, `/api/revisions/${latest.id}/finalize`, jsonInit('POST', {})))
    expect(finalized.status).toBe('finalized')
    expect(finalized.currentRevisionId).toBe(latest.id)

    const detail = ok(await api<{ chapter: Chapter; latestRevision: ChapterRevision }>(server, `/api/chapters/${chapter.id}`))
    expect(detail.chapter.status).toBe('finalized')
    expect(detail.latestRevision.status).toBe('finalized')

    const audit = ok(await api<Array<{ action: string }>>(server, `/api/projects/${project.id}/audit?limit=50`))
    expect(audit.map(entry => entry.action)).toContain('chapter.finalize_manual')

    const exported = await fetch(`${server.handle.url}/api/projects/${project.id}/export.md`)
    expect(exported.status).toBe(200)
    expect(exported.headers.get('content-type')).toContain('text/markdown')
    const markdown = await exported.text()
    expect(markdown).toContain('# 服务端测试书')
    expect(markdown).toContain('最新正文')
  })

  it('定稿：显式 allowUnreviewed=false 时未审查版本 WORKFLOW_ERROR；已审查版本审计为 chapter.finalize', async () => {
    const server = await startServer()
    const project = await createProject(server)
    const chapter = await createChapter(server, project.id)

    const unreviewed = await createManualRevision(server, chapter.id, '未审查正文')
    failure(
      await api<unknown>(server, `/api/revisions/${unreviewed.id}/finalize`, jsonInit('POST', { allowUnreviewed: false })),
      409, 'WORKFLOW_ERROR',
    )
    expect(ok(await api<{ chapter: Chapter }>(server, `/api/chapters/${chapter.id}`)).chapter.currentRevisionId).toBeNull()

    const reviewed = await createManualRevision(server, chapter.id, '已审查正文')
    server.handle.service.store.createReview(reviewed.id, { summary: '未发现阻断问题。', issues: [] })
    const finalized = ok(await api<Chapter>(server, `/api/revisions/${reviewed.id}/finalize`, jsonInit('POST', {})))
    expect(finalized.status).toBe('finalized')
    const audit = ok(await api<Array<{ action: string }>>(server, `/api/projects/${project.id}/audit?limit=50`))
    expect(audit.map(entry => entry.action)).toContain('chapter.finalize')
    expect(audit.map(entry => entry.action)).not.toContain('chapter.finalize_manual')
  })

  it('AI 接口在 hasApiKey=false 时统一返回 400 CONFIG_ERROR，且不发起任何模型请求', async () => {
    const server = await startServer({ hasApiKey: () => false })
    const project = await createProject(server)
    const chapter = await createChapter(server, project.id)
    const revision = await createManualRevision(server, chapter.id, '正文')

    const cases: Array<[string, unknown]> = [
      ['/api/projects/generate', { idea: '写一本近未来侦探小说' }],
      [`/api/projects/${project.id}/outlines/plan`, { chapterCount: 1 }],
      [`/api/chapters/${chapter.id}/plan`, {}],
      [`/api/chapters/${chapter.id}/draft`, {}],
      [`/api/revisions/${revision.id}/review`, {}],
      [`/api/revisions/${revision.id}/revise`, { issueIds: ['issue_x'] }],
      [`/api/revisions/${revision.id}/continue`, {}],
      [`/api/revisions/${revision.id}/rewrite`, { instruction: '更克制一些' }],
    ]
    for (const [path, payload] of cases) {
      const result = await api<unknown>(server, path, jsonInit('POST', payload))
      const error = failure(result, 400, 'CONFIG_ERROR')
      expect(error.message).toContain('DEEPSEEK_API_KEY')
    }
    // 数据库里不应出现任何 workflow run 或模型版本。
    expect(server.handle.service.store.listWorkflowRuns(project.id)).toEqual([])
    expect(server.handle.service.store.listRevisions(chapter.id)).toHaveLength(1)
  })

  it('未知接口 404、非法 JSON 400、非本机 Origin 写请求 403、同源写请求放行', async () => {
    const server = await startServer()

    failure(await api<unknown>(server, '/api/definitely-not-a-route'), 404, 'NOT_FOUND')

    const invalid = await fetch(`${server.handle.url}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
    })
    expect(invalid.status).toBe(400)
    expect((await invalid.json() as FailureBody).error.code).toBe('INVALID_INPUT')

    const crossOrigin = await api<unknown>(server, '/api/projects', jsonInit('POST', { title: '恶意', genre: '奇幻' }, {
      origin: 'http://evil.example.com',
    }))
    failure(crossOrigin, 403, 'FORBIDDEN')
    expect(ok(await api<Project[]>(server, '/api/projects'))).toEqual([])

    // 本机同源写请求（Origin = 实际监听地址）必须放行，并返回 CORS 头。
    const sameOrigin = await api<Project>(server, '/api/projects', jsonInit('POST', { title: '同源', genre: '奇幻' }, {
      origin: server.handle.url,
    }))
    expect(sameOrigin.status).toBe(200)
    expect(ok(sameOrigin).title).toBe('同源')
    expect(sameOrigin.headers.get('access-control-allow-origin')).toBe(server.handle.url)

    // 跨站读取不返回 CORS 允许头（浏览器侧因此读不到响应）。
    const crossOriginRead = await api<{ version: string }>(server, '/api/health', { headers: { origin: 'http://evil.example.com' } })
    expect(crossOriginRead.status).toBe(200)
    expect(crossOriginRead.headers.get('access-control-allow-origin')).toBeNull()

    const preflight = await fetch(`${server.handle.url}/api/projects`, { method: 'OPTIONS', headers: { origin: server.handle.url } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PATCH')

    const staticPost = await fetch(`${server.handle.url}/`, { method: 'POST', body: 'x' })
    expect(staticPost.status).toBe(405)
    expect((await staticPost.json() as FailureBody).error.code).toBe('INVALID_INPUT')
  })

  it('静态资源：未构建时 503 提示 studio:build，构建后 SPA 回退且不泄露仓库文件', async () => {
    const server = await startServer()

    const notBuilt = await fetch(`${server.handle.url}/`)
    expect(notBuilt.status).toBe(503)
    expect(notBuilt.headers.get('content-type')).toContain('text/html')
    expect(await notBuilt.text()).toContain('pnpm run studio:build')

    writeFileSync(join(server.studioDir, 'index.html'), '<!doctype html><html><body>studio-shell</body></html>')
    mkdirSync(join(server.studioDir, 'assets'), { recursive: true })
    writeFileSync(join(server.studioDir, 'assets', 'app.js'), 'console.log("studio-asset")')

    const index = await fetch(`${server.handle.url}/`)
    expect(index.status).toBe(200)
    expect(index.headers.get('content-type')).toContain('text/html')
    expect(await index.text()).toContain('studio-shell')

    const asset = await fetch(`${server.handle.url}/assets/app.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toContain('text/javascript')
    expect(await asset.text()).toContain('studio-asset')

    const spa = await fetch(`${server.handle.url}/chapters/chapter_unknown/route`)
    expect(spa.status).toBe(200)
    expect(await spa.text()).toContain('studio-shell')

    const traversal = await rawGet(server, '/%2e%2e/%2e%2e/package.json')
    expect(traversal.status).toBe(200)
    expect(traversal.text).toContain('studio-shell')
    expect(traversal.text).not.toContain('"name": "novelforge-dsh"')

    const malformed = await rawGet(server, '/%E0%A4%A')
    expect(malformed.status).toBe(400)
    expect(malformed.contentType).toContain('text/plain')
    expect(malformed.text).toContain('编码非法')
  })

  it('审查与提议：读取审查、更新问题状态、驳回/应用提议、工作流列表', async () => {
    const server = await startServer()
    const project = await createProject(server)
    const chapter = await createChapter(server, project.id)
    const revision = await createManualRevision(server, chapter.id, '有问题的正文')
    const review = server.handle.service.store.createReview(revision.id, {
      summary: '发现问题',
      issues: [{
        category: 'continuity', severity: 'major', start: 0, end: 2,
        issue: '时间线矛盾', evidence: [], suggestedFix: '调整顺序',
      }],
    })

    const runs = ok(await api<Array<{ run: ReviewRun; chapter: { id: string }; issueCount: number; openCount: number }>>(
      server, `/api/projects/${project.id}/reviews`,
    ))
    expect(runs).toHaveLength(1)
    expect(runs[0]!.run.id).toBe(review.run.id)
    expect(runs[0]!.chapter.id).toBe(chapter.id)
    expect(runs[0]!.issueCount).toBe(1)
    expect(runs[0]!.openCount).toBe(1)

    const reviewDetail = ok(await api<{ run: ReviewRun; chapter: Chapter; issues: ReviewIssue[] }>(
      server, `/api/reviews/${review.run.id}`,
    ))
    expect(reviewDetail.run.id).toBe(review.run.id)
    expect(reviewDetail.chapter.id).toBe(chapter.id)
    expect(reviewDetail.issues).toHaveLength(1)

    failure(await api<unknown>(server, `/api/issues/${review.issues[0]!.id}`, jsonInit('PATCH', { status: 'bogus' })), 400, 'INVALID_INPUT')
    const resolved = ok(await api<ReviewIssue>(server, `/api/issues/${review.issues[0]!.id}`, jsonInit('PATCH', { status: 'resolved' })))
    expect(resolved.resolutionStatus).toBe('resolved')
    expect(ok(await api<{ counts: { openIssues: number } }>(server, `/api/projects/${project.id}`)).counts.openIssues).toBe(0)

    const rejectedProposal = ok(await api<ChangeProposal>(server, `/api/projects/${project.id}/proposals`, jsonInit('POST', {
      targetType: 'foreshadowing', operation: 'create', payload: { name: '会被驳回的伏笔', description: '说明' },
    })))
    expect(rejectedProposal.status).toBe('pending')
    const rejected = ok(await api<ChangeProposal>(server, `/api/proposals/${rejectedProposal.id}/reject`, jsonInit('POST', {})))
    expect(rejected.status).toBe('rejected')
    failure(await api<unknown>(server, `/api/proposals/${rejectedProposal.id}/reject`, jsonInit('POST', {})), 409, 'CONFLICT')

    const appliedProposal = ok(await api<ChangeProposal>(server, `/api/projects/${project.id}/proposals`, jsonInit('POST', {
      targetType: 'event', operation: 'create', payload: { summary: '雨夜事件', eventTime: '第一日' },
    })))
    const applied = ok(await api<ChangeProposal>(server, `/api/proposals/${appliedProposal.id}/apply`, jsonInit('POST', {})))
    expect(applied.status).toBe('applied')
    expect(applied.appliedAt).not.toBeNull()

    const events = ok(await api<Array<{ summary: string }>>(server, `/api/projects/${project.id}/events`))
    expect(events.map(row => row.summary)).toEqual(['雨夜事件'])
    const pending = ok(await api<ChangeProposal[]>(server, `/api/projects/${project.id}/proposals?status=pending`))
    expect(pending).toEqual([])
    expect(ok(await api<unknown[]>(server, `/api/projects/${project.id}/workflows`))).toEqual([])

    const hits = ok(await api<Array<{ recordType: string }>>(server, `/api/projects/${project.id}/search?q=${encodeURIComponent('雨夜事件')}`))
    expect(hits.some(hit => hit.recordType === 'event')).toBe(true)
    failure(await api<unknown>(server, `/api/projects/${project.id}/search?q=`), 400, 'INVALID_INPUT')
  })

  it('事件与伏笔：作者可手动创建，列表可见且审计与搜索索引同步', async () => {
    const server = await startServer()
    const project = await createProject(server)
    const chapter = await createChapter(server, project.id, '第一章')

    failure(await api<unknown>(server, `/api/projects/${project.id}/events`, jsonInit('POST', {})), 400, 'INVALID_INPUT')
    failure(
      await api<unknown>(server, `/api/projects/${project.id}/foreshadowing`, jsonInit('POST', { name: '   ' })),
      400, 'INVALID_INPUT',
    )

    const event = ok(await api<StoryEvent>(server, `/api/projects/${project.id}/events`, jsonInit('POST', {
      summary: '作者手动写下的事件', eventTime: '第三日', chapterId: chapter.id,
    })))
    expect(event.summary).toBe('作者手动写下的事件')
    expect(event.status).toBe('confirmed')
    expect(event.chapterId).toBe(chapter.id)
    expect(event.version).toBe(1)

    const foreshadowing = ok(await api<Foreshadowing>(server, `/api/projects/${project.id}/foreshadowing`, jsonInit('POST', {
      name: '旧信', description: '主角在抽屉里发现的信', plantChapterId: chapter.id,
    })))
    expect(foreshadowing.name).toBe('旧信')
    expect(foreshadowing.status).toBe('open')
    expect(foreshadowing.plantChapterId).toBe(chapter.id)

    const events = ok(await api<StoryEvent[]>(server, `/api/projects/${project.id}/events`))
    expect(events.map(row => row.id)).toContain(event.id)
    const foreshadowingRows = ok(await api<Foreshadowing[]>(server, `/api/projects/${project.id}/foreshadowing`))
    expect(foreshadowingRows.map(row => row.id)).toContain(foreshadowing.id)

    const audit = ok(await api<Array<{ action: string; entityId: string }>>(server, `/api/projects/${project.id}/audit?limit=100`))
    expect(audit.some(entry => entry.action === 'event.create' && entry.entityId === event.id)).toBe(true)
    expect(audit.some(entry => entry.action === 'foreshadowing.create' && entry.entityId === foreshadowing.id)).toBe(true)

    // 两字中文名走子串回退，验证伏笔也进了检索通道。
    const hits = ok(await api<Array<{ recordType: string; recordId: string }>>(
      server, `/api/projects/${project.id}/search?q=${encodeURIComponent('旧信')}`,
    ))
    expect(hits.some(hit => hit.recordType === 'foreshadowing' && hit.recordId === foreshadowing.id)).toBe(true)

    const overview = ok(await api<{ counts: { events: number; foreshadowingOpen: number } }>(server, `/api/projects/${project.id}`))
    expect(overview.counts.events).toBe(1)
    expect(overview.counts.foreshadowingOpen).toBe(1)
  })

  it('close() 后端口释放，可在同一端口重新启动', async () => {
    const first = await startServer()
    const port = first.handle.port
    expect(port).toBeGreaterThan(0)
    expect(ok(await api<{ version: string }>(first, '/api/health')).version).toBeTruthy()
    await first.close()

    const second = await startServer({ port })
    expect(second.handle.port).toBe(port)
    expect(ok(await api<{ version: string }>(second, '/api/health')).version).toBeTruthy()
    expect(ok(await api<Project[]>(second, '/api/projects'))).toEqual([])
  })

  /**
   * 已知缺口（见完成报告）：POST /api/projects/:projectId/proposals 直接把 targetType / operation
   * 断言成联合类型，没有枚举校验；非法值会落库，apply 时又按 foreshadowing 分支静默写入错误资料。
   * 正确行为应是 400 INVALID_INPUT。缺陷修复后此用例会转为失败，届时去掉 .fails 并改成正常断言。
   */
  it('变更提议接口校验 targetType / operation 枚举', async () => {
    const server = await startServer()
    const project = await createProject(server)
    const result = await api<ChangeProposal>(server, `/api/projects/${project.id}/proposals`, jsonInit('POST', {
      targetType: 'not_a_type', operation: 'not_an_operation', payload: { name: '非法提议' },
    }))
    failure(result, 400, 'INVALID_INPUT')
  })

  /** 空 payload 与非法字段值都必须映射为 400 INVALID_INPUT（不能 500，也不能静默落库）。 */
  it('变更提议的 payload 校验失败返回 400 INVALID_INPUT', async () => {
    const server = await startServer()
    const project = await createProject(server)
    const endpoint = `/api/projects/${project.id}/proposals`

    const emptyPayload = await api<ChangeProposal>(server, endpoint, jsonInit('POST', {
      targetType: 'event', operation: 'create', payload: {},
    }))
    failure(emptyPayload, 400, 'INVALID_INPUT')

    const invalidField = await api<unknown>(server, endpoint, jsonInit('POST', {
      targetType: 'event', operation: 'create', payload: { status: 'not_a_fact_status' },
    }))
    failure(invalidField, 400, 'INVALID_INPUT')
  })
})
