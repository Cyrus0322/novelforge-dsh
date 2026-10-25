import type { CompletionRequest, CompletionResult, LlmClient } from '../src/llm/client.js'
import { DEFAULT_CONFIG } from '../src/shared/config.js'
import type { RuntimeConfig } from '../src/shared/config.js'

export class MockLlm implements LlmClient {
  readonly requests: CompletionRequest[] = []
  constructor(private readonly handler: (request: CompletionRequest, call: number) => string | CompletionResult) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(request)
    const result = this.handler(request, this.requests.length)
    return typeof result === 'string' ? { content: result, model: 'mock' } : result
  }
}

export function testConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    ...DEFAULT_CONFIG,
    databasePath: ':memory:',
    apiKey: 'test-key',
    retryBaseDelayMs: 1,
    maxRetries: 1,
    ...overrides,
  }
}

export function json(value: unknown): string {
  return JSON.stringify(value)
}

export const oneChapterOutline = {
  volumes: [{
    title: '第一卷',
    summary: '开端',
    chapters: [{ title: '雨夜', summary: '主角进城', goal: '建立目标', conflict: '身份受阻', hook: '发现追踪者' }],
  }],
}

export const emptyReview = { summary: '未发现阻断问题。', issues: [] }
