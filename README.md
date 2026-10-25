# NovelForge DSH

面向长篇网文创作的 DeepSeek Harness（DSH）插件：拥有**持久化知识库、动态上下文、多维度审查、不可覆盖的正文版本和人工确认定稿**，而不是一个只会续写文字的聊天机器人。

插件名：`novelforge`；npm 包名：`novelforge-dsh`；版本：`0.1.0`。
GitHub：<https://github.com/Cyrus0322/novelforge-dsh> ｜ npm：<https://www.npmjs.com/package/novelforge-dsh>

---

## 1. 运行环境

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | 独立 CLI：`>=22.18.0` | 本机实测 `v22.22.2` 可运行 CLI、构建与全部测试 |
| Node.js | DSH 宿主：`>=24.9.0` | 官方根包 `package.json` 的 `engines` 要求；**本机已升级至 v24.22.1 并实测通过** |
| pnpm | `11.7.0` | 本机实测；仓库源码自身要求 `11.28.5` |
| TypeScript | `5.9` | `tsc` 构建到 `dist/` |
| 数据库 | SQLite（`better-sqlite3`） | 单文件，无需外部服务 |
| DSH | `>=0.2.1-rc.3 <0.3.0` | 在 `package.json` 的 `engines.dsh` 中声明 |

> 已在真实 DSH `0.2.1-rc.3` 宿主中完成：`dsh plugin add` 安装、`--dump-config` 出现 `novelforge-dsh` 层、headless 启动无插件加载错误。唯一未做的是「模型在会话内真实调用 `novel_*` 工具」——本机无可用 DeepSeek API Key，需用你自己的 Key 验收。详见 `docs/dsh-compatibility.md`。

---

## 2. 目录结构

```
novelforge-dsh/
├── package.json              # 插件清单；dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml          # 插件插入点、启用开关与默认配置
├── tsconfig.json             # strict + NodeNext，构建到 dist/
├── vitest.config.ts
├── .env.example              # DeepSeek 与 NovelForge 环境变量示例
├── locale/{zh,en}.json       # 插件描述本地化
├── src/
│   ├── dsh-plugin/index.ts   # 【入口】Cordis 插件：name / inject / Config / apply
│   ├── cli/index.ts          # 【入口】本地命令行
│   ├── domain/schemas.ts     # 蓝图、大纲、章节计划、审查结果的 Zod Schema
│   ├── database/             # SQLite 建表、迁移、Repository（事务、审计、全文索引）
│   ├── retrieval/context.ts  # 动态上下文包与 token 预算裁剪
│   ├── workflow/             # novel-service.ts（编排）+ prompts.ts（提示词模板）
│   ├── llm/                  # DeepSeek 客户端、重试、结构化输出解析
│   └── shared/               # 配置、错误码、ID、JSON 工具
├── docs/dsh-compatibility.md # 官方接口逐项核验记录
├── tests/                    # 单元与集成测试（16 项）
└── data/                     # SQLite 数据库默认位置（已在 .gitignore 中）
```

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

**pnpm 用户注意原生依赖**：本包依赖 `better-sqlite3`。pnpm 10+ 默认拦截依赖构建脚本，首次安装可能报 `ERR_PNPM_IGNORED_BUILDS`，且 bundle 不会被注册。处理方式：把 `~/.dsh/profiles/<name>/pnpm-workspace.yaml` 里的占位值改成 `allowBuilds: { better-sqlite3: true }`，再重新执行 `dsh plugin --profile <name> add novelforge-dsh`。若出现 `atomic-write: timed out waiting for the writer lock`，删除该目录下的 `package.json.lock` 后重试。npm 用户不受此影响。

随后在会话中要求模型调用 `novel_list_projects` 或 `novel_search` 验证。

### 3.3 独立 CLI（不依赖 DSH，便于调试）

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
| `novel_finalize_chapter` | 人工批准后定稿，并在同一事务中应用指定变更 | 否 |
| `novel_list_workflows` / `novel_export_markdown` | 任务状态、导出已定稿 Markdown | 否 |

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
pnpm run typecheck   # tsc --noEmit
pnpm run test        # vitest run，16 项
pnpm run build       # 输出到 dist/
```

测试覆盖：重启后数据恢复；上下文预算与截断；短中文检索回退；正文版本只追加不覆盖；未批准不落正式数据；乐观版本冲突；违禁设定检测并阻断定稿；续写/改写/修订轮次上限；429 退避重试、401 不重试、结构异常修正重试；工具注册与审批失败 fail closed。

---

## 10. 方案中未定义、按默认实现的细节

1. **DSH 宿主版本**：官方要求 Node.js ≥24.9.0，本机 22.22.2，故 CLI 与测试独立验证，DSH 内验收列为环境前置条件。
2. **可视化工作台**：方案中的 React 工作台本次**未实现**。官方客户端 UI 是 Host + Client/Slot 的独立扩展路径，不是普通工具插件的附属能力；在核验 Client Modules、Remote API 与 Slot 之前不做内嵌页面，也不宣称已嵌入。当前入口是 CLI 与 DSH 工具。
3. **单包结构**：为降低工程开销，把方案的 pnpm workspace 多包合并为单包，但保留 `domain / database / retrieval / workflow / llm / dsh-plugin` 目录边界。
4. **检索方案**：先用 SQLite FTS5（trigram）并保留 LIKE 子串回退，未引入向量数据库；中文短词（2–3 字）依赖回退保证可召回。
5. **事实来源字段**：在 `entities`、`events` 等记录上使用 `sourceChapterId` / `sourceRevisionId`，未额外建立独立来源表。
6. **自动修订轮次**：默认 3 轮，可配置；超出上限会暂停并把章节置为 `needs_author_decision`。
7. **prompts 目录**：提示词模板集中在 `src/workflow/prompts.ts`，不再单独维护 `prompts/` 目录，避免与代码模板产生两份事实来源。
