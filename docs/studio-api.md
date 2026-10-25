# NovelForge Studio REST API 契约

> 本文由 `src/server/routes.ts` 的 `buildRoutes()` 逐条整理，并与 `src/server/http.ts` 的行为核对；
> 当前版本共 **48 个 `/api/*` 端点**，与 `buildRoutes()` 注册数量一致（`docs` 与代码如不一致，以代码为准）。
> 端到端行为由 `tests/server.test.ts`（真实启动服务 + fetch）与 `tests/studio-store.test.ts`（store 层）覆盖。
>
> 工作台浏览器端**只消费本文的 JSON 接口，从不直接打开 SQLite 文件**。所有写操作都经过领域层，
> 遵循乐观锁、追加式版本与审计留痕。

## 1. 启动

```bash
# 0) 首次运行 / 更新服务端代码后：构建服务端到 dist/（或直接 pnpm run build:all 一次完成 0+1）
pnpm run build

# 1) 构建工作台前端（产物在 apps/studio/dist，由本地服务托管）
pnpm run studio:build

# 2) 启动本地服务（默认 http://127.0.0.1:4319；需要 dist/ 已构建）
pnpm run studio
```

`pnpm run studio` 等价于 `node dist/cli/index.js studio`。开发前端时可以只跑前端，
让 Vite 把 `/api` 代理到本地服务：

```bash
pnpm run studio            # 终端 1：本地 REST 服务（4319）
pnpm run studio:dev        # 终端 2：Vite 开发服务器（5273，/api 代理到 NOVELFORGE_API ?? http://127.0.0.1:4319）
```

CLI 选项（`novelforge studio`）：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `--port <number>` | `4319` | 监听端口；被占用时会自动向后尝试（最多 12 个连续端口，仍失败则报错退出） |
| `--host <address>` | `127.0.0.1` | 监听地址；绑定非本机地址时**必须**设置访问令牌，否则拒绝启动 |
| `--token <token>` | 环境变量 `NOVELFORGE_STUDIO_TOKEN` | 访问令牌；为空表示不校验 |
| `--no-open` | 自动打开浏览器 | 启动后不自动打开系统浏览器 |

全局选项与相关环境变量：

| 名称 | 说明 |
| --- | --- |
| `--db <path>` / `NOVELFORGE_DB_PATH` | SQLite 数据库路径（默认 `./data/novelforge.db`） |
| `--model <name>` / `DEEPSEEK_MODEL` | 模型名称（AI 端点使用） |
| `DEEPSEEK_API_KEY` | 模型密钥；未配置时所有 AI 端点返回 `400 CONFIG_ERROR`，只读/编辑/导出接口不受影响 |
| `NOVELFORGE_STUDIO_TOKEN` | 工作台访问令牌 |
| `NOVELFORGE_STUDIO_DIR` | 覆盖静态资源目录（默认 `apps/studio/dist`） |
| `NOVELFORGE_API` | 仅 Vite 开发服务器使用：`/api` 代理目标（默认 `http://127.0.0.1:4319`） |

## 2. 令牌机制

- 服务端启动时确定一个令牌：`--token` > `NOVELFORGE_STUDIO_TOKEN` > 空字符串。
- **令牌为空 = 不校验**（默认本机回环监听场景）。
- 令牌非空时，所有 `/api/*` 请求必须提供令牌，两种等价方式：
  - 请求头 `x-novelforge-token: <token>`（推荐；前端在 `sessionStorage` 保存，刷新后仍可用）
  - 查询参数 `?token=<token>`（便于用浏览器直接打开一次，前端会把查询参数里的令牌转存到 `sessionStorage`）
- 缺失或错误 → `401`，`error.code = "UNAUTHORIZED"`。
- 静态资源（工作台 HTML/JS/CSS）**不受令牌限制**；令牌只保护 `/api/*` 数据接口。
- 绑定非本机地址（如 `0.0.0.0`）时如果没有令牌，服务端直接拒绝启动（`CONFIG_ERROR`），避免把本地小说库裸奔到局域网。

## 3. 安全边界

1. **浏览器不接触 SQLite**：页面只通过本文的 REST 接口读写；数据库文件、WAL、迁移和 FTS 索引都留在服务端进程内。
2. **写操作只允许本机页面发起**：当请求带 `Origin` 头时，只有回环来源（`127.0.0.1` / `localhost` / `[::1]`）且端口等于服务端**实际监听端口**（或省略端口、或 Vite 开发端口 `5273`）才放行。
   其他来源的 `POST` / `PATCH` / `DELETE` → `403`，`error.code = "FORBIDDEN"`。`GET` 请求不拦截，但不会返回
   `access-control-allow-origin`，因此浏览器端读不到响应内容。
