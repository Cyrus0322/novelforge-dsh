import type { z } from 'zod'
import type { ChatMessage, CompletionRequest, CompletionResult, LlmClient } from './client.js'
import { LlmError } from './client.js'

export function parseModelJson(content: string): unknown {
  const trimmed = content.trim()
  const candidates = [trimmed]
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenced?.[1]) candidates.push(fenced[1].trim())
  const firstObject = trimmed.indexOf('{')
  const lastObject = trimmed.lastIndexOf('}')
  if (firstObject >= 0 && lastObject > firstObject) candidates.push(trimmed.slice(firstObject, lastObject + 1))
  const firstArray = trimmed.indexOf('[')
  const lastArray = trimmed.lastIndexOf(']')
  if (firstArray >= 0 && lastArray > firstArray) candidates.push(trimmed.slice(firstArray, lastArray + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // Try the next safe extraction candidate.
    }
  }
  throw new LlmError('模型输出不是可解析的 JSON。', 'INVALID_STRUCTURED_OUTPUT', false)
}

export async function completeStructured<T>(
  client: LlmClient,
  request: CompletionRequest,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<{ data: T; raw: CompletionResult }> {
  let lastError: unknown
  const messages: ChatMessage[] = [...request.messages]
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await client.complete({ ...request, messages, json: true }, signal)
    try {
      return { data: schema.parse(parseModelJson(raw.content)), raw }
    } catch (error) {
      lastError = error
      if (attempt === 0) {
        messages.push(
          { role: 'assistant', content: raw.content.slice(0, 4000) },
          { role: 'user', content: `上次输出未通过结构校验：${error instanceof Error ? error.message : String(error)}。请仅返回修正后的完整 JSON，不要解释。` },
        )
      }
    }
  }
  throw new LlmError(
    `模型连续两次未返回符合约定的结构化结果：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    'INVALID_STRUCTURED_OUTPUT', false,
  )
}
