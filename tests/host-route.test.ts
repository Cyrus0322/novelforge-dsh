import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NovelStore } from '../src/database/store.js'
import { NovelService } from '../src/workflow/novel-service.js'
import { MockLlm, testConfig } from './helpers.js'
import { HOST_ROUTE_PREFIX, PANEL_HEADER, STATIC_PREFIX, createHostApiHandler, createHostStaticHandler } from '../src/server/host-route.js'

/**
 * 宿主同源路由：面板直接请求 DSH 自己的端口，不需要第二个进程。
 * 这里用一个真实的 node:http 服务器挂同款 handler 验证。
 */

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) {
    const cleanup = cleanups.pop()
    if (cleanup) await cleanup()
  }
})

function startHost(options: { studioDir: string }): Promise<{ url: string; service: NovelService }> {
  const store = new NovelStore(':memory:')
  const service = new NovelService(store, new MockLlm(() => '{}'), testConfig())
  const handler = createHostApiHandler({
    service,
    store: service.store,
    version: '0.9.0-test',
    databasePath: ':memory:',
    studioDir: options.studioDir,
    hasApiKey: () => true,
    llmSource: () => 'host',
  })
  const staticHandler = createHostStaticHandler(options.studioDir, '0.9.0-test')
  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    if (path === STATIC_PREFIX || path.startsWith(`${STATIC_PREFIX}/`)) {
      void staticHandler(request, response)
      return
    }
    void handler(request, response)
  })
  cleanups.push(() => {
    service.close()
    return new Promise<void>(resolve => { server.close(() => resolve()) })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ url: `http://127.0.0.1:${port}`, service })
    })
  })
}

describe('DSH 宿主同源路由', () => {
  it('GET /novelforge-api/health 返回版本与模型来源', async () => {
    const { url } = await startHost({ studioDir: join(tmpdir(), 'nope') })
    const response = await fetch(`${url}${HOST_ROUTE_PREFIX}/health`)
    expect(response.status).toBe(200)
    const payload = await response.json() as { ok: boolean; data: { version: string; llmSource: string } }
    expect(payload.ok).toBe(true)
    expect(payload.data.version).toBe('0.9.0-test')
    expect(payload.data.llmSource).toBe('host')
  })

  it('写操作必须带面板头；带了就能建项目', async () => {
    const { url } = await startHost({ studioDir: join(tmpdir(), 'nope') })

    const withoutHeader = await fetch(`${url}${HOST_ROUTE_PREFIX}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '归墟', genre: '悬疑' }),
    })
    expect(withoutHeader.status).toBe(403)

    const created = await fetch(`${url}${HOST_ROUTE_PREFIX}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PANEL_HEADER]: '1' },
      body: JSON.stringify({ title: '归墟', genre: '悬疑' }),
    })
    expect(created.status).toBe(200)

    const list = await fetch(`${url}${HOST_ROUTE_PREFIX}/projects`)
    const payload = await list.json() as { data: Array<{ title: string }> }
    expect(payload.data.map(item => item.title)).toEqual(['归墟'])
  })

  it('跨站 Origin 被拒绝（即使带了面板头）', async () => {
    const { url } = await startHost({ studioDir: join(tmpdir(), 'nope') })
    const response = await fetch(`${url}${HOST_ROUTE_PREFIX}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', [PANEL_HEADER]: '1' },
      body: JSON.stringify({ title: 'x', genre: 'y' }),
    })
    expect(response.status).toBe(403)
  })

  it('同源下也能直接打开完整工作台（静态 + SPA 回退）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nf-host-static-'))
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>NovelForge</title><div id="root"></div>')
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const { url } = await startHost({ studioDir: dir })

    const index = await fetch(`${url}${STATIC_PREFIX}/`)
    expect(index.status).toBe(200)
    expect(await index.text()).toContain('NovelForge')

    const deepLink = await fetch(`${url}${STATIC_PREFIX}/p/xxx/chapters/yyy`)
    expect(deepLink.status).toBe(200)
    expect(await deepLink.text()).toContain('NovelForge')
  })
})