3. **CORS 只放行本机来源**：只有上述回环来源才会收到 `access-control-allow-origin`、`access-control-allow-headers: content-type, x-novelforge-token`、
   `access-control-allow-methods: GET, POST, PATCH, DELETE, OPTIONS`。`OPTIONS` 预检统一返回 `204`。
4. **路径穿越防护**：静态托管把请求路径解析后限制在 Studio 构建目录内；越界路径回退到 `index.html`，不会读取仓库文件。
5. **AI 端点需要密钥**：未配置 `DEEPSEEK_API_KEY` 时返回 `400 CONFIG_ERROR`，不会发起任何模型请求；资料管理、编辑、审查查看、审计与导出不需要模型。
6. **人工定稿可跳过模型审查，但会留痕**：`POST /api/revisions/:revisionId/finalize` 对没有审查记录的版本默认
   `allowUnreviewed=true`（作者在工作台逐字确认），审计动作为 `chapter.finalize_manual`；经过模型审查的版本审计动作为 `chapter.finalize`。

## 4. 响应信封与错误码

成功（HTTP 200，`content-type: application/json; charset=utf-8`，`cache-control: no-store`）：

```json
{ "ok": true, "data": { } }
```

失败：

```json
{ "ok": false, "error": { "code": "INVALID_INPUT", "message": "参数 title 必须是非空字符串。", "details": null } }
```

`details` 只在部分错误中出现（例如定稿被阻断时给出 `{ "issueIds": [...] }`）。

错误码 → HTTP 状态映射（`src/server/http.ts` 的 `errorStatus()`）：

| `error.code` | HTTP | 含义 |
| --- | --- | --- |
| `NOT_FOUND` | 404 | 资源 ID 不存在（项目/实体/大纲/章节/版本/审查/提议） |
| `INVALID_INPUT` | 400 | 参数缺失、类型错误、空字符串、非法枚举、请求体不是合法 JSON |
| `CONFIG_ERROR` | 400 | 未配置 `DEEPSEEK_API_KEY`（AI 端点）；或按配置拒绝启动 |
| `CONFLICT` | 409 | 乐观锁版本冲突；状态不允许（重复驳回/重复应用/定稿非最新版本） |
| `WORKFLOW_ERROR` | 409 | 工作流约束（未审查定稿、仍有未解决 major/critical 问题、修订轮次超限） |
| `APPROVAL_REQUIRED` | 403 | 领域层要求显式批准（REST 定稿接口固定 `approved=true`，正常不会触发） |
| `LLM_ERROR` | 502 | 模型调用失败或结构化输出不合规（AI 端点） |
| `INTERNAL` | 500 | 未预期异常 |

除此之外还有四类「协议级」失败，不属于上面的领域错误码：

| HTTP | `error.code` | 触发条件 |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | 令牌缺失或错误 |
| 403 | `FORBIDDEN` | 带非本机 `Origin` 的写请求 |
| 404 | `NOT_FOUND` | `/api/*` 下没有匹配的「方法 + 路径」 |
| 405 | `INVALID_INPUT` | 对静态资源发 `POST`/`PATCH`/`DELETE`（静态资源只支持 GET/HEAD） |

## 5. 公共返回结构

下文的 `Project`、`Entity` 等结构均为 `data` 字段的内容，字段名与数据库/领域层保持一致（camelCase）。

```ts
Project       { id, title, genre, premise, styleGuide, status, version, createdAt, updatedAt }
Entity        { id, projectId, kind, name, summary, attributesJson, status,
                sourceChapterId: string|null, sourceRevisionId: string|null,
                version, createdAt, updatedAt }
Outline       { id, projectId, parentId: string|null, level: "volume"|"chapter"|string,
                chapterNo: number|null, title, content, status, version, createdAt, updatedAt }
Chapter       { id, projectId, outlineId: string|null, chapterNo, title, status,
                currentRevisionId: string|null, version, createdAt, updatedAt }
ChapterRevision { id, chapterId, revisionNo, content, kind, status, summary, createdAt }
StoryEvent    { id, projectId, chapterId: string|null, eventTime, summary, status,
                sourceRevisionId: string|null, version, createdAt, updatedAt }
Foreshadowing { id, projectId, name, description, plantChapterId: string|null,
                payoffChapterId: string|null, status, version, createdAt, updatedAt }
ReviewRun     { id, chapterId, revisionId, status, summary, createdAt }
ReviewIssue   { id, reviewRunId, category, severity, locationStart: number|null,
                locationEnd: number|null, issue, evidenceJson, suggestedFix, resolutionStatus }
ChangeProposal { id, projectId, chapterId: string|null, sourceRevisionId: string|null,
                targetType, targetId: string|null, operation, payloadJson,
                expectedVersion: number|null, status, createdAt, appliedAt: string|null }
AuditEntry    { id, projectId, action, entityId, beforeJson: string|null,
                afterJson: string|null, createdAt }
WorkflowRun   { id, projectId, chapterId: string|null, taskType, state,
                checkpointJson, error: string|null, createdAt, updatedAt }
SearchResult  { recordId, recordType, sourceId, status, snippet }
```

