import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { NovelForgeError } from '../shared/errors.js'

export const MAX_BODY_BYTES = 8 * 1024 * 1024

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

export type Handler = (context: RouteContext) => Promise<unknown> | unknown

export interface RouteContext {
  request: IncomingMessage
  response: ServerResponse
  params: Record<string, string>
  query: URLSearchParams
  body: () => Promise<Record<string, unknown>>
  url: URL
}

export interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  pattern: string
  handler: Handler
}

export function errorStatus(code: string): number {
  switch (code) {
    case 'NOT_FOUND': return 404
    case 'INVALID_INPUT': return 400
    case 'CONFIG_ERROR': return 400
    case 'CONFLICT': return 409
    case 'WORKFLOW_ERROR': return 409
    case 'APPROVAL_REQUIRED': return 403
    case 'LLM_ERROR': return 502
    default: return 500
  }
}

function failure(response: ServerResponse, status: number, code: string, message: string, details?: unknown): void {
  const payload = JSON.stringify({ ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } })
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

export function sendJson(response: ServerResponse, data: unknown, status = 200): void {
  const payload = JSON.stringify({ ok: true, data })
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

export function sendText(response: ServerResponse, text: string, contentType: string, status = 200): void {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

export async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(request.headers['content-length'] ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new NovelForgeError('INVALID_INPUT', `请求体过大（上限 ${MAX_BODY_BYTES} 字节）。`)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) throw new NovelForgeError('INVALID_INPUT', `请求体过大（上限 ${MAX_BODY_BYTES} 字节）。`)
    chunks.push(buffer)
  }
  if (!total) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new NovelForgeError('INVALID_INPUT', '请求体必须是合法 JSON。')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new NovelForgeError('INVALID_INPUT', '请求体必须是 JSON 对象。')
  }
  return parsed as Record<string, unknown>
}

function match(route: Route, method: string, pathname: string): Record<string, string> | null {
  if (route.method !== method) return null
  const patternParts = route.pattern.split('/').filter(Boolean)
  const pathParts = pathname.split('/').filter(Boolean)
  if (patternParts.length !== pathParts.length) return null
  const params: Record<string, string> = {}
  for (let index = 0; index < patternParts.length; index += 1) {
    const pattern = patternParts[index] as string
    const value = pathParts[index] as string
    if (pattern.startsWith(':')) {
      try {
        params[pattern.slice(1)] = decodeURIComponent(value)
      } catch {
        return null
      }
    } else if (pattern !== value) {
      return null
    }
  }
  return params
}

/**
 * 只允许本机来源直接跨域访问，避免任何公网页面把本地小说库拖走。
 * 端口不参与判断：DSH Web GUI 的端口随会话变化，而回环地址上的页面本就与本地服务同机。
 */
function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  try {
    const url = new URL(origin)
    return ['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0'].includes(url.hostname)
  } catch {
    return false
  }
}

export interface DispatcherOptions {
  routes: Route[]
  studioDir: string
  token: string
  port: number
  version: string
}

export function createDispatcher(options: DispatcherOptions) {
  return async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // 实际监听端口从 socket 取：port:0 或端口回退（4319→4320）时，
    // 请求的「期望端口」与实际端口不同，否则同源写请求会被误判为跨站。
    const localPort = request.socket.localPort ?? options.port
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${localPort}`)
    const origin = request.headers.origin
    const method = (request.method ?? 'GET').toUpperCase()

    if (origin && isLocalOrigin(origin)) {
      response.setHeader('access-control-allow-origin', origin)
      response.setHeader('vary', 'origin')
      response.setHeader('access-control-allow-headers', 'content-type, x-novelforge-token')
      response.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    }
    if (method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }

    if (url.pathname.startsWith('/api/')) {
      if (options.token) {
        const provided = request.headers['x-novelforge-token'] ?? url.searchParams.get('token') ?? ''
        if (provided !== options.token) {
          failure(response, 401, 'UNAUTHORIZED', '缺少或错误的访问令牌：请在请求头 x-novelforge-token 中提供。')
          return
        }
      }
      if (method !== 'GET' && origin && !isLocalOrigin(origin)) {
        failure(response, 403, 'FORBIDDEN', '只允许本机页面写入小说资料。')
        return
      }
      let matched = false
      for (const route of options.routes) {
        const params = match(route, method, url.pathname)
        if (!params) continue
        matched = true
        let bodyCache: Promise<Record<string, unknown>> | undefined
        const context: RouteContext = {
          request, response, params, query: url.searchParams, url,
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
      if (!matched) failure(response, 404, 'NOT_FOUND', `接口不存在：${method} ${url.pathname}`)
      return
    }

    if (method !== 'GET' && method !== 'HEAD') {
      failure(response, 405, 'INVALID_INPUT', '静态资源只支持 GET。')
      return
    }
    serveStatic(response, options.studioDir, url.pathname, options.version)
  }
}

function serveStatic(response: ServerResponse, studioDir: string, pathname: string, version: string): void {
  const indexFile = join(studioDir, 'index.html')
  if (!existsSync(indexFile)) {
    sendText(response, NOT_BUILT_HTML(studioDir, version), 'text/html; charset=utf-8', 503)
    return
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    sendText(response, '请求路径编码非法，拒绝解码。', 'text/plain; charset=utf-8', 400)
    return
  }
  const relative = normalize(decoded).replace(/^([/\\])+/, '')
  const candidate = resolve(studioDir, relative)
  const root = resolve(studioDir) + sep
  const safe = candidate === resolve(studioDir) || candidate.startsWith(root)
  const target = safe && relative && existsSync(candidate) && statSync(candidate).isFile() ? candidate : indexFile
  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
  const stat = statSync(target)
  response.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': target === indexFile ? 'no-store' : 'public, max-age=3600',
  })
  if (!response.writeHead) return
  createReadStream(target).pipe(response)
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char))
}

function NOT_BUILT_HTML(studioDir: string, version: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>NovelForge 工作台未构建</title>
<style>body{background:#0d0f13;color:#e8e6e1;font:15px/1.7 "Segoe UI",system-ui,sans-serif;padding:48px;max-width:760px;margin:auto}
code{background:#1a1d25;padding:2px 6px;border-radius:4px;font-size:13px}h1{font-size:22px;font-weight:600}</style></head>
<body><h1>NovelForge 工作台前端还没构建</h1>
<p>服务端已经在运行（novelforge-dsh ${escape(version)}），但没有找到构建产物：</p>
<p><code>${escape(studioDir)}</code></p>
<p>请在仓库根目录执行：</p>
<p><code>pnpm run studio:build</code></p>
<p>或者用开发模式单独起前端：<code>pnpm --filter @novelforge/studio dev</code>（已内置 /api 代理）。</p>
</body></html>`
}
