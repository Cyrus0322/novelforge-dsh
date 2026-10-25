# NovelForge DSH

面向长篇网文创作的 DeepSeek Harness（DSH）插件：拥有**持久化知识库、动态上下文、多维度审查、不可覆盖的正文版本和人工确认定稿**，而不是一个只会续写文字的聊天机器人。

插件名：`novelforge`；npm 包名：`novelforge-dsh`；版本：`0.10.0`。

0.10.0 补齐「控制台」视角：状态快照接入审查、伏笔到期进上下文、事件影响分析、创作控制台、面板章卷分组/大纲树/关系图谱，Studio 增加知情矩阵页、关系图谱页与控制台区块。0.9.0 起**面板接口挂在 DSH 自己的 web 服务上（同源）**：不再需要第二个本地进程、不再扫端口、不再为了用工作台去开浏览器；面板顶部会显示当前模型来源（DSH 宿主模型 / 直连 Key）。完整 12 页工作台也能在 `<DSH 端口>/novelforge/` 同源打开。0.8.0 让知情矩阵真正开始工作：审查器会用「谁知道什么」做确定性检查（角色提到自己不知道的事 → major 问题），素材导入也会抽知情事实；另加关系编辑与面板内 AI 批量规划大纲。0.7.0 在 0.6.0 的基础上补齐了长篇写作最缺的几块：知情矩阵、人物状态快照、章纲编辑、事件/伏笔手工增改、关系/剧情线删除、面板内导出、伏笔逾期提醒。0.6.0 起**主界面就在 DSH 里**：侧边栏点「小说」即打开完整工作台——查正文、写正文、定稿、改人物、管剧情线/关系/场景、贴素材让 AI 更新资料库、审批变更，全在 DSH 面板内完成，不需要再开浏览器。完整的 12 页 Studio 仍保留，作为大屏编辑与导出的补充入口。两层共用同一份 SQLite 数据。
GitHub：<https://github.com/Cyrus0322/novelforge-dsh> ｜ npm：<https://www.npmjs.com/package/novelforge-dsh>

---

## 1. 运行环境

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | 独立 CLI：`>=22.18.0` | 本机实测 `v22.22.2` 可运行 CLI、构建与全部测试 |
| Node.js | DSH 宿主：`>=24.9.0` | 官方根包 `package.json` 的 `engines` 要求；**本机已升级至 v24.22.1 并实测通过** |
| pnpm | `11.7.0` | 本机实测；仓库源码自身要求 `11.28.5` |
| TypeScript | `5.9` | `tsc` 构建到 `dist/` |
| 数据库 | SQLite（Node 内置 `node:sqlite`） | 0.2.1 起**不依赖任何原生模块**，安装不需要编译 |
| Node.js | `node:sqlite` 需 `>=22.5` | DSH 宿主要求 `>=24.9`，天然满足；更低版本可装可选依赖 `better-sqlite3` 回退 |
| DSH | `>=0.2.1-rc.3 <0.3.0` | 在 `package.json` 的 `engines.dsh` 中声明；内嵌面板契约按 0.2.1-rc.3 实机核验 |

> 已在真实 DSH `0.2.1-rc.3` 宿主中完成：`dsh plugin add` 安装、`--dump-config` 出现 `novelforge-dsh` 层、headless 启动无插件加载错误。唯一未做的是「模型在会话内真实调用 `novel_*` 工具」——本机无可用 DeepSeek API Key，需用你自己的 Key 验收。详见 `docs/dsh-compatibility.md`。

---

## 2. 目录结构