`kind`（正文版本来源）取值：`draft` | `continue` | `rewrite` | `revise` | `rollback` | `manual`。
章节 `status` 常见取值：`planned` | `draft_generated` | `manual_draft` | `revising` | `reviewing` |
`awaiting_approval` | `needs_author_decision` | `finalized`。资料 `status` 常见取值：
`planned` | `draft` | `confirmed` | `cancelled`；伏笔另有 `open` | `reinforced` | `paid_off` | `abandoned`。

## 6. 端点详情

### 6.1 健康检查

#### GET /api/health

- 查询参数：无。
- 成功返回：`{ version, hasApiKey, databasePath, studioBuilt }`。
  - `hasApiKey`：当前进程是否可用模型（`config.apiKey` 或 `DEEPSEEK_API_KEY`）。
  - `studioBuilt`：静态目录下是否存在 `index.html`。
- 错误码：无（无需令牌之外的校验）。

### 6.2 项目

#### GET /api/projects

- 查询参数：无。
- 成功返回：`Project[]`，按 `updatedAt` 倒序。
- 错误码：无。

#### POST /api/projects

- 请求体：`{ title: string（必填）, genre: string（必填）, premise?: string, styleGuide?: string }`。
- 成功返回：`Project`（`version` 初始为 1），并写审计 `project.create`。
- 错误码：`400 INVALID_INPUT`（缺字段/空白字符串/请求体非法）。

#### GET /api/projects/:projectId

- 路径参数：`projectId`。
- 成功返回：`ProjectOverview`：
  ```ts
  {
    project: Project,
    counts: { chapters, finalizedChapters, entities, events, foreshadowingOpen,
              pendingProposals, openIssues, revisions },
    currentChapter: Chapter | null,           // 第一个未定稿章节
    openIssues: Array<ReviewIssue & { chapterId, chapterNo, chapterTitle }>, // 不含 minor
    openForeshadowing: Foreshadowing[],       // status 为 open/reinforced
    pendingProposals: ChangeProposal[],
    recentWorkflows: WorkflowRun[],           // 最近 8 条
    recentRevisions: ChapterRevision[],       // 最近 12 条
    lastFinalized: { chapter: Chapter, revision: ChapterRevision } | null
  }
  ```
  `counts.revisions` 是真实版本总数（不受 `recentRevisions` 12 条上限影响）。
- 错误码：`404 NOT_FOUND`。

#### PATCH /api/projects/:projectId

- 路径参数：`projectId`。
- 请求体：`{ title?, genre?, premise?, styleGuide?, status?, expectedVersion?: number }`；字段均可选（不强制至少一个，
  空 patch 也会让 `version + 1` 并记审计）。
- 成功返回：`Project`（`version + 1`），并写审计 `project.update`（含前后快照）。
- 错误码：`400 INVALID_INPUT`、`404 NOT_FOUND`、`409 CONFLICT`（`expectedVersion` 与当前版本不一致）。

#### POST /api/projects/generate

- **AI 端点**（注意：路径在 `/api/projects/` 下，不是 `/api/projects/:projectId/generate`）。
- 请求体：`{ idea: string（必填，创作意图） }`。
- 成功返回：`{ project: Project, blueprint: NovelBlueprint }`，一次事务写入项目 + 人物 + 世界观规则。
- 错误码：`400 CONFIG_ERROR`（无 API Key）、`400 INVALID_INPUT`、`502 LLM_ERROR`（模型失败/结构化输出不合规）。

### 6.3 审计、搜索与导出

#### GET /api/projects/:projectId/audit

