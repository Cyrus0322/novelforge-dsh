import type { RuntimeConfig } from '../shared/config.js'
import { resolveApiKey } from '../shared/config.js'
import type { ChatMessage, CompletionRequest, CompletionResult, LlmClient } from './client.js'
import { DeepSeekClient, LlmError } from './client.js'

/**
 * DSH 模型服务的结构化子集。
 *
 * 这里刻意不 import `@deepseek-ai/dsh-llm`：领域层不应绑定宿主实现，
 * 且宿主升级时只需保证 `ctx.llm.stream` 的这段契约不变。
 * 字段与官方 `GenerateOptions` / `StreamChunk` 对齐，见 docs/dsh-compatibility.md。
 */
export interface DshTextContent {
  type: 'text'
  text: string
}

export interface DshRequestMessage {
  role: 'user'
  content: DshTextContent[]
}

export interface DshGenerateOptions {
  provider: string
  model: string
  messages: DshRequestMessage[]
  system?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface DshTokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface DshFinishReason {
  kind?: string
  failure?: { code?: string; message?: string }
}

export interface DshStreamChunk {
  type?: string
  index?: number
  text?: string
  usage?: DshTokenUsage
  reason?: DshFinishReason
}

export interface DshLlmRuntime {
  stream(options: DshGenerateOptions): AsyncIterable<DshStreamChunk>
  listProviders?(): ReadonlyArray<{ id: string; name?: string }>
}

export interface DshModelSelection {
  provider?: string
  model?: string
  reasoningEffort?: string
}

/** 只读 Cordis 上下文子集：惰性取服务，避免 `inject` 缺失导致插件加载失败。 */
export interface DshContextLike {
  get?(name: string): unknown
}

/** 可重试的失败码：限流与瞬时故障。按官方约定只认 code，不解析消息文本。 */
const RETRYABLE_CODES = new Set([
  'RATE_LIMIT',
  'TIMEOUT',
  'NETWORK',
  'NETWORK_ERROR',
  'SERVER_ERROR',
  'INTERNAL',
  'UNAVAILABLE',
  'OVERLOADED',
  'CONFLICT',
])

/** 明确不可重试：凭据、路由、额度、上下文窗口等问题重试无意义。 */
const FATAL_CODES = new Set([
  'NO_ADAPTER',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'AUTH',
  'QUOTA',
  'ACCOUNT_QUOTA',
  'INVALID_ARGS',
  'IMAGE_OFFLOAD_REQUIRED',
  'CONTEXT_WINDOW_EXCEEDED',
])

function isRuntime(value: unknown): value is DshLlmRuntime {
  return typeof value === 'object' && value !== null && typeof (value as DshLlmRuntime).stream === 'function'
}

function readSelection(value: unknown): DshModelSelection | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (typeof (value as { currentSelection?: unknown }).currentSelection !== 'function') return undefined
  const selection = (value as { currentSelection: () => unknown }).currentSelection()
  if (typeof selection !== 'object' || selection === null) return undefined
  return selection as DshModelSelection
}

/**
 * 解析本次调用使用的提供方路由与模型。
 *
 * 优先级：插件显式配置 > DSH 宿主默认模型 > 第一个已注册提供方 > 插件配置的模型。
 */
export function resolveDshRoute(runtime: DshLlmRuntime, config: RuntimeConfig, host?: DshContextLike): {
  provider: string
  model: string
} {
  const selection = host === undefined ? undefined : readSelection(host.get?.('agentDefaultModel'))
  const providers = typeof runtime.listProviders === 'function' ? runtime.listProviders() : []
  const provider = config.provider.trim() || selection?.provider?.trim() || providers[0]?.id?.trim() || ''
  const model = config.model.trim() || selection?.model?.trim() || ''
  if (!provider) {
    throw new LlmError(
      'DSH 当前没有已注册的模型提供方，无法调用模型。请确认 profile 已挂载 @deepseek-ai/dsh-llm 与至少一个适配器。',
      'NO_ADAPTER', false,
    )
  }
  if (!model) {
    throw new LlmError(
      `已找到提供方 ${provider}，但没有可用模型。请在插件配置 model 中指定，或在 DSH 中设置默认模型。`,
      'NO_MODEL', false,
    )
  }
  return { provider, model }
}

/**
 * 把 ChatMessage[] 压成「system + 单条 user」。
 *
 * 官方 RequestMessage 要么是带 id/source 的持久 Message，要么是 RequestUserInput；
 * 插件侧拿不到持久身份构造器，因此 assistant 轮次以显式分隔符内嵌进 user 文本，
 * 保证模型可见输入仍是请求内容的纯函数（不伪造身份字段）。
 */
export function flattenMessages(messages: ChatMessage[]): { system?: string; transcript: string } {
  const systemParts = messages.filter(message => message.role === 'system').map(message => message.content)
  const transcript = messages
    .filter(message => message.role !== 'system')
    .map(message =>
      message.role === 'assistant'
        ? `<前一次模型输出>\n${message.content}\n</前一次模型输出>`
        : message.content,
    )
    .join('\n\n')
  const system = systemParts.length ? systemParts.join('\n\n') : undefined
  return { ...(system ? { system } : {}), transcript }
}

export class DshLlmClient implements LlmClient {
  constructor(
    private readonly ctx: DshContextLike,
    private readonly config: RuntimeConfig,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = defaultSleep,
  ) {}

