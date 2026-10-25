import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/shared/config.js'
import type { RuntimeConfig } from '../src/shared/config.js'
import { LlmError } from '../src/llm/client.js'
import type { DshContextLike, DshLlmRuntime, DshStreamChunk } from '../src/llm/dsh-llm.js'
import { DshLlmClient, createHostLlmClient, flattenMessages, resolveDshRoute } from '../src/llm/dsh-llm.js'

interface RecordedCall {
  provider: string
  model: string
  system?: string
  transcript: string
  temperature?: number
  maxTokens?: number
}

/** 模拟 DSH 模型服务：按脚本产出分片序列。 */
function scriptedRuntime(scripts: Array<() => AsyncIterable<DshStreamChunk>>, providers = ['deepseek-official']) {
  const calls: RecordedCall[] = []
  let index = 0
  const runtime: DshLlmRuntime = {
    listProviders: () => providers.map(id => ({ id })),
    stream(options) {
      calls.push({
        provider: options.provider,
        model: options.model,
        ...(options.system === undefined ? {} : { system: options.system }),
        transcript: options.messages[0]?.content[0]?.text ?? '',
        temperature: options.temperature,
        maxTokens: options.maxTokens,
      })
      const script = scripts[Math.min(index, scripts.length - 1)]
      index += 1
      return script()
    },
  }
  return { runtime, calls, get count() { return index } }
}

async function* textStream(text: string, usage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 }): AsyncIterable<DshStreamChunk> {
  yield { type: 'block-start', index: 0 }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'usage', usage }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function* errorStream(code: string): AsyncIterable<DshStreamChunk> {
  yield { type: 'finish', reason: { kind: 'error', failure: { code, message: `模拟 ${code}` } } }
}

function hostWith(runtime: DshLlmRuntime | undefined, selection?: { provider: string; model: string }): DshContextLike {
  return {
    get(name: string): unknown {
      if (name === 'llm') return runtime
      if (name === 'agentDefaultModel' && selection) return { currentSelection: () => selection }
      return undefined
    },
  }
}

function cfg(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return { ...DEFAULT_CONFIG, retryBaseDelayMs: 1, maxRetries: 2, ...overrides }
}

describe('DSH 宿主模型客户端', () => {
  it('通过 ctx.llm 调用宿主模型，并正确拆分 system 与正文', async () => {
    const { runtime, calls } = scriptedRuntime([() => textStream('正文内容')])
    const client = new DshLlmClient(hostWith(runtime), cfg({ model: 'deepseek-v4-flash' }))

    const result = await client.complete({
      messages: [
        { role: 'system', content: '你是小说家' },
        { role: 'user', content: '写第一章' },
      ],
      temperature: 0.7,
      maxTokens: 2048,
    })

    expect(result.content).toBe('正文内容')
    expect(result.model).toBe('deepseek-v4-flash')
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30 })
    expect(calls[0].provider).toBe('deepseek-official')
    expect(calls[0].system).toBe('你是小说家')
    expect(calls[0].transcript).toBe('写第一章')
    expect(calls[0].temperature).toBe(0.7)
    expect(calls[0].maxTokens).toBe(2048)
  })

  it('限流失败会退避重试，成功后返回内容', async () => {
    const scripted = scriptedRuntime([
      () => errorStream('RATE_LIMIT'),
      () => textStream('重试后成功'),
    ])
    const client = new DshLlmClient(hostWith(scripted.runtime), cfg({ model: 'm' }))

    const result = await client.complete({ messages: [{ role: 'user', content: 'x' }] })
    expect(result.content).toBe('重试后成功')
    expect(scripted.count).toBe(2)
  })

  it('凭据类失败不重试，直接抛出且带稳定 code', async () => {
    const scripted = scriptedRuntime([() => errorStream('AUTH')])
    const client = new DshLlmClient(hostWith(scripted.runtime), cfg({ model: 'm' }))

    await expect(client.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code: 'AUTH' })
    expect(scripted.count).toBe(1)
  })

  it('输出被 maxTokens 截断时给出明确错误', async () => {
    const { runtime } = scriptedRuntime([
      async function* () { yield { type: 'finish', reason: { kind: 'max-tokens' } } },
    ])
    const client = new DshLlmClient(hostWith(runtime), cfg({ model: 'm', maxTokens: 100 }))

    await expect(client.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code: 'MAX_TOKENS' })
  })

  it('没有 llm 服务时报错，不静默降级', async () => {
    const client = new DshLlmClient(hostWith(undefined), cfg({ model: 'm' }))
    await expect(client.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/ctx\.llm/)
  })
})