```
novelforge-dsh/
├── package.json              # 插件清单；dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml          # 插件插入点、启用开关与默认配置
├── pnpm-workspace.yaml       # 根包（插件）+ apps/studio（工作台前端）
├── tsconfig.json             # strict + NodeNext，构建到 dist/
├── vitest.config.ts
├── .env.example
├── locale/{zh,en}.json       # 插件描述本地化
├── src/
│   ├── dsh-plugin/index.ts   # 【入口】Cordis 插件：name / inject / Config / apply
│   ├── cli/index.ts          # 【入口】本地命令行（含 studio 子命令）
│   ├── server/               # 【入口】工作台服务：REST API、静态托管、令牌与来源校验
│   ├── client/               # 【入口】DSH Web 内嵌面板（React 客户端插件，esbuild 打包）
│   ├── domain/schemas.ts     # 蓝图、大纲、章节计划、审查结果的 Zod Schema
│   ├── database/             # SQLite 建表、迁移、Repository（事务、审计、全文索引）
│   ├── retrieval/context.ts  # 动态上下文包与 token 预算裁剪
│   ├── workflow/             # novel-service.ts（编排）+ prompts.ts（提示词模板）
│   ├── llm/                  # DSH 宿主模型适配、DeepSeek 直连回退、结构化输出
│   └── shared/               # 配置、错误码、ID、JSON 工具
├── scripts/build-client.mjs  # 把 src/client 打成 lib/client.js（__ModuleLoader__ 包裹）
├── lib/client.js             # 客户端插件 bundle（构建产物，随 npm 包发布）
├── apps/studio/              # 完整工作台（React 19 + Vite 8 + TypeScript，无 UI 库依赖）
│   ├── index.html
│   ├── vite.config.ts        # base './'，dev 时 /api 代理到 127.0.0.1:4319
│   └── src/
│       ├── app/              # App 外壳、hash 路由、页面 props 约定
│       ├── pages/            # 12 个页面
│       ├── components/ui.tsx # 设计系统基础组件
│       ├── lib/              # api 客户端、类型、hooks、格式化
│       └── styles.css        # 暗色「纸墨」设计系统
├── docs/
│   ├── dsh-compatibility.md  # 官方接口逐项核验记录
│   └── studio-api.md         # 工作台 REST 契约
├── tests/                    # 单元与集成测试（含真实 HTTP 服务测试）
└── data/                     # SQLite 数据库默认位置（已在 .gitignore 中）
```

分层边界：`domain` / `database` / `retrieval` / `workflow` / `server` 不依赖 DSH；只有 `dsh-plugin` 依赖 `ctx.tools`、`ctx.approval`、`ctx.llm`。工作台前端只通过 REST 访问领域服务，**永不直接读写 SQLite**。

分层边界：`domain` / `database` / `retrieval` / `workflow` 不依赖 DSH，只有 `dsh-plugin` 依赖 `ctx.tools`、`ctx.approval`。

---

## 3. 入口文件与接入方式

### 3.1 DSH 插件入口

`src/dsh-plugin/index.ts` 导出：

- `name = 'novelforge'`
- `inject = ['tools', 'approval']`
- `Config`：Schemastery schema，字段名与第 4 节配置项一一对应
- `apply(ctx, config)`：创建领域服务 → `ctx.effect` 注册关闭回调 → 注册全部 `novel_*` 工具

工具通过 `ctx.tools.register(defineTool(...))` 注册，参数使用 DSH `ParameterSchemaSpec`，`execute` 读取 `exec.signal` 支持取消，`output.render` 统一输出 JSON 文本。

`package.json` 中的关键声明：

```json
{
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "engines": { "node": ">=22.18.0", "dsh": ">=0.2.1-rc.3 <0.3.0" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.3",
    "@deepseek-ai/dsh-user-approval": "0.2.1-rc.3"
  }
}
```

### 3.2 安装到 DSH

一键安装（推荐，已发布到 npm）：

```sh
dsh plugin --profile novel add novelforge-dsh
dsh --profile novel --dump-config   # 应出现 novelforge-dsh 层与 novelforge 行
dsh --profile novel web
```

从源码安装：

```sh
pnpm install
pnpm run build
dsh plugin --profile novel add "$PWD"
```

**0.4.2 起真正做到「零原生依赖」**：除了把数据库换成 Node 内置的 `node:sqlite`（0.2.1 已做），0.4.2 还把 drizzle 的同步驱动本地化，去掉了它对 `better-sqlite3` 的运行时 import。此前纯 npm 安装（不装可选 peer）会在启动时直接抛 `Cannot find package 'better-sqlite3'`；DSH 用 pnpm 会自动装 peer，所以一直没暴露。现已用「全新目录 `npm i novelforge-dsh@0.4.2` + 不装 better-sqlite3」实测：CLI 建项目、导出、`novelforge studio` 全部正常。以下为历史记录，仅供排查旧版本（0.1.x）参考。

**下载不到预编译二进制时会退回源码编译（Windows 常见）**：`better-sqlite3` 默认从 GitHub Release 下载预编译产物。若网络到 GitHub 不通，`prebuild-install` 会报 `No prebuilt binaries found` 并退回 `node-gyp rebuild`，在部分环境下还会因 `enable_thin_lto is not defined` 编译失败。解决方式是指定镜像，任选其一：