  async complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      if (signal?.aborted) throw new LlmError('模型请求已取消。', 'ABORTED', false)
      try {
        return await this.streamOnce(request, signal)
      } catch (error) {
        lastError = error
        if (!(error instanceof LlmError) || !error.retryable || attempt >= this.config.maxRetries) throw error
        const exponential = this.config.retryBaseDelayMs * 2 ** attempt
        const jitter = Math.floor(Math.random() * Math.max(1, this.config.retryBaseDelayMs / 2))
        await this.sleep(error.retryAfterMs ?? exponential + jitter, signal)
      }
    }
    throw lastError
  }

  private async streamOnce(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const runtime = this.ctx.get?.('llm')
    if (!isRuntime(runtime)) {
      throw new LlmError(
        '当前运行环境没有可用的 DSH 模型服务（ctx.llm）。写作类工具需要模型服务；只读工具不受影响。',
        'NO_ADAPTER', false,
      )
    }
    const route = resolveDshRoute(runtime, this.config, this.ctx)
    const { system, transcript } = flattenMessages(request.messages)

    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('DSH model request timeout'))
    }, this.config.timeoutMs)

    try {
      const chunks = runtime.stream({
        provider: route.provider,
        model: route.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
        ...(system ? { system } : {}),
        temperature: request.temperature ?? this.config.temperature,
        maxTokens: request.maxTokens ?? this.config.maxTokens,
        signal: controller.signal,
      })

      let text = ''
      let usage: CompletionResult['usage']
      let finished = false
      for await (const chunk of chunks) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text
          continue
        }
        if (chunk.type === 'usage' && chunk.usage) {
          usage = {
            ...(chunk.usage.inputTokens !== undefined ? { promptTokens: chunk.usage.inputTokens } : {}),
            ...(chunk.usage.outputTokens !== undefined ? { completionTokens: chunk.usage.outputTokens } : {}),
            ...(chunk.usage.totalTokens !== undefined ? { totalTokens: chunk.usage.totalTokens } : {}),
          }
          continue
        }
        if (chunk.type === 'finish') {
          finished = true
          const reason = chunk.reason
          if (reason?.kind === 'error' || reason?.kind === 'aborted') throw this.toError(reason, timedOut)
          if (reason?.kind === 'max-tokens') {
            throw new LlmError(
              `模型输出在达到 maxTokens（${request.maxTokens ?? this.config.maxTokens}）时被截断，请调大 maxTokens 后重试。`,
              'MAX_TOKENS', false,
            )
          }
        }
      }
      if (!finished) throw new LlmError('DSH 模型流未返回终止 finish 分片，结果不完整。', 'INCOMPLETE_STREAM', true)
      if (!text.trim()) throw new LlmError('DSH 模型流没有返回任何文本内容。', 'EMPTY_RESPONSE', true)
      return { content: text, model: route.model, ...(usage ? { usage } : {}) }
    } catch (error) {
      if (error instanceof LlmError) throw error
      if (timedOut) throw new LlmError(`DSH 模型请求超过 ${this.config.timeoutMs}ms，已超时。`, 'TIMEOUT', true)
      if (signal?.aborted) throw new LlmError('模型请求已取消。', 'ABORTED', false)
      throw new LlmError(
        `调用 DSH 模型服务失败：${error instanceof Error ? error.message : String(error)}`,
        'LLM_STREAM_FAILED', true,
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private toError(reason: DshFinishReason, timedOut: boolean): LlmError {
    if (timedOut) return new LlmError(`DSH 模型请求超过 ${this.config.timeoutMs}ms，已超时。`, 'TIMEOUT', true)
    const code = reason.failure?.code ?? (reason.kind === 'aborted' ? 'ABORTED' : 'UNKNOWN')
    const detail = reason.failure?.message ? `：${reason.failure.message}` : ''
    if (reason.kind === 'aborted') {
      return new LlmError(`模型请求被取消（${code}）${detail}`, code, false)
    }
    const retryable = FATAL_CODES.has(code) ? false : RETRYABLE_CODES.has(code) || code === 'UNKNOWN'
    return new LlmError(`DSH 模型调用失败（${code}）${detail}`, code, retryable)
  }
}

function hasDirectCredential(config: RuntimeConfig): boolean {
  try {
    return resolveApiKey(config).length > 0
  } catch {
    return false
  }
}

/**
 * 构造模型调用客户端：优先走 DSH 宿主模型服务，取不到时回退直连 DeepSeek。
 *
 * - DSH 内：用 `ctx.llm`，模型与提供方默认跟随宿主配置，不需要插件自己管 Key。
 * - 宿主没有可用提供方、但配置了 API Key：回退直连，保证功能不断。
 * - 独立 CLI（无 Cordis 上下文）：走直连。
 */
export function createHostLlmClient(ctx: DshContextLike, config: RuntimeConfig): LlmClient {
  const direct = new DeepSeekClient(config)
  const dsh = new DshLlmClient(ctx, config)
  return {
    async complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
      if (!isRuntime(ctx.get?.('llm'))) return direct.complete(request, signal)
      try {
        return await dsh.complete(request, signal)
      } catch (error) {
        const code = error instanceof LlmError ? error.code : ''
        if ((code === 'NO_ADAPTER' || code === 'NO_MODEL') && hasDirectCredential(config)) {
          return direct.complete(request, signal)
        }
        throw error
      }
    },
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmError('模型请求已取消。', 'ABORTED', false))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new LlmError('模型请求已取消。', 'ABORTED', false))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
