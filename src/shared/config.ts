import { z } from 'zod'
import { NovelForgeError } from './errors.js'

export interface RuntimeConfig {
  databasePath: string
  /** DSH 提供方路由；留空表示自动选择（宿主默认模型 > 第一个已注册提供方）。 */
  provider: string
  apiKey: string
  apiKeyEnv: string
  baseURL: string
  /** 留空表示跟随 DSH 宿主默认模型；非空则覆盖宿主选择。直连模式回退 `deepseek-chat`。 */
  model: string
  temperature: number
  maxTokens: number
  timeoutMs: number
  maxRetries: number
  retryBaseDelayMs: number
  maxInputTokens: number
  maxContextTokens: number
  recentChapters: number
  maxRevisionRounds: number
  /** DSH 插件加载时自动起本地工作台服务，供内嵌面板与浏览器使用。 */
  studioAutoStart: boolean
  /** 工作台服务监听端口；被占用时自动向后顺延。 */
  studioPort: number
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  databasePath: './data/novelforge.db',
  provider: '',
  apiKey: '',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseURL: 'https://api.deepseek.com',
  model: '',
  temperature: 0.8,
  maxTokens: 4096,
  timeoutMs: 60_000,
  maxRetries: 3,
  retryBaseDelayMs: 800,
  maxInputTokens: 24_000,
  maxContextTokens: 64_000,
  recentChapters: 3,
  maxRevisionRounds: 3,
  studioAutoStart: true,
  studioPort: 4319,
}

const environmentSchema = z.object({
  DEEPSEEK_API_KEY: z.string().optional(),
  DEEPSEEK_PROVIDER: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().url().optional(),
  DEEPSEEK_MODEL: z.string().min(1).optional(),
  DEEPSEEK_TEMPERATURE: z.coerce.number().min(0).max(2).optional(),
  DEEPSEEK_MAX_TOKENS: z.coerce.number().int().min(256).max(32768).optional(),
  DEEPSEEK_TIMEOUT_MS: z.coerce.number().int().min(1000).optional(),
  DEEPSEEK_MAX_RETRIES: z.coerce.number().int().min(0).max(10).optional(),
  NOVELFORGE_DB_PATH: z.string().min(1).optional(),
  NOVELFORGE_MAX_INPUT_TOKENS: z.coerce.number().int().min(2000).optional(),
  NOVELFORGE_MAX_CONTEXT_TOKENS: z.coerce.number().int().min(8192).optional(),
  NOVELFORGE_RECENT_CHAPTERS: z.coerce.number().int().min(0).max(10).optional(),
  NOVELFORGE_MAX_REVISION_ROUNDS: z.coerce.number().int().min(0).max(10).optional(),
  NOVELFORGE_STUDIO_AUTOSTART: z.string().optional(),
  NOVELFORGE_STUDIO_PORT: z.coerce.number().int().min(1024).max(65535).optional(),
})

export function validateRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) {
    throw new NovelForgeError('CONFIG_ERROR', 'temperature 必须在 0 到 2 之间。')
  }
  if (!Number.isInteger(config.maxTokens) || config.maxTokens < 256) {
    throw new NovelForgeError('CONFIG_ERROR', 'maxTokens 必须是至少为 256 的整数。')
  }
  if (config.maxInputTokens < 2000 || config.maxContextTokens <= config.maxTokens) {
    throw new NovelForgeError('CONFIG_ERROR', '上下文预算无效：maxInputTokens 至少 2000，maxContextTokens 必须大于 maxTokens。')
  }
  if (config.maxRetries < 0 || config.maxRevisionRounds < 0) {
    throw new NovelForgeError('CONFIG_ERROR', '重试次数和修订轮次不能为负数。')
  }
  if (!Number.isInteger(config.studioPort) || config.studioPort < 1024 || config.studioPort > 65535) {
    throw new NovelForgeError('CONFIG_ERROR', 'studioPort 必须是 1024 到 65535 之间的整数。')
  }
  return { ...config, baseURL: config.baseURL.replace(/\/+$/, '') }
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = environmentSchema.safeParse(env)
  if (!parsed.success) {
    throw new NovelForgeError('CONFIG_ERROR', `环境变量配置无效：${parsed.error.issues.map(issue => issue.message).join('；')}`)
  }
  const value = parsed.data
  return validateRuntimeConfig({
    ...DEFAULT_CONFIG,
    apiKey: value.DEEPSEEK_API_KEY ?? '',
    provider: value.DEEPSEEK_PROVIDER ?? DEFAULT_CONFIG.provider,
    baseURL: value.DEEPSEEK_BASE_URL ?? DEFAULT_CONFIG.baseURL,
    model: value.DEEPSEEK_MODEL ?? DEFAULT_CONFIG.model,
    temperature: value.DEEPSEEK_TEMPERATURE ?? DEFAULT_CONFIG.temperature,
    maxTokens: value.DEEPSEEK_MAX_TOKENS ?? DEFAULT_CONFIG.maxTokens,
    timeoutMs: value.DEEPSEEK_TIMEOUT_MS ?? DEFAULT_CONFIG.timeoutMs,
    maxRetries: value.DEEPSEEK_MAX_RETRIES ?? DEFAULT_CONFIG.maxRetries,
    databasePath: value.NOVELFORGE_DB_PATH ?? DEFAULT_CONFIG.databasePath,
    maxInputTokens: value.NOVELFORGE_MAX_INPUT_TOKENS ?? DEFAULT_CONFIG.maxInputTokens,
    maxContextTokens: value.NOVELFORGE_MAX_CONTEXT_TOKENS ?? DEFAULT_CONFIG.maxContextTokens,
    recentChapters: value.NOVELFORGE_RECENT_CHAPTERS ?? DEFAULT_CONFIG.recentChapters,
    maxRevisionRounds: value.NOVELFORGE_MAX_REVISION_ROUNDS ?? DEFAULT_CONFIG.maxRevisionRounds,
    studioAutoStart: value.NOVELFORGE_STUDIO_AUTOSTART === undefined
      ? DEFAULT_CONFIG.studioAutoStart
      : ['1', 'true', 'yes', 'on'].includes(value.NOVELFORGE_STUDIO_AUTOSTART.toLowerCase()),
    studioPort: value.NOVELFORGE_STUDIO_PORT ?? DEFAULT_CONFIG.studioPort,
  })
}

export function resolveApiKey(config: RuntimeConfig, env: NodeJS.ProcessEnv = process.env): string {
  const key = config.apiKey.trim() || env[config.apiKeyEnv]?.trim() || ''
  if (!key) {
    throw new NovelForgeError(
      'CONFIG_ERROR',
      `缺少 DeepSeek API Key。请设置 ${config.apiKeyEnv}，或在插件 config.apiKey 中配置；只读工具不受影响。`,
    )
  }
  return key
}

/** 直连 DeepSeek 时使用的模型：未显式配置则回退官方默认，避免空模型名发出无效请求。 */
export function resolveDirectModel(config: RuntimeConfig): string {
  return config.model.trim() || 'deepseek-chat'
}
