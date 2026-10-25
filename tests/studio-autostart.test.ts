import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_CONFIG, validateRuntimeConfig } from '../src/shared/config.js'
import type { RuntimeConfig } from '../src/shared/config.js'
import { createNovelService } from '../src/workflow/novel-service.js'
import { startStudioServer } from '../src/server/index.js'
import type { StudioServerHandle } from '../src/server/index.js'

/**
 * DSH 插件路径：工作台服务复用插件自己的 service（同一个 SQLite 连接），
 * 关闭服务时不得替调用方关掉这个 service；同时 DSH GUI 的端口不固定，
 * 回环地址上的任意端口都必须能写入。
 */

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) {
    const cleanup = cleanups.pop()
    if (cleanup) await cleanup()
  }
})

function tempConfig(): { config: RuntimeConfig; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'novelforge-autostart-'))
  const config = validateRuntimeConfig({
    ...DEFAULT_CONFIG,
    databasePath: join(directory, 'novel.db'),
    apiKey: '',
    baseURL: 'http://127.0.0.1:1',
    maxRetries: 0,
    studioAutoStart: true,
    studioPort: 4319,
  })
  return { config, directory }
}

describe('工作台服务与 DSH 插件共用 service', () => {
  it('ownsService=false：关闭 HTTP 服务后，插件自己的 store 仍然可用', async () => {
    const { config, directory } = tempConfig()
    const service = createNovelService(config)
    cleanups.push(() => { service.close(); rmSync(directory, { recursive: true, force: true }) })

    const handle: StudioServerHandle = await startStudioServer({
      config, port: 0, host: '127.0.0.1', service, ownsService: false,
      studioDir: join(directory, 'none'), hasApiKey: () => false,
    })

    const created = await fetch(`${handle.url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '共用连接', genre: '测试' }),
    })
    expect(created.status).toBe(200)

    await handle.close()

    // 服务关掉后，同一个 store 仍能读到刚写入的项目（没有被连带关闭）。
    expect(service.store.listProjects().map(project => project.title)).toEqual(['共用连接'])
  })

  it('DSH GUI 是另一个端口：回环 Origin 的写请求必须放行，跨站必须拒绝', async () => {
    const { config, directory } = tempConfig()
    const service = createNovelService(config)
    cleanups.push(() => { service.close(); rmSync(directory, { recursive: true, force: true }) })

    const handle = await startStudioServer({
      config, port: 0, host: '127.0.0.1', service, ownsService: false,
      studioDir: join(directory, 'none'), hasApiKey: () => false,
    })
    cleanups.push(() => handle.close())

    const sameMachine = await fetch(`${handle.url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:49996' },
      body: JSON.stringify({ title: 'DSH 面板写入', genre: '测试' }),
    })
    expect(sameMachine.status).toBe(200)
    expect(sameMachine.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:49996')

    const crossSite = await fetch(`${handle.url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ title: '不该写入', genre: '测试' }),
    })
    expect(crossSite.status).toBe(403)
  })

  it('studioPort 由配置校验，非法端口直接报 CONFIG_ERROR', () => {
    expect(() => validateRuntimeConfig({ ...DEFAULT_CONFIG, studioPort: 80 })).toThrowError(/studioPort/)
    expect(() => validateRuntimeConfig({ ...DEFAULT_CONFIG, studioPort: 4319 })).not.toThrow()
  })
})