```sh
# 当前会话
export npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3

# 或写入 ~/.npmrc
better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3
```

使用 DSH 桌面应用安装时，应用会用自己的 pnpm 与运行时（例如 Node 24.21.0），**不会继承终端环境变量**，需要把上面这一对键值设为 Windows 用户级环境变量：

```powershell
[Environment]::SetEnvironmentVariable(
  'npm_config_better_sqlite3_binary_host_mirror',
  'https://registry.npmmirror.com/-/binary/better-sqlite3', 'User')
```

设置后**完全退出并重启 DSH 桌面应用**再安装。

**从 GitHub 仓库安装**：DSH 支持填仓库地址，但本仓库不提交 `dist/`，须由包的 `prepare` 脚本现场构建，因此同样需要在 profile 的 `pnpm-workspace.yaml` 中放行 `allowBuilds: { novelforge-dsh: true, better-sqlite3: true }`。更省事的做法是填本地目录路径或 npm 包名。

随后在会话中要求模型调用 `novel_list_projects` 或 `novel_search` 验证。

### 3.3 可视化工作台 Studio（本地网页，不依赖 DSH 会话）

```sh
pnpm run studio:build        # 构建前端到 apps/studio/dist
pnpm run studio              # 起本地服务并自动打开 http://127.0.0.1:4319

# 自定义端口 / 数据库 / 不自动开浏览器
node dist/cli/index.js studio --port 4400 --db ./data/novelforge.db --no-open
```

页面：项目列表与新建 · 项目总览 · 大纲（卷/章两级可编辑）· 章节列表 · 章节工作台（正文编辑器 + 上下文包预览 + 版本历史 + 审查问题）· 人物与世界观 · 事件时间线 · 伏笔 · 审查报告 · 版本比较与回滚 · 待审批变更 · 工作流 · 项目设置/审计/搜索/导出。

安全与边界：

- 默认只监听 `127.0.0.1`；绑定非本机地址**必须**设置 `NOVELFORGE_STUDIO_TOKEN`，所有 `/api/*` 请求需带 `x-novelforge-token` 头（或 `?token=`）。
- 只放行本机 Origin 的写请求；任何公网页面无法通过浏览器把你的小说库拖走。
- 浏览器不接触 SQLite：所有读写在服务端经领域层完成，并写入 `audit_log`。
- 人工写作：编辑器里写正文，保存即新建一个 `kind=manual` 版本，历史版本不覆盖。
- 人工定稿：某一版没有模型审查记录时，作者可在工作台确认后定稿，审计记为 `chapter.finalize_manual`；DSH 工具路径**永远**要求先审查。

前端单独调试（热更新，`/api` 自动代理到 4319）：

```sh
pnpm run studio            # 终端 A：后端 + 已构建页面
pnpm run studio:dev        # 终端 B：Vite dev server（127.0.0.1:5273）
```

### 3.4 DSH 内嵌面板（Web GUI 侧边栏「小说」）

插件同时是一个 **DSH Web 客户端插件**：`package.json` 里声明 `dsh.client`（`platform: "web"`），
`exports["./client"]` 指向 `lib/client.js`（由 `scripts/build-client.mjs` 用 esbuild 生成，
只把 `react` / `react/jsx-runtime` 留给宿主基座）。加载后：

1. 宿主侧插件把 REST 路由注册到 DSH 自己的 `webServer`（`ctx.webServer.register`，前缀 `/novelforge-api`），
   与 DSH 工具共用同一个 `NovelStore` 连接。面板直接请求同源地址，**不需要第二个进程、不扫端口、不开浏览器**；
   完整工作台前端也挂在同源 `/novelforge/` 下。只有宿主没有 `webServer`（旧版 DSH）时才回退到独立服务；
2. 客户端面板注册进 `main`（keyed slot）与 `sidebar.panellist`，点侧边栏 **「小说」** 打开，
   也可以访问 `http://127.0.0.1:<DSH 端口>/#novelforge` 直接跳转。

面板能做什么（0.6.0 起可写，0.9.0 起同源）：

> 面板顶部会显示 `模型：DSH 宿主` / `模型：直连 Key` / `模型：未配置`；
> 用 DSH 宿主模型时不需要任何 API Key，AI 按钮直接调 `ctx.llm`。

