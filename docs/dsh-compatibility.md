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
- 本 MVP 不实现内嵌 React/Slot 工作台；CLI 与 DSH 工具是已交付入口。未来 UI 必须单独核验 Client Modules、Remote API 与 Slot，不得让浏览器直接访问 SQLite。
- DSH 仍可能调整预览接口。升级宿主时应重新核对上述官方文档、实际 `package.json` 和 `defineTool` 源码。
