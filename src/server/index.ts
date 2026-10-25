import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { NovelForgeError } from '../shared/errors.js'
import type { RuntimeConfig } from '../shared/config.js'
import { createNovelService } from '../workflow/novel-service.js'
import type { NovelService } from '../workflow/novel-service.js'
import { createDispatcher } from './http.js'
import { buildRoutes } from './routes.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const DEFAULT_STUDIO_PORT = 4319

export interface StudioServerOptions {
  config: RuntimeConfig
  port?: number
  host?: string
  token?: string
  studioDir?: string
  service?: NovelService
  hasApiKey?: () => boolean
  autoPort?: boolean
  /** 传入的 service 由调用方持有（DSH 插件场景）：关闭本服务时不关闭它。 */
  ownsService?: boolean
}

export interface StudioServerHandle {
  url: string
  port: number
  service: NovelService
  studioDir: string
  close: () => Promise<void>
}

function packageVersion(): string {
  try {
    const raw = readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: string }
    return parsed.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening)
      rejectPromise(error)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      const address = server.address()
      resolvePromise(typeof address === 'object' && address ? address.port : port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/**
 * 启动本地工作台服务：托管 Studio 静态页面并提供受控 REST 接口。
 * 浏览器端永远不直接读 SQLite，所有写入都经过领域层与审计日志。
 */
export async function startStudioServer(options: StudioServerOptions): Promise<StudioServerHandle> {
  const studioDir = options.studioDir
    ?? process.env.NOVELFORGE_STUDIO_DIR
    ?? resolve(PACKAGE_ROOT, 'apps/studio/dist')
  const service = options.service ?? createNovelService(options.config)
  const ownsService = options.ownsService ?? options.service === undefined
  const releaseService = (): void => { if (ownsService) service.close() }
  const host = options.host ?? process.env.NOVELFORGE_STUDIO_HOST ?? '127.0.0.1'
  const token = options.token ?? process.env.NOVELFORGE_STUDIO_TOKEN ?? ''
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && !token) {
    releaseService()
    throw new NovelForgeError('CONFIG_ERROR', '绑定到非本机地址时必须设置 NOVELFORGE_STUDIO_TOKEN，否则拒绝启动。')
  }
  const hasApiKey = options.hasApiKey ?? ((): boolean => {
    const fromConfig = options.config.apiKey.trim()
    const fromEnv = process.env[options.config.apiKeyEnv]?.trim() ?? ''
    return Boolean(fromConfig || fromEnv)
  })

  const routes = buildRoutes({
    service,
    store: service.store,
    version: packageVersion(),
    databasePath: options.config.databasePath,
    studioDir,
    hasApiKey,
  })
  const dispatcher = createDispatcher({
    routes,
    studioDir,
    token,
    port: options.port ?? DEFAULT_STUDIO_PORT,
    version: packageVersion(),
  })
  const server = createServer((request, response) => {
    void dispatcher(request, response)
  })
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  let port = 0
  const requested = options.port ?? DEFAULT_STUDIO_PORT
  let lastError: unknown
  for (let offset = 0; offset < (options.autoPort === false ? 1 : 12); offset += 1) {
    try {
      port = await listen(server, host, requested + offset)
      lastError = undefined
      break
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EADDRINUSE') break
    }
  }
  if (!port) {
    releaseService()
    throw new NovelForgeError('CONFIG_ERROR', `工作台端口被占用且自动重试失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  return {
    url: `http://${shownHost}:${port}`,
    port,
    service,
    studioDir,
    close: async () => {
      await new Promise<void>(resolvePromise => {
        server.close(() => resolvePromise())
        server.closeAllConnections?.()
      })
      releaseService()
    },
  }
}

/** 尽力打开系统默认浏览器；失败不影响服务本身。 */
export function openBrowser(url: string): void {
  const platform = process.platform
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // 无图形环境时静默忽略，用户仍可手动打开 URL。
  }
}
