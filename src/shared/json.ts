export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