describe('模型路由解析', () => {
  const runtime: DshLlmRuntime = { stream: () => textStream('x'), listProviders: () => [{ id: 'fallback-provider' }] }

  it('显式配置优先于宿主默认', () => {
    const route = resolveDshRoute(
      runtime,
      cfg({ provider: 'explicit', model: 'explicit-model' }),
      hostWith(runtime, { provider: 'host', model: 'host-model' }),
    )
    expect(route).toEqual({ provider: 'explicit', model: 'explicit-model' })
  })

  it('未配置时跟随宿主默认模型', () => {
    const route = resolveDshRoute(runtime, cfg(), hostWith(runtime, { provider: 'host', model: 'host-model' }))
    expect(route).toEqual({ provider: 'host', model: 'host-model' })
  })

  it('没有宿主默认时退回第一个已注册提供方', () => {
    const route = resolveDshRoute(runtime, cfg({ model: 'cfg-model' }), hostWith(runtime))
    expect(route).toEqual({ provider: 'fallback-provider', model: 'cfg-model' })
  })

  it('既无提供方也无模型时给出可操作错误', () => {
    const bare: DshLlmRuntime = { stream: () => textStream('x'), listProviders: () => [] }
    expect(() => resolveDshRoute(bare, cfg(), hostWith(bare))).toThrow(/没有已注册的模型提供方/)
    expect(() => resolveDshRoute(runtime, cfg(), hostWith(runtime))).toThrow(/没有可用模型/)
  })
})

describe('消息压平', () => {
  it('system 合并、assistant 轮次带分隔符内嵌', () => {
    const flat = flattenMessages([
      { role: 'system', content: '规则一' },
      { role: 'system', content: '规则二' },
      { role: 'user', content: '请写' },
      { role: 'assistant', content: '上次输出' },
      { role: 'user', content: '请修正' },
    ])
    expect(flat.system).toBe('规则一\n\n规则二')
    expect(flat.transcript).toContain('请写')
    expect(flat.transcript).toContain('<前一次模型输出>\n上次输出\n</前一次模型输出>')
    expect(flat.transcript.endsWith('请修正')).toBe(true)
  })
})

describe('客户端装配', () => {
  it('无宿主模型服务且配置了 Key 时回退直连', async () => {
    const seen: string[] = []
    const client = createHostLlmClient(hostWith(undefined), cfg({ apiKey: 'sk-x', baseURL: 'https://example.test' }))
    // 用 fetch stub 验证确实走了直连路径。
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url))
      return new Response(JSON.stringify({ model: 'direct', choices: [{ message: { content: '直连结果' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const result = await client.complete({ messages: [{ role: 'user', content: 'x' }] })
      expect(result.content).toBe('直连结果')
      expect(seen[0]).toContain('https://example.test/chat/completions')
    } finally {
      globalThis.fetch = original
    }
  })

  it('宿主无提供方但有 Key 时，单次失败后回退直连', async () => {
    const { runtime } = scriptedRuntime([() => errorStream('NO_ADAPTER')])
    const client = createHostLlmClient(hostWith(runtime), cfg({ apiKey: 'sk-x', baseURL: 'https://example.test', model: 'm' }))
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ model: 'direct', choices: [{ message: { content: '回退结果' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch
    try {
      const result = await client.complete({ messages: [{ role: 'user', content: 'x' }] })
      expect(result.content).toBe('回退结果')
    } finally {
      globalThis.fetch = original
    }
  })

  it('宿主报错且无回退凭据时，保留宿主错误码而不是换成 Key 缺失', async () => {
    const { runtime } = scriptedRuntime([() => errorStream('AUTH')])
    const client = createHostLlmClient(hostWith(runtime), cfg({ apiKey: '', model: 'm' }))
    await expect(client.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('取消信号会中止并不重试', async () => {
    const { runtime } = scriptedRuntime([() => errorStream('RATE_LIMIT')])
    const client = new DshLlmClient(hostWith(runtime), cfg({ model: 'm' }))
    const controller = new AbortController()
    controller.abort()
    await expect(client.complete({ messages: [{ role: 'user', content: 'x' }] }, controller.signal))
      .rejects.toBeInstanceOf(LlmError)
  })
})
