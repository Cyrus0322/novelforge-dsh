# DSH 兼容性核验

核验日期：2026-10-25。

## 基准

- 官方仓库：`https://github.com/deepseek-ai/deepseek-harness`
- 实际核验提交：`22ddee3792402c3e70ec5f86a63c3e3e895a2f60`
- 根包版本：`0.2.1-rc.3`
- 官方根包要求：Node.js `>=24.9.0`，pnpm `11.28.5`（源码仓库自身要求）。
- 本插件独立 CLI 要求 Node.js `>=22.18.0`；加载进 DSH 时仍以宿主 Node.js `>=24.9.0` 为准。

## 已核实的接口

| 项目 | 当前官方机制 | 官方依据 |
| --- | --- | --- |
| 插件入口 | 导出 `name`、`inject`、`apply(ctx, config)` | `docs/user/develop/basic/index.zh.md` |
| 工具依赖 | `inject = ['tools']` | `docs/user/develop/basic/tool.zh.md` |
| 工具注册 | `ctx.tools.register(defineTool(...))` | `docs/cookbook/adding-a-tool.zh.md` |
| 参数 | `parameters` 使用 DSH `ParameterSchemaSpec`，必填字段标 `required: true` | 同上 |
| 返回值 | `execute` 返回规范 JSON；`output.schema` 校验，`output.render` 生成模型内容 | 同上 |
| 取消 | 执行函数读取 `exec.signal` | 同上 |
| 配置 | 导出同名 `Config` 类型与 Schemastery schema | `docs/user/develop/basic/config.zh.md` |
| 人工审批 | `inject = ['approval']`；`ctx.approval.request(...)` 仅接受 `allowed-once`，其他结果均拒绝写入 | `packages/interaction/user-approval/src/index.ts`、`README.zh.md` |
| 可安装组合包 | `package.json` 中 `dsh.bundle.patch` 指向 YAML patch | `docs/user/develop/basic/publish.zh.md` |
| 本地安装 | `dsh plugin --profile <name> add <package>` | 同上 |
| 版本约束 | `engines.dsh` SemVer 范围 | 同上 |
| 客户端 UI | Host 权威状态 + Client/Slot；不是普通工具插件的附属能力 | `docs/subsystems/web-client.zh.md` |
| 模型调用 | `ctx.llm.stream(options)` 是「进入提供方适配器的唯一受支持路径」 | `packages/llm/llm/README.zh.md` |
| 模型服务取值 | 通过 Cordis 模块增强挂到 `ctx.llm`；可选依赖用 `ctx.get('llm')` 惰性读取 | `packages/llm/llm/src/index.ts`（`declare module '@deepseek-ai/cordis'`）、`@deepseek-ai/cordis` `src/reflect.ts` |
| 默认模型 | `ctx.agentDefaultModel.currentSelection()` 返回 `{ provider, model, reasoningEffort? }` | `packages/core/agent-default-model/README.zh.md` |
| 提供方清单 | `ctx.llm.listProviders(): { id, name }[]` | `packages/llm/llm/src/index.ts` |
| 请求参数 | `GenerateOptions`：`provider`、`model`、`messages`、`system?`、`temperature?`、`maxTokens?`、`signal?` | `packages/llm/llm/src/types.ts` |
| 流式分片 | `StreamChunk`：`text-delta` / `usage` / `finish`；`finish.reason.kind` 为 `stop`｜`tool-calls`｜`max-tokens`｜`aborted`｜`error` | 同上 |
| 失败分诊 | 失败携带稳定 code（`NO_ADAPTER`｜`MISSING_CREDENTIAL`｜`AUTH`｜`RATE_LIMIT`｜`CONTEXT_WINDOW_EXCEEDED`｜`QUOTA` 等），只按 code 路由 | `packages/llm/llm/README.zh.md` |
| 重试职责 | 模型服务自身从不重试；重试属于 `dsh-llm-retry`／调用方 | 同上 |

### 模型调用的适配取舍

官方 `RequestMessage` 要么是带 `id`/`source` 的持久 `Message`，要么是 `RequestUserInput`（仅 user 角色）。插件拿不到持久消息构造器，因此把 `ChatMessage[]` 压成「一条 `system` + 一条 `user`」，`assistant` 轮次以 `<前一次模型输出>` 分隔符内嵌进 user 文本。这样不伪造身份字段，模型可见输入仍是请求内容的纯函数。

`src/llm/dsh-llm.ts` 只按结构化契约声明 `DshLlmRuntime`，不 import `@deepseek-ai/dsh-llm`，以保持领域层与宿主实现解耦。

本项目的 `src/dsh-plugin/index.ts`、`cordis.patch.yml` 和 `package.json` 按以上机制实现，没有使用不存在的 `dsh.plugin.json`。

## 安装与验证

在 Node.js >=24.9.0 且已安装兼容 DSH 的环境中：

