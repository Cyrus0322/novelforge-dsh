export type NovelForgeErrorCode =
  | 'CONFIG_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'APPROVAL_REQUIRED'
  | 'INVALID_INPUT'
  | 'WORKFLOW_ERROR'
  | 'LLM_ERROR'

export class NovelForgeError extends Error {
  readonly code: NovelForgeErrorCode
  readonly details?: unknown

  constructor(code: NovelForgeErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'NovelForgeError'
    this.code = code
    this.details = details
  }
}

export function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new NovelForgeError('INVALID_INPUT', `${field} 不能为空。`)
  }
  return normalized
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
