/**
 * DSH Web GUI 客户端插件入口。
 *
 * 契约（0.2.1-rc.3 实机核验，参照 @deepseek-ai/dsh-client-ui-plugin-manager / open-in-app）：
 * - 由 package.json 的 `dsh.client = { platform: 'web', inject: [...] }` 声明，`exports["./client"]` 指向本 bundle
 * - bundle 以 `window.__ModuleLoader__.load({ id, factory })` 注册，factory(require) 返回模块导出
 * - 模块导出 Cordis 客户端插件形态：`{ name, inject, apply }`
 * - `ctx.slots.register({ name, key/id, ... }, Component)` 注册面板；`ctx.layout.selectPanel(id)` 切换
 *
 * 客户端只读本机 NovelForge 工作台服务的 REST 接口，不接触 SQLite。
 */
import { NovelForgeIcon, NovelForgePanel } from './panel.js'

export const name = 'novelforge-client'

/** Cordis 客户端服务依赖：slots 提供插槽注册，layout 提供面板切换。 */
export const inject = ['slots', 'layout']

export const PANEL_ID = 'novelforge'

interface ClientSlotApi {
  inject: (slot: string, callback: () => unknown) => unknown
  register: (options: Record<string, unknown>, component: unknown) => unknown
}
interface ClientContext {
  slots?: ClientSlotApi
  layout?: { selectPanel?: (id: string | null) => void }
}

type Logger = { warn?: (...args: unknown[]) => void }
let logger: Logger = console

export function apply(ctx: ClientContext, config?: { log?: Logger }): void {
  if (config?.log) logger = config.log
  if (!ctx.slots) {
    logger.warn?.('[novelforge] 当前 DSH 版本没有 slots 服务，内嵌面板未注册。')
    return
  }
  const slots = ctx.slots

  // 主区域面板：全局面板，占据 root 作用域的 `main` keyed slot。
  try {
    slots.inject('main', () => slots.register({
      name: 'main',
      key: PANEL_ID,
    }, NovelForgePanel))
  } catch (error) {
    logger.warn?.('[novelforge] 注册主面板失败：', error)
  }

  // 侧边栏入口：点开后由 layout.selectPanel 切到本面板。
  try {
    slots.inject('sidebar.panellist', () => slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 30,
      label: () => '小说',
    }, NovelForgeIcon))
  } catch (error) {
    logger.warn?.('[novelforge] 注册侧边栏入口失败：', error)
  }

  // 首次加载时如果 URL 带 #novelforge，直接切到本面板（便于从文档/外部链接跳转）。
  try {
    if (typeof window !== 'undefined' && window.location.hash === '#novelforge') {
      ctx.layout?.selectPanel?.(PANEL_ID)
    }
  } catch { /* 忽略：仅影响自动跳转 */ }
}