| 标签 | 能做的事 |
| --- | --- |
| 顶栏 | 项目切换、**新建项目 / 项目设置**（书名/题材/POV/时态/字数区间/目标章数/主题/前提/文风）、全局搜索、导出、刷新 |
| 章节 | 新建章节、**AI 规划后续章节**、读全文、**编辑正文并保存为新版本**、**编辑章纲**、**定稿**（带确认）；右侧栏场景可增改删 |
| 资料 | 展示定位/目标/缺陷/秘密；**新建与编辑**深度字段；**详情面板**看按章状态快照与相关知情/关系 |
| 剧情线 | 主线/支线列表；**新建 / 编辑 / 删除**名称、类型、目标、简介、状态 |
| 关系 | 人物—类型→人物 + 张力；**新建 / 删除** |
| 时间线 | 事件列表 + **新建 / 编辑**，`planned` 与 `confirmed` 分色 |
| 伏笔 | **新建 / 编辑**（含最晚回收章）；已过截止章仍未回收的标红 |
| 认知 | **知情矩阵**：一条事实 + 真相/假消息 + 公开度 + 每个人物「知道/怀疑/误信/不知道」 |
| 导入 | 贴素材 → 选「只生成提议 / 同时应用」→ 看抽取统计、丢弃原因、内部矛盾 → 一键应用整批 |
| 审批 | 待审批变更逐条「应用 / 驳回」，`payload` 直接可见 |

服务发现做了退避重试（约 20 秒）+「重新连接」按钮，避免宿主启动慢于页面加载造成误报。
写入一律走本地服务并进审计日志；定稿、应用批次、删除场景都有二次确认。

关闭它：`studioAutoStart: false`（或环境变量 `NOVELFORGE_STUDIO_AUTOSTART=false`）。

### 3.5 独立 CLI（不依赖 DSH，便于调试）

```sh
pnpm install
cp .env.example .env        # 填入 DEEPSEEK_API_KEY
pnpm run novel -- doctor
```

---

## 4. 配置项

既有 DSH 插件配置（`cordis.patch.yml`），也支持环境变量（`.env`）。**配置优先，环境变量作为回退**；API Key 支持从 `DEEPSEEK_API_KEY` 读取。

