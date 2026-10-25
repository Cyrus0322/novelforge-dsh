import type { IncomingMessage, ServerResponse } from 'node:http'
import { NovelForgeError } from '../shared/errors.js'
import { buildRoutes } from './routes.js'
import type { RouteDeps } from './routes.js'
import { errorStatus, failure, match, readBody, sendJson, serveStaticFile } from './http.js'
import type { Route, RouteContext } from './http.js'

export const HOST_ROUTE_PREFIX = '/novelforge-api'
/** 客户端面板请求时带的自定义头：跨站页面无法在不触发预检的情况下伪造，用于写操作 CSRF 防护。 */
export const PANEL_HEADER = 'x-novelforge-panel'

export interface HostRouteOptions extends RouteDeps {
  /** 允许的来源判定：默认要求同源（Origin 与 Host 一致）。 */
  isSameOrigin?: (request: IncomingMessage) => boolean
}

function defaultSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin
  if (!origin) return true // 同源 GET / 非浏览器客户端
  try {
    const parsed = new URL(origin)
    const host = request.headers.host
    return parsed.host === host
  } catch {
    return false
  }
}

/**
 * 把 NovelForge 的 REST 路由挂到 DSH 自己的 webServer 上（同源）。
 *
 * 客户端面板直接请求 `<DSH 端口>/novelforge-api/...`：
 * - 不需要第二个进程、不需要扫端口、不会被 CORS 拦
 * - 不再需要浏览器另开页面
 */
export function createHostApiHandler(options: HostRouteOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const routes: Route[] = buildRoutes(options)
  const sameOrigin = options.isSameOrigin ?? defaultSameOrigin

  return async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = (request.method ?? 'GET').toUpperCase()
    if (!sameOrigin(request)) {
      failure(response, 403, 'FORBIDDEN', '只允许 DSH 页面自身调用 NovelForge 接口。')
      return
    }
    // 写操作要求面板头：跨站表单/简单请求无法带自定义头
    if (method !== 'GET' && method !== 'HEAD' && request.headers[PANEL_HEADER] === undefined) {
      failure(response, 403, 'FORBIDDEN', `写操作需要 ${PANEL_HEADER} 请求头。`)
      return
    }

    const url = new URL(request.url ?? '/', 'http://local')
    const stripped = url.pathname.startsWith(HOST_ROUTE_PREFIX)
      ? url.pathname.slice(HOST_ROUTE_PREFIX.length)
      : url.pathname
    const apiPath = `/api${stripped.startsWith('/') ? stripped : `/${stripped}`}`.replace(/\/$/, '')

    for (const route of routes) {
      const params = match(route, method, apiPath)
      if (!params) continue
      let bodyCache: Promise<Record<string, unknown>> | undefined
      const context: RouteContext = {
        request,
        response,
        params,
        query: url.searchParams,
        url,
        body: () => (bodyCache ??= readBody(request)),
      }
      try {
        const result = await route.handler(context)
        if (!response.headersSent) sendJson(response, result)
      } catch (error) {
        const code = error instanceof NovelForgeError ? error.code : 'INTERNAL'
        const message = error instanceof Error ? error.message : String(error)
        const details = error instanceof NovelForgeError ? error.details : undefined
        if (!response.headersSent) failure(response, errorStatus(code), code, message, details)
      }
      return
    }
    failure(response, 404, 'NOT_FOUND', `接口不存在：${method} ${HOST_ROUTE_PREFIX}${stripped}`)
  }
}

/** 把完整工作台前端也挂到 DSH 同源下（/novelforge/），这样不额外起进程也能在大屏打开。 */
export function createHostStaticHandler(studioDir: string, version: string): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = (request.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      failure(response, 405, 'INVALID_INPUT', '静态资源只支持 GET。')
      return
    }
    const url = new URL(request.url ?? '/', 'http://local')
    const inner = url.pathname.startsWith(STATIC_PREFIX) ? url.pathname.slice(STATIC_PREFIX.length) : url.pathname
    serveStaticFile(response, studioDir, inner || '/', version)
  }
}

export const STATIC_PREFIX = '/novelforge'
