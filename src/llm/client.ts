import type { RuntimeConfig } from '../shared/config.js'
import { resolveApiKey, resolveDirectModel } from '../shared/config.js'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CompletionRequest {
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  json?: boolean
}

export interface CompletionResult {
  content: string
  model: string
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

export interface LlmClient {
  complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult>
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'LlmError'
  }
}

interface DeepSeekResponse {
  model?: string
  choices?: Array<{ message?: { content?: string } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  error?: { message?: string; type?: string; code?: string }
}

function abortError(): LlmError {
  return new LlmError('DeepSeek 请求已取消。', 'ABORTED', false)
}

export class DeepSeekClient implements LlmClient {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = defaultSleep,
  ) {}

  async complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      if (signal?.aborted) throw abortError()
      try {
        return await this.requestOnce(request, signal)
      } catch (error) {
        lastError = error
        if (!(error instanceof LlmError) || !error.retryable || attempt >= this.config.maxRetries) throw error
        const exponential = this.config.retryBaseDelayMs * 2 ** attempt
        const jitter = Math.floor(Math.random() * Math.max(1, this.config.retryBaseDelayMs / 2))
        const delay = error.retryAfterMs ?? exponential + jitter
        await this.sleep(delay, signal)
      }
    }
    throw lastError
  }

  private async requestOnce(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('DeepSeek request timeout')), this.config.timeoutMs)
    try {
      let response: Response
      try {
        response = await this.fetchImpl(`${this.config.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resolveApiKey(this.config)}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            model: resolveDirectModel(this.config),
            messages: request.messages,
            temperature: request.temperature ?? this.config.temperature,
            max_tokens: request.maxTokens ?? this.config.maxTokens,
            stream: false,
            ...(request.json ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal: controller.signal,
        })
      } catch (error) {
        if (signal?.aborted) throw abortError()
        if (controller.signal.aborted) {
          throw new LlmError(`DeepSeek 请求超过 ${this.config.timeoutMs}ms，已超时。`, 'TIMEOUT', true)
        }
        throw new LlmError(`无法连接 DeepSeek API：${error instanceof Error ? error.message : String(error)}`, 'NETWORK_ERROR', true)
      }

      const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
      const raw = await response.text()
      let payload: DeepSeekResponse
      try {
        payload = JSON.parse(raw) as DeepSeekResponse
      } catch {
        throw new LlmError(
          `DeepSeek 返回了非 JSON HTTP 响应（HTTP ${response.status}）：${raw.slice(0, 300)}`,
          'INVALID_HTTP_RESPONSE', response.status >= 500 || response.status === 429, response.status, retryAfter,
        )
      }
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500
        const message = payload.error?.message ?? (raw.slice(0, 300) || response.statusText)
        throw new LlmError(
          `DeepSeek API 错误（HTTP ${response.status}）：${message}`,
          `HTTP_${response.status}`, retryable, response.status, retryAfter,
        )
      }
      const content = payload.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim()) {
        throw new LlmError('DeepSeek 响应缺少 choices[0].message.content，或正文为空。', 'INVALID_RESPONSE', true)
      }
      return {
        content,
        model: payload.model ?? resolveDirectModel(this.config),
        ...(payload.usage ? {
          usage: {
            ...(payload.usage.prompt_tokens !== undefined ? { promptTokens: payload.usage.prompt_tokens } : {}),
            ...(payload.usage.completion_tokens !== undefined ? { completionTokens: payload.usage.completion_tokens } : {}),
            ...(payload.usage.total_tokens !== undefined ? { totalTokens: payload.usage.total_tokens } : {}),
          },
        } : {}),
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