- 查询参数：`limit?: number`（默认 60，服务端夹取到 1..500）。
- 成功返回：`AuditEntry[]`，按 `createdAt` 倒序。常见 `action`：`project.create/update`、`entity.create/update`、
  `outline.update`、`chapter.create/plan/update/finalize/finalize_manual`、`revision.*`、`review.create`、`issue.update`、
  `proposal.create/reject`、`*.apply_proposal`。
- 错误码：`400 INVALID_INPUT`（`limit` 非数字）。注意：本接口不校验项目是否存在，未知项目返回空数组。

#### GET /api/projects/:projectId/search

- 查询参数：
  - `q: string`（必填，非空）。
  - `types?: string`（逗号分隔，如 `character,chapter,event`；为空表示全部）。
  - `limit?: number`（默认 20，夹取 1..50）。
- 成功返回：`SearchResult[]`。命中来源包括实体、正文版本、事件、伏笔；`recordType` 为实体 kind / `chapter` / `event` / `foreshadowing`。
- 搜索实现：≥3 字先用 SQLite FTS5（trigram），无结果或不支持时回退子串匹配。
- 错误码：`400 INVALID_INPUT`（`q` 为空或 `limit` 非数字）、`404 NOT_FOUND`。

#### GET /api/projects/:projectId/export.md

- 成功返回：**不是 JSON 信封**，而是 `text/markdown; charset=utf-8` 的 Markdown 文本，只包含已定稿章节。
- 错误码：`404 NOT_FOUND`。

### 6.4 资料（实体）

#### GET /api/projects/:projectId/entities

- 查询参数：`kind?: string`、`status?: string`。
- 成功返回：`Entity[]`，按 `kind`、`name` 升序；`attributesJson` 为字符串化的 JSON。
- 错误码：无（本列表接口不校验项目是否存在，未知项目返回空数组）。

#### POST /api/projects/:projectId/entities

- 请求体：`{ kind: string（必填）, name: string（必填）, summary?: string, attributes?: object, status?: string }`。
  `attributes` 必须是对象（会被 `JSON.stringify`）；`status` 缺省 `confirmed`。
- 成功返回：`Entity`，并写审计 `entity.create`。
- 错误码：`400 INVALID_INPUT`、`404 NOT_FOUND`。

#### GET /api/entities/:entityId

- 成功返回：`Entity`。
- 错误码：`404 NOT_FOUND`。

#### PATCH /api/entities/:entityId

- 请求体：`{ name?, kind?, summary?, attributes?, status?, expectedVersion?: number }`。
- 成功返回：`Entity`（`version + 1`），并写审计 `entity.update`；FTS 索引同步更新。
- 错误码：`400 INVALID_INPUT`、`404 NOT_FOUND`、`409 CONFLICT`。

### 6.5 大纲

#### GET /api/projects/:projectId/outlines

- 成功返回：`Outline[]`，按 `chapterNo`、`createdAt` 升序；`level` 区分 `volume` / `chapter`。
- 错误码：无（本列表接口不校验项目是否存在，未知项目返回空数组）。

#### PATCH /api/outlines/:outlineId

- 请求体：`{ title?, content?, status?, expectedVersion?: number }`。
- 成功返回：`Outline`（`version + 1`），并写审计 `outline.update`。
- 错误码：`400 INVALID_INPUT`、`404 NOT_FOUND`、`409 CONFLICT`。

#### POST /api/projects/:projectId/outlines/plan

- **AI 端点**。
- 请求体：`{ chapterCount: number（必填，1..100） }`。
- 成功返回：`OutlinePlan & { chapterIds: string[] }`，即 `{ volumes: [...], chapterIds }`；一次性写入卷/章纲/章节。
- 错误码：`400 CONFIG_ERROR`、`400 INVALID_INPUT`、`404 NOT_FOUND`、`502 LLM_ERROR`（例如模型返回章节数与要求不一致，不写库）。

### 6.6 章节

#### GET /api/projects/:projectId/chapters

- 成功返回：`Chapter[]`，按 `chapterNo` 升序。
- 错误码：无（本列表接口不校验项目是否存在，未知项目返回空数组）。

#### GET /api/projects/:projectId/chapter-summaries

- 成功返回：`ChapterSummary[]`：
  ```ts
  { chapter: Chapter, revisionCount: number,
    latest: { id, revisionNo, status, kind, words, createdAt } | null }
  ```
  `latest.words` 是 `content` 的字符长度（SQLite `length()`）；返回体不含正文。
- 错误码：无（本列表接口不校验项目是否存在，未知项目返回空数组）。

#### POST /api/projects/:projectId/chapters