| 配置字段 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `provider` | `DEEPSEEK_PROVIDER` | 空 | DSH 提供方路由；**留空=自动**（宿主默认模型 > 第一个已注册提供方） |
| `model` | `DEEPSEEK_MODEL` | 空 | **留空=跟随 DSH 宿主默认模型**；填值则覆盖宿主选择；直连模式回退 `deepseek-chat` |
| `apiKey` | `DEEPSEEK_API_KEY` | 空 | **仅直连回退需要**；留空时从 `apiKeyEnv` 指定变量读取 |
| `apiKeyEnv` | — | `DEEPSEEK_API_KEY` | API Key 环境变量名 |
| `baseURL` | `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 直连回退用的 OpenAI 兼容端点 |
| `temperature` | `DEEPSEEK_TEMPERATURE` | `0.8` | 0–2；写作用 0.8，审查自动降为 `min(0.3, temperature)` |
| `maxTokens` | `DEEPSEEK_MAX_TOKENS` | `4096` | 单次补全上限，≥256 |
| `timeoutMs` | `DEEPSEEK_TIMEOUT_MS` | `60000` | 单次请求超时（含整体兜底超时） |
| `maxRetries` | `DEEPSEEK_MAX_RETRIES` | `3` | 0–10，仅对可重试错误生效 |
| `retryBaseDelayMs` | — | `800` | 指数退避基数，遵循 `Retry-After` |
| `databasePath` | `NOVELFORGE_DB_PATH` | `./data/novelforge.db` | SQLite 路径 |
| `studioAutoStart` | `NOVELFORGE_STUDIO_AUTOSTART` | `false` | 是否额外起独立工作台服务；面板默认走 DSH 同源路由，不需要它 |
| `studioPort` | `NOVELFORGE_STUDIO_PORT` | `4319` | 独立服务端口（仅 `studioAutoStart` 或 CLI 时生效） |
| `maxInputTokens` | `NOVELFORGE_MAX_INPUT_TOKENS` | `24000` | 单次请求输入预算 |
| `maxContextTokens` | `NOVELFORGE_MAX_CONTEXT_TOKENS` | `64000` | 上下文包硬上限，必须大于 `maxTokens` |
| `recentChapters` | `NOVELFORGE_RECENT_CHAPTERS` | `3` | 上下文携带的近期章节数 |
| `maxRevisionRounds` | `NOVELFORGE_MAX_REVISION_ROUNDS` | `3` | 自动修订轮次上限 |

配置校验失败会抛出 `CONFIG_ERROR` 并给出具体字段，例如 `temperature 必须在 0 到 2 之间。`

### 4.1 模型调用方式：优先用 DSH 自己的模型

**默认路径走 DSH 宿主模型服务**（`ctx.llm`），不自带 Key、不自己管模型清单：

- 插件通过 `ctx.get('llm')` 惰性取模型服务（未按 `inject` 声明，因此缺少该服务也不会导致插件加载失败）。
- 调用 `ctx.llm.stream({ provider, model, messages, system, temperature, maxTokens, signal })`，逐片拼接 `text-delta`，以 `usage` / `finish` 收尾。
- 路由优先级：**插件配置 `provider`/`model` > DSH 宿主默认模型（`ctx.agentDefaultModel.currentSelection()`）> 第一个已注册提供方（`ctx.llm.listProviders()`）**。
- 分片失败按官方稳定 code 分诊，不解析消息文本：
  - 可重试（指数退避）：`RATE_LIMIT`、`TIMEOUT`、`NETWORK*`、`SERVER_ERROR` 等瞬时故障；
  - 不可重试，直接报错：`NO_ADAPTER`、`MISSING_CREDENTIAL`、`INVALID_CREDENTIAL`、`AUTH`、`QUOTA`、`ACCOUNT_QUOTA`、`CONTEXT_WINDOW_EXCEEDED`；
  - `finish.kind === 'max-tokens'` → 提示调大 `maxTokens`。
- 官方模型服务自身不重试，因此重试由本插件承担，上限 `maxRetries`。

**回退路径（直连 DeepSeek HTTP）**只在两种情况下启用：

1. 运行环境没有 `ctx.llm`（典型是独立 CLI）；
2. 宿主没有可用提供方/模型（`NO_ADAPTER` / `NO_MODEL`），但配置了 API Key。

直连细节：`POST {baseURL}/chat/completions`，请求头 `Authorization: Bearer <API Key>`；请求体含 `model`、`messages`、`temperature`、`max_tokens`、`stream: false`；响应读取 `choices[0].message.content`；请求携带 `AbortSignal`，可即时取消。

只读工具（检索、列举、导出、比较）**不需要任何模型凭据**；只有生成类工具需要。

---

## 5. 核心能力与工具清单

| 工具 | 作用 | 是否调用模型 |
| --- | --- | --- |
| `novel_list_projects` / `novel_create_project` | 项目列举与创建 | 否 |
| `novel_generate_setting` | 按创作意图生成题材、前提、人物、世界规则 | 是 |
| `novel_plan_outline` | 规划后续章节，落库卷纲、章纲与章节记录 | 是 |
| `novel_search` | 检索人物、设定、事件、伏笔、正文（含来源与正式状态） | 否 |
| `novel_get_context` | 组装带 token 预算、来源和事实状态标注的上下文包 | 否 |
| `novel_get_entity` / `novel_get_timeline` / `novel_get_foreshadowing` | 读取实体、时间线、伏笔 | 否 |
| `novel_propose_change` | 提议新增或修改设定（**只生成待审批提议**） | 否 |
| `novel_apply_change` | 用户一次性批准后应用变更，执行乐观版本检查 | 否 |
| `novel_plan_chapter` | 生成结构化章节执行计划 | 是 |
| `novel_write_draft` | 上下文 + 计划 + 正文初稿，只写草稿版本 | 是 |
| `novel_continue_chapter` | 从指定版本续写，追加为新版本 | 是 |
| `novel_rewrite_chapter` | 按要求完整改写，追加为新版本 | 是 |
| `novel_review_chapter` | 六维审查 + 确定性规则检查，保存带证据的问题 | 是 |
| `novel_revise_chapter` | 针对选定问题修订并自动复检，受轮次上限约束 | 是 |
| `novel_list_revisions` / `novel_compare_revisions` / `novel_rollback_chapter` | 版本历史、逐行差异、回滚为新草稿 | 否 |
| `novel_ingest_material` | 素材抽成结构化资料（人物/关系/事件/伏笔/剧情线），默认生成待审批提议 | 是 |
| `novel_list_ingest_batches` / `novel_apply_ingest_batch` | 查看导入批次、批准后批量应用 | 否 |
| `novel_finalize_chapter` | 人工批准后定稿，并在同一事务中应用指定变更 | 否 |
| `novel_list_workflows` / `novel_export_markdown` | 任务状态、导出已定稿 Markdown | 否 |

### 5.0 新增（0.5.0）：小说资料库 + 素材导入

研究结论见 [`docs/story-bible.md`](docs/story-bible.md)：要写好百万字长篇，资料库不能只有「名字 + 简介」。
0.5.0 按该模型扩了数据层与工具链：

**资料库扩了什么**

| 维度 | 新增内容 |
| --- | --- |
| 人物 | `role`（主角/反派/配角…）、`goal`、`motivation`、`flaw`、`secret`、`voice`、`arc`、`aliases`、`firstAppearanceChapterId`、`importance` |
| 关系 | 新表 `relations`：源→目标 + 类型 + 张力 + 起始章 + 状态（原来人物之间没有边） |
| 剧情线 | 新表 `plot_threads`：主线/支线/感情/悬疑/复仇/成长 + 目标 + 进度 + 当前章 |
| 场景/节拍 | 新表 `scenes`：每章拆成场景，记录目标-冲突-结果-出场角色-POV（写顺一章的关键） |
| 人物状态 | 新表 `character_states`：按章快照，避免「重伤秒好」 |
| 事件/伏笔 | 事件加参与者/地点/重要度；伏笔加类型/重要度/备注 |
| 作品契约 | `pov`、`tense`、`chapterWordsMin/Max`、`targetChapters`、`themes` |
| 素材批次 | 新表 `ingest_batches`：原文、状态、抽取统计、丢弃原因、内部矛盾 |

**素材 → 资料库（AI 自动更新）**

```
novel_ingest_material(project_id, material, title?, focus?, mode="propose")
novel_list_ingest_batches(project_id, batch_id?)
novel_apply_ingest_batch(batch_id)          # 需一次性用户审批
```

CLI：

```sh
pnpm run novel -- ingest --project <项目ID> --file notes.md --title "初始设定"
pnpm run novel -- ingest --project <项目ID> --file notes.md --apply   # 直接应用
```

**防瞎编四道闸**（这是它敢自动写库的前提）：

1. **quote-or-drop**：每条抽取必须带 `evidence`，服务端校验它确实是素材的子串（去空白后逐字匹配），编造的一律丢弃并计入 `droppedReasons`。
2. **默认 proposal**：抽取结果只进 `change_proposals`（`source='ai_ingest'`、带 `batch_id`），正式资料不动；应用必须显式批准。
3. **关系延迟解析**：人物与关系同批导入也能落库——关系先按名字提议，应用时再解析 ID，且实体提议永远先于关系应用。
4. **矛盾上报**：素材内部/与已有资料冲突的地方进 `stats.conflictList`，不静默覆盖。

**写作上下文同步接入**：`novel_get_context` 现在会拼人物深度档案、人物与势力关系、剧情线、本章场景与节拍、**知情矩阵**；不再是「只有简介」。

**0.10.0：从「能写」到「管得住」**

| 能力 | 说明 |
| --- | --- |
| 状态快照接入审查 | 快照里未愈的伤（`injuries[].healChapter` 晚于本章）+ 正文出现动作 → major；等级回退且没注明降级 → minor |
| 伏笔到期进上下文 | 逾期标【逾期】、3 章内标【即将到期】，并给一句回收压力提醒；面板控制台条与伏笔页同步标红/标黄 |
| 事件影响分析 | `GET /api/events/:id/impact`：改一个事件时列出受影响的后续章节（含命中词）、相关伏笔、剧情线、知情事实 |
| 创作控制台 | `GET /api/projects/:id/control-center`：进度、逾期/即将到期伏笔、停滞剧情线、待决策章节、未审章节、待审批、最近审计、工作流状态 |
| 面板 | 章节按卷折叠分组、大纲树视图、关系图谱（SVG 力导向，点节点看详情）、顶部控制台条 |
| Studio | 新增「知情矩阵」页、「关系图谱」页；总览加控制台；章节按卷分组；时间线加「影响分析」；伏笔加截止章与逾期高亮 |

**0.8.0：知情矩阵开始「干活」**

1. **审查器确定性检查**：正文里某角色提到自己「不知道」的事 → 直接产出 `major` 问题（带知情事实 ID 作证据）。
   做法是以人物名出现位置为锚，前后 160 字窗口内命中事实的 3 字片段 ≥2 个才报，减少误报。
2. **素材导入也抽知情事实**：素材里出现「只有某人知道 / 瞒着 / 误会」这类描述时，会生成 `knowledge` 提议；
   知情者名字必须能对上资料库或本批新建的人物，否则丢弃（`knowledge_unknown_knower`）。
3. **关系编辑**：类型与张力可直接改（两端不变；要换人删掉重建）。
4. **面板内 AI 批量规划**：章节页「AI 规划后续章节」，填章数后一次落库卷纲/章纲/章节记录。

**0.7.0 新增的表与提醒**

| 能力 | 说明 |
| --- | --- |
| 知情矩阵 `knowledge_facts` | 一条事实 + 真相(true/partial/false) + 公开度(secret/circle/organization/public) + 每个人物的状态（知道/怀疑/误信/不知道）。写作时进上下文，防止「角色开天眼」 |
| 人物状态快照 | 面板「资料 → 详情」按章记录等级/伤势/持有物/位置（结构化 JSON），防「重伤秒好」 |
| 伏笔截止章 | `foreshadowing.deadline_chapter_id`；已过截止章仍未回收 → 总览统计标红 + 伏笔列表标红 |
| 删除接口 | 关系、剧情线可删除（写审计） |
| 面板导出 | 顶栏「导出」直接下载已定稿 Markdown |

### 5.1 三条硬约束

1. **计划不等于事实**：事件与实体有 `planned / draft / confirmed / cancelled` 状态，上下文包会显式标注，未发生的内容不会被当作已发生。
2. **正文不可被无记录覆盖**：每次写作、续写、改写、修订、回滚都新建 `chapter_revisions` 行；只有 `finalize` 会移动章节的正式版本指针；回滚也是新建版本。
3. **AI 不能自行改写正式知识库**：模型提出的设定变更进入 `change_proposals` 待审批区；`novel_apply_change` 与 `novel_finalize_chapter` 必须拿到 DSH 用户审批（`ctx.approval.request` 返回 `allowed-once`）或 CLI `--yes`，否则 fail closed，不修改任何正式数据。

---

## 6. 上下文与记忆策略

- 每次写作组装**动态上下文包**：章节目标、涉及人物及其最新状态、相关世界规则与硬约束、近期章节摘要、相关事件、未回收伏笔、文风规范。
- token 估算：中日韩字符按约 0.6 token、其余按 1/4 词长估算；预算取 `min(maxInputTokens, maxContextTokens - maxTokens)`。
- 超出预算时按**优先级顺序裁剪**并记录 `omittedSections`，返回值始终带 `estimatedTokens / budgetTokens / truncated / sources`，可追溯被裁掉的段落。
- 长篇记忆：人物状态、事件时间线、伏笔生命周期、章节摘要全部落在 SQLite，不在聊天记录里。

---

## 7. 健壮性

| 场景 | 处理 |
| --- | --- |
| HTTP 429 / 5xx / 408 / 409 | 指数退避重试，优先遵循 `Retry-After` 头 |
| 网络错误、超时 | 重试；整体有兜底超时并抛出可重试错误 |
| 401 / 403 / 400 等 | **不重试**，直接给出 API 原始错误信息 |
| 返回非 JSON、缺 `choices[0].message.content`、正文为空 | 抛出带响应片段的错误，可重试 |
| 结构化输出不合法 | 先剥代码围栏再解析；失败则携带校验错误**重试一次**，仍失败才报错 |
| 审批不可用 / 用户拒绝 / 调用取消 | 拒绝写入正式数据，抛出 `APPROVAL_REQUIRED` |
| 乐观锁冲突 | 抛出 `CONFLICT`，提示期望版本与实际版本 |
| 工作流中断 | 每次任务落 `workflow_runs` 检查点，支持恢复与查看错误 |

所有错误统一为 `NovelForgeError`，带错误码：`CONFIG_ERROR / NOT_FOUND / INVALID_INPUT / CONFLICT / APPROVAL_REQUIRED / WORKFLOW_ERROR / LLM_ERROR`。

---

## 8. CLI 使用示例

```sh
export DEEPSEEK_API_KEY=sk-xxx

