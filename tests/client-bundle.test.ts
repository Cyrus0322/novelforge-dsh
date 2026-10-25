import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { NovelForgePanel } from '../src/client/panel.tsx'

/**
 * 校验 lib/client.js 与 DSH 0.2.1-rc.3 的客户端插件契约一致：
 * - 通过 window.__ModuleLoader__.load({ id, factory }) 注册
 * - factory(require) 只 require 基座模块（react / react/jsx-runtime）
 * - 模块导出 Cordis 客户端插件形态 { name, inject, apply }
 * - apply 把面板注册进 main（keyed）与 sidebar.panellist 插槽
 */

const nodeRequire = createRequire(import.meta.url)
const bundlePath = resolve('lib/client.js')

interface Registration { slot?: string; options: Record<string, unknown>; component: unknown }

function baseRequire(moduleName: string): unknown {
  if (moduleName === 'react') return nodeRequire('react')
  if (moduleName === 'react/jsx-runtime') return nodeRequire('react/jsx-runtime')
  throw new Error(`bundle 请求了未声明的外部模块：${moduleName}`)
}

function loadBundle(hash = ''): { id: string; module: Record<string, unknown> } {
  const code = readFileSync(bundlePath, 'utf8')
  let loaded: { id: string; module: Record<string, unknown> } | null = null
  const fakeWindow = {
    location: { hash },
    __ModuleLoader__: {
      load: ({ id, factory }: { id: string; factory: (req: (name: string) => unknown) => Record<string, unknown> }) => {
        loaded = { id, module: factory(baseRequire) }
      },
    },
  }
  // bundle 顶层只调用 window.__ModuleLoader__，不碰 document，因此可直接在 Node 中求值。
  new Function('window', code)(fakeWindow)
  if (!loaded) throw new Error('bundle 没有调用 __ModuleLoader__.load')
  return loaded as { id: string; module: Record<string, unknown> }
}

function createCtx(): { registrations: Registration[]; selected: string[]; ctx: Record<string, unknown> } {
  const registrations: Registration[] = []
  const selected: string[] = []
  const ctx = {
    slots: {
      inject: (slot: string, callback: () => unknown) => {
        const before = registrations.length
        const result = callback()
        for (let index = before; index < registrations.length; index += 1) {
          const entry = registrations[index]
          if (entry && entry.slot === undefined) entry.slot = slot
        }
        return result
      },
      register: (options: Record<string, unknown>, component: unknown) => {
        registrations.push({ options, component })
        return { dispose: () => undefined }
      },
    },
    layout: { selectPanel: (id: string | null) => { if (id) selected.push(id) } },
  }
  return { registrations, selected, ctx }
}

describe('DSH 客户端插件 bundle', () => {
  it('以 window.__ModuleLoader__.load 注册，且只依赖基座模块', () => {
    const { id } = loadBundle()
    expect(id).toBe('novelforge-dsh')
    const code = readFileSync(bundlePath, 'utf8')
    const required = [...code.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1])
    expect(new Set(required)).toEqual(new Set(['react', 'react/jsx-runtime']))
  })

  it('导出 Cordis 客户端插件形态 { name, inject, apply }', () => {
    const { module } = loadBundle()
    expect(typeof module.name).toBe('string')
    expect(Array.isArray(module.inject)).toBe(true)
    expect(module.inject).toContain('slots')
    expect(typeof module.apply).toBe('function')
    expect(module.PANEL_ID).toBe('novelforge')
  })

  it('apply 把面板注册进 main（keyed）与 sidebar.panellist（label/id）', () => {
    const { module } = loadBundle()
    const { registrations, ctx } = createCtx()
    ;(module.apply as (context: unknown) => void)(ctx)

    const main = registrations.find(entry => entry.slot === 'main')
    expect(main).toBeTruthy()
    expect(main?.options.name).toBe('main')
    expect(main?.options.key).toBe('novelforge')
    expect(typeof main?.component).toBe('function')

    const sidebar = registrations.find(entry => entry.slot === 'sidebar.panellist')
    expect(sidebar).toBeTruthy()
    expect(sidebar?.options.id).toBe('novelforge')
    expect(typeof sidebar?.options.label).toBe('function')
    expect((sidebar?.options.label as () => string)()).toBe('小说')
  })

  it('缺少 slots 服务时只告警，不抛异常（旧版本 DSH 也不会被搞崩）', () => {
    const { module } = loadBundle()
    const warn = vi.fn()
    expect(() => (module.apply as (context: unknown, config: unknown) => void)({}, { log: { warn } })).not.toThrow()
    expect(warn).toHaveBeenCalled()
  })

  it('#novelforge 链接会在加载时切到本面板', () => {
    const { module } = loadBundle('#novelforge')
    const { selected, ctx } = createCtx()
    ;(module.apply as (context: unknown) => void)(ctx)
    expect(selected).toEqual(['novelforge'])
  })

  it('面板首屏可以静态渲染（无 DOM、无网络时也不崩）', () => {
    const html = renderToStaticMarkup(createElement(NovelForgePanel))
    expect(html).toContain('NovelForge')
    expect(html).toContain('章节')
  })
})