- 请求体：`{ title: string（必填）, chapterNo?: number }`；省略 `chapterNo` 时取当前最大章节号 + 1，冲突时自动顺延。
- 成功返回：`{ chapter: Chapter, outline: Outline }`（同时创建章级大纲），并写审计 `chapter.create`。
- 错误码：`400 INVALID_INPUT`、`404 NOT_FOUND`。

#### GET /api/chapters/:chapterId

- 成功返回：`ChapterDetail`：
  ```ts
  { chapter: Chapter,
    outline: Outline | null,
    revisions: ChapterRevision[],              // 全部版本，按 revisionNo 倒序
    latestRevision: ChapterRevision | null,
    latestReview: { run: ReviewRun, issues: ReviewIssue[] } | null }
  ```
- 错误码：`404 NOT_FOUND`。

#### PATCH /api/chapters/:chapterId

- 请求体：`{ title?, status?, expectedVersion?: number }`。
- 成功返回：`Chapter`（`version + 1`；改名时同步更新关联章纲标题并写审计 `chapter.update`）。
- 错误码：`400 INVALID_INPUT`、`404 NOT_FOUND`、`409 CONFLICT`。

#### GET /api/chapters/:chapterId/context

- 成功返回：`ContextPack`：
  ```ts
  { projectId, chapterId, text, estimatedTokens, budgetTokens, truncated,
    omittedSections: string[], sources: Array<{ id, type, status }> }
  ```
  这是「若调用模型会看到什么」的动态上下文（受 token 预算裁剪），不调用模型、不写入数据。
- 错误码：`404 NOT_FOUND`。

#### GET /api/chapters/:chapterId/revisions

- 查询参数：`full?: "1"`（只有字面量 `1` 表示返回完整正文）。
- 成功返回：`ChapterRevision[]`（按 `revisionNo` 倒序）。
  - 不带 `full=1` 时每条**移除 `content`**，改为 `contentLength: number`；
  - `full=1` 时保留完整 `content`。
- 错误码：无（本列表接口不校验章节是否存在，未知章节返回空数组）。

#### POST /api/chapters/:chapterId/revisions

- 请求体：`{ content: string（必填，非空） }`。
- 成功返回：`ChapterRevision`（`kind = "manual"`，`revisionNo + 1`），章节状态变为 `manual_draft`，同时写审计 `revision.manual`。
  正文版本**只追加不覆盖**，旧版本永远保留。
- 错误码：`400 INVALID_INPUT`、`404 NOT_FOUND`。

#### POST /api/chapters/:chapterId/plan

- **AI 端点**。
- 请求体：无（可省略请求体）。
- 成功返回：`{ plan: ChapterPlan, context: ContextMeta }`；`ContextMeta` 包含
  `estimatedTokens/budgetTokens/truncated/omittedSections/sources/text/preview`。
- 错误码：`400 CONFIG_ERROR`、`404 NOT_FOUND`、`502 LLM_ERROR`。

#### POST /api/chapters/:chapterId/draft

- **AI 端点**。
- 请求体：无（可省略请求体）。
- 成功返回：`{ revision: ChapterRevision, plan: ChapterPlan, context: ContextMeta }`，新版本 `kind = "draft"`。
- 错误码：`400 CONFIG_ERROR`、`404 NOT_FOUND`、`502 LLM_ERROR`。

### 6.7 正文版本与定稿

#### GET /api/revisions/:revisionId

- 成功返回：`ChapterRevision`（含完整 `content`）。
- 错误码：`404 NOT_FOUND`。

#### GET /api/compare

- 查询参数：`left`、`right`（两个版本 ID，必填）。
- 成功返回：
  ```ts
  { leftId, rightId, changes: Array<{ value, added?: boolean, removed?: boolean, count?: number }> }
  ```
  由 `diff` 的 `diffLines` 生成。
- 错误码：`404 NOT_FOUND`（任一版本不存在）；`400 INVALID_INPUT`（两个版本不属于同一章节）。

#### POST /api/revisions/:revisionId/review

- **AI 端点**。请求体：无（可省略）。
- 成功返回：`{ run: ReviewRun, issues: ReviewIssue[], result: ReviewResult }`；审查结果落库，章节状态变为
  `awaiting_approval`（无 major/critical）或 `needs_author_decision`（有问题）。
- 错误码：`400 CONFIG_ERROR`、`404 NOT_FOUND`、`502 LLM_ERROR`。

#### POST /api/revisions/:revisionId/revise