```sh
pnpm install
pnpm run build
dsh plugin --profile novel add "$PWD"
dsh --profile novel --dump-config
dsh --profile novel web
```

`--dump-config` 应出现 `novelforge-dsh` 层与 `novelforge` 行。随后在 DSH 会话中要求模型调用 `novel_list_projects` 或 `novel_search`。

## 2026-10-25 实测结果（本机，Node.js v24.22.1）

升级环境后，已在真实 DSH 宿主中完成下列验证：

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 安装 DSH CLI | `npm i @deepseek-ai/dsh@0.2.1-rc.3` | 成功，`dsh --version` 输出 `0.2.1-rc.3` |
| 初始化 profile | `dsh plugin --profile nf add <checkout>` | 成功，写入 `~/.dsh/profiles/nf`；pnpm 以 `link:` 方式链接本 checkout |
| 层组合 | `dsh --profile nf --dump-config` | 成功，输出中出现 `# == novelforge-dsh` 层，含 `id: novelforge` 与全部 14 项默认配置 |
| 版本闸门 | `engines.dsh: >=0.2.1-rc.3 <0.3.0` | 通过：宿主版本号在范围内，未被拒绝 |
| 启动 headless | `dsh --profile nfh "<任务>"` | 插件栈可启动，未出现 novelforge 模块解析或 apply 报错 |

### 仍未完成的验证

- **未做真实工具调用**：本机没有可用的 DeepSeek API Key，headless 启动停在 `MISSING_CREDENTIAL`（占位 Key 时 `api.deepseek.com/models` 返回 401）。因此"模型在会话内实际调用 `novel_*` 工具"这一环仍待你在有 Key 的机器上验收。
- **未做人工审批链路的宿主内验收**：`ctx.approval.request` 的类型与返回值已按 `packages/interaction/user-approval/src/index.ts` 实现并由单测覆盖（含拒绝与取消），但未在真实交互界面中跑通一次。
- 本版不实现 DSH 内嵌 React/Slot 工作台；入口为 DSH 工具、CLI，以及 0.3.0 新增的**独立本地工作台**（见下节）。未来若要内嵌，必须单独核验 Client Modules、Remote API 与 Slot，且不得让浏览器直接访问 SQLite。
- DSH 仍可能调整预览接口。升级宿主时应重新核对上述官方文档、实际 `package.json` 和 `defineTool` 源码。

## 0.3.0 新增：本地工作台 Studio（不新增任何 DSH 接口依赖）

工作台走方案里允许的第二条路线——**独立本地 Web UI + 受控接口**，因此不引入新的 DSH API，也不需要重验工具注册与审批链路：

| 关注点 | 实现 | 与 DSH 的关系 |
| --- | --- | --- |
| HTTP 服务 | `src/server/`，Node 内置 `node:http`，无新增运行时依赖 | 与 DSH 进程无关，可单独启动 |
| 数据访问 | 浏览器只调 `/api/*`；服务端经 `NovelStore` / `NovelService` 读写 SQLite | 与 DSH 工具共用同一领域层与同一份数据库 |
| 写入批准 | 工作台的写操作由作者在页面上点击并二次确认；DSH 工具仍走 `ctx.approval.request` | 两条路径都在 `audit_log` 留痕 |
| 人工定稿 | 无模型审查记录时允许人工定稿，审计记 `chapter.finalize_manual` | DSH 工具路径**永不**传 `allowUnreviewed`，仍强制先审查 |
| 页面托管 | `apps/studio/dist` 静态托管 + SPA 回退 | 不注册 DSH 客户端 Slot，不宣称嵌入 DSH GUI |

启动与自检：

```sh
pnpm run studio:build   # 构建前端
pnpm run studio         # 127.0.0.1:4319，自动开浏览器
```

安全边界（已在代码中实现并有测试覆盖）：默认只监听 `127.0.0.1`；绑定其他地址必须提供令牌；仅放行本机 Origin 的写请求；静态目录做路径穿越校验；畸形 URL 编码返回 400 而不是抛异常。

## 0.4.0 新增：DSH Web 内嵌面板（客户端插件）契约核验

以下每一项都来自本机 **DSH 0.2.1-rc.3 桌面版**（`D:\DeepSeek Haress
esourcespp.asar`）的真实源码，路径可复核；随后在独立安装的 `@deepseek-ai/dsh@0.2.1-rc.3` 上做了端到端验证。

### 1. 包声明

```jsonc
// package.json
"exports": { "./client": { "default": "./lib/client.js" } },
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },   // 宿主侧（已有）
  "client": {
    "platform": "web",                            // 只有 web 平台会进浏览器启动图
    "inject": ["@deepseek-ai/dsh-client-ui-layout"] // 需要先加载的客户端插件包
  }
}
```