pnpm run novel -- doctor                                   # 环境检查，不发请求
pnpm run novel -- create --title "雾港" --genre "悬疑"     # 创建项目
pnpm run novel -- generate --idea "近未来侦探 + 家族秘密"   # AI 生成设定建项目
pnpm run novel -- plan --project <项目ID> --count 12       # AI 规划章节
pnpm run novel -- chapters --project <项目ID>
pnpm run novel -- context --chapter <章节ID>               # 查看真实上下文预算
pnpm run novel -- write --project <项目ID> --chapter 1     # 生成草稿
pnpm run novel -- review --revision <版本ID>
pnpm run novel -- revise --revision <版本ID> --issues <问题ID,问题ID>
pnpm run novel -- compare --left <版本ID> --right <版本ID>
pnpm run novel -- finalize --revision <版本ID> --yes       # 人工确认后定稿
pnpm run novel -- export --project <项目ID> --output out.md
```

`finalize` 不带 `--yes` 会被拒绝，章节保持草稿状态。

---

## 9. 命令与测试

```sh
pnpm install
pnpm run typecheck   # 后端 tsc --noEmit + 工作台 tsc --noEmit
pnpm run test        # vitest run（含真实 HTTP 服务测试）
pnpm run build       # 后端输出到 dist/
pnpm run build:all   # 后端 + 客户端面板 bundle + 工作台前端（发布前用）
pnpm run build:client # 只重建 DSH 内嵌面板 lib/client.js
pnpm run studio      # 启动工作台（需要先 studio:build）
```

测试覆盖（9 个文件 / 59 项，全部真实调用、无 mock 业务逻辑）：重启后数据恢复；上下文预算与截断；短中文检索回退；正文版本只追加不覆盖；未批准不落正式数据；乐观版本冲突；违禁设定检测并阻断定稿；续写/改写/修订轮次上限；429 退避重试、401 不重试、结构异常修正重试；工具注册与审批失败 fail closed。

工作台新增覆盖（`tests/server.test.ts` + `tests/studio-store.test.ts`）：真实起 HTTP 服务测 48 个接口（含令牌三种传法、同源 CORS 与跨站 403、畸形编码 400、路径穿越回退、SPA 回退、`port:0`/端口回退下的同源写、AI 接口在无 Key 时一律 400 且零外网请求）；store 新增能力（人工编辑的乐观锁与审计、`kind=manual` 追加式版本、`allowUnreviewed` 人工定稿与 `chapter.finalize_manual` 审计、提议状态机、overview/detail/review-runs/audit 聚合、`counts.revisions` 不受预览窗口截断）。接口契约见 [`docs/studio-api.md`](docs/studio-api.md)。

---

## 10. 方案中未定义、按默认实现的细节

1. **DSH 宿主版本**：官方要求 Node.js ≥24.9.0，本机 22.22.2，故 CLI 与测试独立验证，DSH 内验收列为环境前置条件。
2. **可视化工作台（两条路线都已落地）**：① **DSH 内嵌面板** —— 客户端插件经 `dsh.client` + `window.__ModuleLoader__` 加载，注册进 `main` 与 `sidebar.panellist` 插槽（契约逐项核验见 `docs/dsh-compatibility.md`），只读；② **完整本地工作台** —— `apps/studio` + `src/server`，12 个页面、可写、带二次确认与审计。两者共用同一份数据与服务端领域层，浏览器都不直接接触 SQLite。
3. **多包结构**：方案建议 `packages/domain|database|retrieval|workflow|llm|dsh-plugin` 多包。为降低工程开销并保持既有构建链路稳定，本版为「根包 + `apps/studio`」的 pnpm workspace：逻辑边界仍按目录保留，`apps/studio` 是独立包。
4. **检索方案**：先用 SQLite FTS5（trigram）并保留 LIKE 子串回退，未引入向量数据库；中文短词（2–3 字）依赖回退保证可召回。
5. **事实来源字段**：在 `entities`、`events` 等记录上使用 `sourceChapterId` / `sourceRevisionId`，未额外建立独立来源表。
6. **自动修订轮次**：默认 3 轮，可配置；超出上限会暂停并把章节置为 `needs_author_decision`。
7. **prompts 目录**：提示词模板集中在 `src/workflow/prompts.ts`，不再单独维护 `prompts/` 目录，避免与代码模板产生两份事实来源。