- **AI 端点**。
- 请求体：`{ issueIds: string[]（必填，非空）, instruction?: string }`。
- 成功返回：`{ revision: ChapterRevision, review: { run, issues, result } }`；选中的问题会被标记解决，新版本自动复审。
- 错误码：`400 CONFIG_ERROR`、`400 INVALID_INPUT`（`issueIds` 为空或不匹配当前审查）、`404 NOT_FOUND`、
  `409 WORKFLOW_ERROR`（未审查/超过 `maxRevisionRounds`）、`502 LLM_ERROR`。

#### POST /api/revisions/:revisionId/continue

- **AI 端点**。
- 请求体：`{ instruction?: string }`。
- 成功返回：`ChapterRevision`（`kind = "continue"`，在原正文后追加）。
- 错误码：`400 CONFIG_ERROR`、`404 NOT_FOUND`、`502 LLM_ERROR`。

#### POST /api/revisions/:revisionId/rewrite

- **AI 端点**。
- 请求体：`{ instruction: string（必填，改写要求） }`。
- 成功返回：`ChapterRevision`（`kind = "rewrite"`）。
- 错误码：`400 CONFIG_ERROR`、`400 INVALID_INPUT`、`404 NOT_FOUND`、`502 LLM_ERROR`。

#### POST /api/revisions/:revisionId/rollback

- 请求体：无。
- 成功返回：`ChapterRevision`（`kind = "rollback"`，以该历史版本内容创建一个**新的**草稿，历史不删除不重写）。
- 错误码：`404 NOT_FOUND`。

#### POST /api/revisions/:revisionId/finalize

- 请求体：`{ allowUnreviewed?: boolean, approvedChangeIds?: string[] }`（均可省略；空请求体等价 `{}`）。
  - 只能定稿**最新版本**，否则 `409 CONFLICT`；
  - 若该版本已有审查记录：仍有未解决的 `major`/`critical` 问题时 `409 WORKFLOW_ERROR`（`details.issueIds` 给出阻断问题）；
  - 若该版本尚无审查记录：`allowUnreviewed` 缺省为 `true`（作者在工作台逐字确认），显式传 `false` 时
    `409 WORKFLOW_ERROR`；
  - `approvedChangeIds` 会随定稿一并应用（必须属于同一项目，否则 `400 INVALID_INPUT`）。
- 成功返回：`Chapter`（`status = "finalized"`、`currentRevisionId` 指向该版本）。
  审计：无审查记录的人工定稿写 `chapter.finalize_manual`，经过审查的定稿写 `chapter.finalize`。
- 错误码：`400 INVALID_INPUT`、`404 NOT_FOUND`、`409 CONFLICT`（非最新版本）、`409 WORKFLOW_ERROR`。

### 6.8 事件与伏笔

#### GET /api/projects/:projectId/events

- 成功返回：`StoryEvent[]`，按 `eventTime`、`createdAt` 升序。
- 错误码：无（本列表接口不校验项目是否存在，未知项目返回空数组）。

#### POST /api/projects/:projectId/events

- 作者手动新增事件（不经过模型，也不需要 API Key）。
- 请求体：`{ summary: string（必填）, eventTime?: string, status?: string, chapterId?: string }`；
  `status` 缺省 `confirmed`，`chapterId` 缺省不关联章节。
- 成功返回：`StoryEvent`（`version = 1`），并写审计 `event.create`、更新 FTS 索引。
- 错误码：`400 INVALID_INPUT`、`404 NOT_FOUND`。

#### PATCH /api/events/:eventId

- 请求体：`{ summary?, eventTime?, status?, chapterId?: string|null, expectedVersion?: number }`；
  `chapterId = null` 表示解除章节关联。
- 成功返回：`StoryEvent`（`version + 1`），并写审计 `event.update`；FTS 索引同步更新。
- 错误码：`400 INVALID_INPUT`、`404 NOT_FOUND`、`409 CONFLICT`。

#### GET /api/projects/:projectId/foreshadowing

- 成功返回：`Foreshadowing[]`，按 `status`、`createdAt` 升序。
- 错误码：无（本列表接口不校验项目是否存在，未知项目返回空数组）。

#### POST /api/projects/:projectId/foreshadowing

- 作者手动新增伏笔（不经过模型，也不需要 API Key）。
- 请求体：`{ name: string（必填）, description?: string, status?: string, plantChapterId?: string, payoffChapterId?: string }`；
  `status` 缺省 `open`。