依据：`dsh/node_modules/@deepseek-ai/dsh-client-ui-jobs/package.json`、`dsh-client-ui-open-in-app/package.json`；
平台过滤见 `dsh-client-modules/lib/index.js`（`platform !== "web"`）。

### 2. bundle 形态

```js
window.__ModuleLoader__.load({
  id: "<包名>",
  factory: (require) => { /* ... */ return module.exports }
})
```

依据：任一 `lib/client.js` 首行。factory 的 `require` 来自宿主基座，React / `react/jsx-runtime` / `react-dom` 属于基座模块，不需要在 `dsh.client.external` 里声明。
本插件的 bundle 由 `scripts/build-client.mjs` 用 esbuild 产出（`format: cjs`、`react*` external），只 `require("react")` 与 `require("react/jsx-runtime")` 两项，`tests/client-bundle.test.ts` 会断言这一点。

### 3. 面板注册

```js
// 模块导出 Cordis 客户端插件形态
export const name = 'novelforge-client'
export const inject = ['slots', 'layout']      // 客户端服务名
export function apply(ctx) {
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'novelforge' }, Panel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'novelforge', order: 30, label: () => '小说',
  }, Icon))
}
```

依据：`dsh-client-ui-plugin-manager/lib/client.js` 的 `ctx.slots.inject("main", …)` + `ctx.slots.register({ name: "main", key: PANEL_ID, … }, PluginManagerPage)` 与 `sidebar.panellist` 注册块；
`ctx.layout.selectPanel(id)` 见同文件；插槽语义见 `dsh-client-ui-layout/README.zh.md`（全局面板占 root 作用域的 `main` keyed slot，`conversation` 保留）。

### 4. 端到端验证（独立安装的 0.2.1-rc.3，独立 DSH_HOME）

| 步骤 | 命令/动作 | 结果 |
| --- | --- | --- |
| 安装到 profile | `dsh plugin --profile <p> add <repo>` | 成功，profile 的 `dsh.profile.bundles` 追加 `novelforge-dsh` |
| 层组合 | `dsh --profile <p> --dump-config` | 出现 `# == novelforge-dsh` 层与该行 |
| 浏览器启动图 | `GET /?token=…` 后读 `__DSH_BOOT__` | `entries` 中出现 `novelforge-dsh/client.js`（批量 combo URL 与单行 URL 各一份） |
| bundle 下发 | `GET /plugins/??novelforge-dsh/client.js&rev=…` | `200 text/javascript`，内容为本插件 wrapper |
| 宿主侧自动启动 | `GET http://127.0.0.1:4319/api/health` | `200`，`version`/`databasePath` 正常 |
| 契约单测 | `pnpm test`（`tests/client-bundle.test.ts`） | 6 项通过：仅依赖基座模块、导出形态、两个插槽注册、缺少 slots 时只告警、`#novelforge` 跳转、面板可静态渲染 |

### 5. 仍未做的验证

- **没有真实浏览器点击验收**：本机无浏览器自动化，故只验证到「宿主把 bundle 纳入启动图并成功下发 + 宿主侧服务可用」。面板的视觉与交互需要你在 DSH GUI 里点一次侧边栏「小说」确认。
- 若未来 DSH 调整 `slots.register` 的字段（`key` / `id` / `label` / `children`），内嵌面板会失效；代码里每处注册都包了 try/catch 并只告警，不会拖垮 GUI。`tests/client-bundle.test.ts` 固定了当前契约，升级宿主时先跑它。

## 0.9.0：宿主同源路由（不再需要第二个进程）

从 `@deepseek-ai/dsh-host-webserver` 的实机源码确认了路由扩展点：

```js
// dsh-host-webserver/lib/index.js
register(route) {                     // route = { kind: 'exact' | 'prefix', path, handler }
  const table = route.kind === 'exact' ? this.exact : this.prefixes
  ...
}
// 分发：await route.handler(req, res)   —— handler 就是 (IncomingMessage, ServerResponse)
```

插件在 `apply` 里通过 `ctx.get('webServer')` 取服务并注册两个前缀路由：

| 前缀 | 作用 |
| --- | --- |
| `/novelforge-api` | 全部 REST 接口（与独立服务同一套 `buildRoutes`），面板同源调用 |
| `/novelforge` | 完整工作台静态前端（SPA 回退） |

安全：接口按「同源」判定（`Origin` 与 `Host` 不一致 → 403），写操作还要求 `x-novelforge-header`
(`x-novelforge-panel`) 自定义头，跨站页面无法在不触发预检的情况下伪造。

模型：宿主有 `ctx.llm` 时面板走宿主模型；`/api/health` 的 `llmSource` 会返回 `host` / `direct` / `none`，
面板顶部据此显示「模型：DSH 宿主」。

回退：宿主没有 `webServer`（旧版）或显式 `studioAutoStart: true` 时才起独立 HTTP 服务（4319 起顺延）。
