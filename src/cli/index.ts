#!/usr/bin/env node
import { Command } from 'commander'
import { configFromEnv, resolveApiKey, resolveDirectModel } from '../shared/config.js'
import { NovelForgeError } from '../shared/errors.js'
import { createNovelService } from '../workflow/novel-service.js'
import type { NovelService } from '../workflow/novel-service.js'
import { DEFAULT_STUDIO_PORT, openBrowser, startStudioServer } from '../server/index.js'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import 'dotenv/config'

const program = new Command()
program
  .name('novelforge')
  .description('NovelForge DSH：可追溯、需人工确认的长篇小说创作工具')
  .version('0.3.0')
  .option('--db <path>', 'SQLite 数据库路径')
  .option('--model <name>', 'DeepSeek 模型名称')

interface GlobalOptions {
  db?: string
  model?: string
}

function service(): NovelService {
  const options = program.opts<GlobalOptions>()
  const config = configFromEnv()
  if (options.db) config.databasePath = options.db
  if (options.model) config.model = options.model
  return createNovelService(config)
}

function integer(value: string, field: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new NovelForgeError('INVALID_INPUT', `${field} 必须是整数。`)
  return parsed
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function run(action: (service: NovelService) => void | Promise<void>): Promise<void> {
  const instance = service()
  try {
    await action(instance)
  } catch (error) {
    const code = error instanceof NovelForgeError ? error.code : 'ERROR'
    process.stderr.write(`错误 [${code}]：${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  } finally {
    instance.close()
  }
}

program.command('doctor').description('检查本地运行环境（不发送 API 请求）').action(() => run(async instance => {
  const config = instance.config
  let apiKeyConfigured = true
  try {
    resolveApiKey(config)
  } catch {
    apiKeyConfigured = false
  }
  print({
    ok: true,
    node: process.version,
    dshHostRequirement: '>=24.9.0',
    databasePath: resolve(config.databasePath),
    model: resolveDirectModel(config),
    baseURL: config.baseURL,
    apiKeyConfigured,
    projects: instance.store.listProjects().length,
  })}))

program.command('projects').description('列出小说项目').action(() => run(instance => {
  print(instance.store.listProjects())
}))

program.command('create').description('创建空小说项目')
  .requiredOption('--title <title>', '书名')
  .requiredOption('--genre <genre>', '题材')
  .option('--premise <text>', '故事前提', '')
  .option('--style <text>', '文风规范', '')
  .action((options: { title: string; genre: string; premise: string; style: string }) => run(instance => {
    print(instance.createProject({ title: options.title, genre: options.genre, premise: options.premise, styleGuide: options.style }))
  }))

program.command('generate').description('AI 生成题材、人物和世界观并创建项目')
  .requiredOption('--idea <text>', '创作意图')
  .action((options: { idea: string }) => run(async instance => {
    print(await instance.generateSetting(options.idea))
  }))

program.command('plan').description('AI 规划后续章节')
  .requiredOption('--project <id>', '项目 ID')
  .option('--count <number>', '章节数量', '10')
  .action((options: { project: string; count: string }) => run(async instance => {
    print(await instance.planOutline(options.project, integer(options.count, 'count')))
  }))

program.command('chapters').description('列出章节')
  .requiredOption('--project <id>', '项目 ID')
  .action((options: { project: string }) => run(instance => {
    print(instance.store.listChapters(options.project))
  }))

program.command('context').description('查看章节实际上下文预算与来源')
  .requiredOption('--chapter <id>', '章节 ID')
  .action((options: { chapter: string }) => run(instance => {
    print(instance.getContext(options.chapter))
  }))

program.command('write').description('规划并生成一章草稿')
  .requiredOption('--project <id>', '项目 ID')
  .requiredOption('--chapter <number>', '章节编号')
  .action((options: { project: string; chapter: string }) => run(async instance => {
    const chapter = instance.store.getChapterByNumber(options.project, integer(options.chapter, 'chapter'))
    const result = await instance.writeDraft(chapter.id)
    print({ revision: result.revision, plan: result.plan, context: { ...result.context, text: undefined } })
  }))

program.command('continue').description('续写指定版本并生成新版本')
  .requiredOption('--revision <id>', '版本 ID')
  .option('--instruction <text>', '续写要求', '')
  .action((options: { revision: string; instruction: string }) => run(async instance => {
    print(await instance.continueChapter(options.revision, options.instruction))
  }))

program.command('rewrite').description('完整改写指定版本并生成新版本')
  .requiredOption('--revision <id>', '版本 ID')
  .requiredOption('--instruction <text>', '改写要求')
  .action((options: { revision: string; instruction: string }) => run(async instance => {
    print(await instance.rewriteChapter(options.revision, options.instruction))
  }))

program.command('review').description('审查指定正文版本')
  .requiredOption('--revision <id>', '版本 ID')
  .action((options: { revision: string }) => run(async instance => {
    print(await instance.reviewChapter(options.revision))
  }))

program.command('revise').description('修复选定审查问题并自动复检')
  .requiredOption('--revision <id>', '版本 ID')
  .requiredOption('--issues <ids>', '问题 ID，英文逗号分隔')
  .option('--instruction <text>', '附加修订要求', '')
  .action((options: { revision: string; issues: string; instruction: string }) => run(async instance => {
    const issueIds = options.issues.split(',').map(value => value.trim()).filter(Boolean)
    print(await instance.reviseChapter(options.revision, issueIds, options.instruction))
  }))

program.command('revisions').description('列出章节版本')
  .requiredOption('--chapter <id>', '章节 ID')
  .option('--full', '包含完整正文', false)
  .action((options: { chapter: string; full: boolean }) => run(instance => {
    const revisions = instance.store.listRevisions(options.chapter)
    print(options.full ? revisions : revisions.map(({ content, ...row }) => ({ ...row, contentLength: content.length })))
  }))

program.command('compare').description('比较两个版本')
  .requiredOption('--left <id>', '旧版本 ID')
  .requiredOption('--right <id>', '新版本 ID')
  .action((options: { left: string; right: string }) => run(instance => {
    print(instance.compareRevisions(options.left, options.right))
  }))

program.command('rollback').description('从历史版本创建回滚草稿')
  .requiredOption('--revision <id>', '历史版本 ID')
  .action((options: { revision: string }) => run(instance => {
    print(instance.rollbackRevision(options.revision))
  }))

program.command('finalize').description('人工确认后定稿最新已审查版本')
  .requiredOption('--revision <id>', '版本 ID')
  .option('--changes <ids>', '同时应用的提议 ID，英文逗号分隔', '')
  .option('--yes', '确认已阅读审查结果并批准定稿', false)
  .action((options: { revision: string; changes: string; yes: boolean }) => run(instance => {
    const changes = options.changes.split(',').map(value => value.trim()).filter(Boolean)
    print(instance.finalizeChapter(options.revision, options.yes, changes))
  }))

program.command('search').description('搜索小说资料与正文')
  .requiredOption('--project <id>', '项目 ID')
  .requiredOption('--query <text>', '关键词')
  .option('--limit <number>', '结果上限', '10')
  .action((options: { project: string; query: string; limit: string }) => run(instance => {
    print(instance.store.search(options.project, options.query, [], integer(options.limit, 'limit')))
  }))

program.command('export').description('导出已定稿章节为 Markdown')
  .requiredOption('--project <id>', '项目 ID')
  .option('--output <path>', '输出文件；省略时打印到 stdout')
  .action((options: { project: string; output?: string }) => run(instance => {
    const markdown = instance.exportMarkdown(options.project)
    if (options.output) {
      const path = resolve(options.output)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, markdown, 'utf8')
      print({ ok: true, output: path, bytes: Buffer.byteLength(markdown) })
    } else {
      process.stdout.write(markdown)
    }
  }))

program.command('studio').description('启动可视化小说工作台（本地网页，浏览器不直接访问数据库）')
  .option('--port <number>', '监听端口', String(DEFAULT_STUDIO_PORT))
  .option('--host <address>', '监听地址（非本机时必须设置 NOVELFORGE_STUDIO_TOKEN）', '127.0.0.1')
  .option('--token <token>', '访问令牌；也可用环境变量 NOVELFORGE_STUDIO_TOKEN')
  .option('--no-open', '启动后不自动打开浏览器')
  .action((options: { port: string; host: string; token?: string; open: boolean }) => {
    void (async () => {
      const config = configFromEnv()
      const globalOptions = program.opts<GlobalOptions>()
      if (globalOptions.db) config.databasePath = globalOptions.db
      if (globalOptions.model) config.model = globalOptions.model
      const handle = await startStudioServer({
        config,
        port: integer(options.port, 'port'),
        host: options.host,
        ...(options.token === undefined ? {} : { token: options.token }),
      })
      const built = existsSync(resolve(handle.studioDir, 'index.html'))
      process.stdout.write(`NovelForge 工作台已启动：${handle.url}\n`)
      process.stdout.write(`数据库：${resolve(config.databasePath)}\n`)
      if (!built) {
        process.stdout.write(`⚠️ 未找到前端构建产物（${handle.studioDir}），请先执行 pnpm run studio:build。\n`)
      }
      if (options.open) openBrowser(handle.url)
      process.stdout.write('按 Ctrl+C 结束。\n')
      const shutdown = (): void => {
        void handle.close().then(() => process.exit(0))
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })().catch(error => {
      const code = error instanceof NovelForgeError ? error.code : 'ERROR'
      process.stderr.write(`错误 [${code}]：${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
  })

await program.parseAsync(process.argv)