- 成功返回：`Foreshadowing`（`version = 1`），并写审计 `foreshadowing.create`、更新 FTS 索引。
- 错误码：`400 INVALID_INPUT`、`404 NOT_FOUND`。

#### PATCH /api/foreshadowing/:foreshadowingId

- 请求体：`{ name?, description?, status?, plantChapterId?: string|null, payoffChapterId?: string|null, expectedVersion?: number }`。
- 成功返回：`Foreshadowing`（`version + 1`），并写审计 `foreshadowing.update`；FTS 索引同步更新。
- 错误码：`400 INVALID_INPUT`、`404 NOT_FOUND`、`409 CONFLICT`。

### 6.9 审查

#### GET /api/projects/:projectId/reviews

- 成功返回：`ReviewRunSummary[]`：
  ```ts
  { run: ReviewRun, chapter: { id, chapterNo, title }, issueCount: number, openCount: number }
  ```
  按 `createdAt` 倒序；`openCount` 统计 `resolutionStatus = "open"` 的问题（含 minor）。
- 错误码：无（本列表接口不校验项目是否存在，未知项目返回空数组）。

#### GET /api/reviews/:reviewRunId

- 成功返回：`{ run: ReviewRun, chapter: Chapter, issues: ReviewIssue[] }`。
- 错误码：`404 NOT_FOUND`。

#### PATCH /api/issues/:issueId

- 请求体：`{ status: "open" | "resolved" | "wontfix"（必填） }`。
- 成功返回：`ReviewIssue`，并写审计 `issue.update`；影响 `ProjectOverview.counts.openIssues` 与 `listReviewRuns.openCount`。
- 错误码：`400 INVALID_INPUT`（枚举非法）、`404 NOT_FOUND`。

### 6.10 变更提议

#### GET /api/projects/:projectId/proposals

- 查询参数：`status?: string`（常见 `pending` / `applied` / `rejected`）。
- 成功返回：`ChangeProposal[]`，按 `createdAt` 倒序。
- 错误码：无（本列表接口不校验项目是否存在，未知项目返回空数组）。

#### POST /api/projects/:projectId/proposals

- 请求体：
  ```ts
  {
    targetType: "entity" | "event" | "foreshadowing",  // 必填
    operation: "create" | "update",                    // 必填
    payload: object,                                   // 必填，按目标类型校验（name/summary/attributes/...）
    targetId?: string,          // operation=update 时必填
    chapterId?: string,
    sourceRevisionId?: string,
    expectedVersion?: number    // update 时的乐观锁期望版本
  }
  ```
  `payload` 会经 Zod `changePayloadSchema` 校验：字段类型错误、以及 `name`/`summary`/`description`/`eventTime`
  全为空（含空对象 `{}`）都会返回 `400 INVALID_INPUT`。
- 成功返回：`ChangeProposal`（`status = "pending"`），并写审计 `proposal.create`。
- 错误码：`400 INVALID_INPUT`（`targetType`/`operation` 缺失或不在枚举内、`payload` 不是对象或校验失败、
  `operation=update` 缺 `targetId`）、`404 NOT_FOUND`、`409 CONFLICT`（更新的 `expectedVersion` 过期）。

#### POST /api/proposals/:proposalId/apply

- 请求体：无（可省略）。
- 语义：等价于「用户在工作台点击批准」——REST 层固定以 `approved = true` 调用领域层，审计留痕。
  应用后正式数据更新，提议 `status = "applied"`、`appliedAt` 写入决策时间。
- 成功返回：`ChangeProposal`。
- 错误码：`404 NOT_FOUND`（提议/目标实体不存在）、`409 CONFLICT`（非 `pending` 状态重复应用，或
  `expectedVersion` 与目标当前版本不一致）、`400 INVALID_INPUT`（例如事件提议缺 `summary`）、
  `500 INTERNAL`（库中 payload 损坏或唯一索引冲突）。

#### POST /api/proposals/:proposalId/reject

- 请求体：无（可省略）。
- 成功返回：`ChangeProposal`（`status = "rejected"`），并写审计 `proposal.reject`。
  `appliedAt` 在此接口中表示「决策时间（驳回时间）」，不是应用时间。
- 错误码：`404 NOT_FOUND`、`409 CONFLICT`（非 `pending`，重复驳回）。

### 6.11 工作流

#### GET /api/projects/:projectId/workflows

- 成功返回：`WorkflowRun[]`，按 `updatedAt` 倒序，最多 100 条。`state` 常见
  `running` / `completed` / `failed` / `paused`；`taskType` 如 `plan_outline` / `write_draft` /
  `review_chapter` / `revise_chapter` / `continue_chapter` / `rewrite_chapter`。
