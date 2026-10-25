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
