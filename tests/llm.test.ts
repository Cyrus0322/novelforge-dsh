import { describe, expect, it } from 'vitest'
import { DeepSeekClient } from '../src/llm/client.js'
import { completeStructured, parseModelJson } from '../src/llm/structured.js'
import { z } from 'zod'
import { MockLlm, testConfig } from './helpers.js'

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('DeepSeekClient', () => {
  it('遇到 429 时遵循 Retry-After 并重试', async () => {
    let calls = 0
    const delays: number[] = []
    const client = new DeepSeekClient(testConfig({ maxRetries: 2 }), async () => {
      calls += 1
      return calls === 1
        ? response(429, { error: { message: 'rate limited' } }, { 'retry-after': '0' })
        : response(200, { model: 'deepseek-chat', choices: [{ message: { content: '成功' } }] })
    }, async ms => { delays.push(ms) })
    const result = await client.complete({ messages: [{ role: 'user', content: 'test' }] })
    expect(result.content).toBe('成功')
    expect(calls).toBe(2)
    expect(delays).toEqual([0])
  })

  it('401 不重试，网络错误会重试并给出清晰错误', async () => {
    let unauthorizedCalls = 0
    const unauthorized = new DeepSeekClient(testConfig(), async () => {
      unauthorizedCalls += 1
      return response(401, { error: { message: 'invalid key' } })
    }, async () => {})
    await expect(unauthorized.complete({ messages: [] })).rejects.toThrow(/401.*invalid key/)
    expect(unauthorizedCalls).toBe(1)

    let calls = 0
    const network = new DeepSeekClient(testConfig({ maxRetries: 1 }), async () => {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      return response(200, { choices: [{ message: { content: '恢复' } }] })
    }, async () => {})
    expect((await network.complete({ messages: [] })).content).toBe('恢复')
    expect(calls).toBe(2)
  })
})

describe('结构化输出', () => {
  it('接受代码围栏 JSON', () => {
    expect(parseModelJson('```json\n{"ok":true}\n```')).toEqual({ ok: true })
  })

  it('结构异常时修正重试一次', async () => {
    const llm = new MockLlm((_request, call) => call === 1 ? 'not json' : jsonValue())
    const result = await completeStructured(llm, { messages: [] }, z.object({ ok: z.boolean() }))
    expect(result.data).toEqual({ ok: true })
    expect(llm.requests).toHaveLength(2)
    expect(llm.requests[1]?.messages.at(-1)?.content).toContain('结构校验')
  })
})

function jsonValue(): string {
  return JSON.stringify({ ok: true })
}