- 错误码：无（本列表接口不校验项目是否存在，未知项目返回空数组）。

## 7. 静态资源与 SPA 回退

非 `/api/*` 的路径走静态托管：

- `studioDir/index.html` 不存在 → `503 text/html`，页面提示执行 `pnpm run studio:build`。
- 存在时：命中真实文件则按其扩展名返回 MIME（`text/html` / `text/javascript` / `text/css` / 图片等，
  静态资源 `cache-control: public, max-age=3600`）；未命中或路径越界则回退 `index.html`（`cache-control: no-store`）。
- 畸形百分号编码 → `400 text/plain`（不会抛异常，也不会挂起请求）。
- 静态资源只支持 `GET` / `HEAD`；其他方法 → `405`、`error.code = "INVALID_INPUT"`。

## 8. 已知限制

1. `appliedAt` 字段同时承载「应用时间」和「驳回决策时间」，沿用现有表结构以避免迁移（见 6.10）。
2. 项目/章节下的「列表类」GET 接口不校验父资源是否存在：未知 `projectId` / `chapterId` 返回 `200` + 空数组
   （各端点已分别标注）；单资源 GET 与所有写接口会返回 `404 NOT_FOUND`。
3. `GET /api/projects/:projectId/search` 的 FTS5 trigram 索引对 <3 字查询会回退子串匹配；两字中文名可命中，
   但非连续子串（如从「青铜钥匙」里搜「青钥匙」）不属于子串，检索不到——这是全文索引的正常语义，不是缺陷。

---

## 9. 0.5.0 新增端点（关系 / 剧情线 / 场景 / 素材导入）

> 端点数从 48 增至 **62**。以下均为同源 JSON 信封；错误码沿用 §2。

### 9.1 关系

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/projects/:projectId/relations` | 返回 `Relation[]`，每条额外带 `sourceName` / `targetName`（已解析成人名） |
| POST | `/api/projects/:projectId/relations` | body：`sourceId, targetId, kind, tension?, notes?, sinceChapterId?` |
| PATCH | `/api/relations/:relationId` | body：`kind?, tension?, notes?, status?, sinceChapterId?, expectedVersion?` |

### 9.2 剧情线

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/projects/:projectId/threads` | `PlotThread[]` |
| POST | `/api/projects/:projectId/threads` | body：`name, kind?(main/sub/romance/mystery/revenge/growth), goal?, summary?, currentChapterId?` |
| PATCH | `/api/threads/:threadId` | body：`name?, kind?, goal?, summary?, status?, currentChapterId?, expectedVersion?` |

### 9.3 场景 / 节拍

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/chapters/:chapterId/scenes` | `Scene[]`，每条额外带 `castNames` / `locationName` |
| POST | `/api/chapters/:chapterId/scenes` | body：`sceneNo?, beat?, goal?, conflict?, outcome?, locationEntityId?, cast?(string[]), povEntityId?, notes?` |
| PATCH | `/api/scenes/:sceneId` | body：`beat?, goal?, conflict?, outcome?, locationEntityId?, cast?, povEntityId?, notes?, status?, expectedVersion?` |
| DELETE | `/api/scenes/:sceneId` | 返回 `{ ok: true }` |

### 9.4 素材导入

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/projects/:projectId/ingest` | body：`material`（≥20 字）、`title?`、`focus?`、`mode?`(propose/apply)。返回 `{ batch, stats, proposals, applied? }` |
| GET | `/api/projects/:projectId/ingest-batches` | `IngestBatch[]`（最近 50 条） |
| GET | `/api/ingest-batches/:batchId` | `{ batch, proposals }` |
| POST | `/api/ingest-batches/:batchId/apply` | 应用该批次全部待审批提议；返回 `{ applied, failed, batch }` |

**口径说明**

- `stats.droppedReasons` 记录被丢弃原因，常见键：`entity_evidence_missing` / `relation_evidence_missing` / `event_evidence_missing` / `foreshadowing_evidence_missing` / `thread_evidence_missing` / `relation_unknown_entity`。
- `stats.conflictList` 是模型报告的素材内部矛盾（类型 + 描述 + 证据），仅提示，不自动修改任何资料。
- 应用顺序固定为 实体 → 剧情线 → 伏笔 → 事件 → **关系**，保证同批新建的人物能被关系解析到。
- 无模型凭据时 `POST /ingest` 返回 `400 CONFIG_ERROR`（与其它 AI 端点一致）。
