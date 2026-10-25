import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface ResourceState<T> {
  data: T | null
  error: Error | null
  loading: boolean
  reload: () => void
  setData: (next: T) => void
  setLocal: (updater: (previous: T | null) => T | null) => void
}

/** 统一的异步数据加载：切换项目/章节时自动取消，避免竞态覆盖新数据。 */
export function useResource<T>(load: () => Promise<T>, deps: readonly unknown[]): ResourceState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void loadRef.current()
      .then(result => {
        if (!cancelled) setData(result)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause : new Error(String(cause)))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  const reload = useCallback(() => setTick(value => value + 1), [])
  const setLocal = useCallback((updater: (previous: T | null) => T | null) => {
    setData(previous => updater(previous))
  }, [])
  return { data, error, loading, reload, setData, setLocal }
}

// ── 哈希路由：#/p/:projectId/chapters/:chapterId ────────────────────────────

function parseHash(): string[] {
  const raw = window.location.hash.replace(/^#\/?/, '')
  return raw.split('/').filter(Boolean).map(decodeURIComponent)
}

export interface Router {
  segments: string[]
  navigate: (path: string, replace?: boolean) => void
}

export function useHashRoute(): Router {
  const [segments, setSegments] = useState<string[]>(() => parseHash())
  useEffect(() => {
    const onChange = (): void => setSegments(parseHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  const navigate = useCallback((path: string, replace = false) => {
    const target = path.startsWith('#') ? path : `#${path.startsWith('/') ? '' : '/'}${path}`
    if (replace) {
      window.history.replaceState(null, '', target)
      setSegments(parseHash())
    } else if (window.location.hash === target) {
      setSegments(parseHash())
    } else {
      window.location.hash = target
    }
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  }, [])
  return useMemo(() => ({ segments, navigate }), [segments, navigate])
}

// ── 轻量提示与确认框（无第三方依赖）─────────────────────────────────────────

export type ToastKind = 'ok' | 'error' | 'info'
export interface ToastItem { id: number; kind: ToastKind; message: string }

let toastId = 0
const toastListeners = new Set<(items: ToastItem[]) => void>()
let toastItems: ToastItem[] = []

function emit(): void {
  for (const listener of toastListeners) listener([...toastItems])
}

function push(kind: ToastKind, message: string): void {
  const item = { id: (toastId += 1), kind, message }
  toastItems = [...toastItems, item].slice(-4)
  emit()
  window.setTimeout(() => {
    toastItems = toastItems.filter(entry => entry.id !== item.id)
    emit()
  }, kind === 'error' ? 7000 : 3200)
}

export const toast = {
  ok: (message: string) => push('ok', message),
  error: (message: string) => push('error', message),
  info: (message: string) => push('info', message),
}

export function useToasts(): ToastItem[] {
  const [items, setItems] = useState<ToastItem[]>(toastItems)
  useEffect(() => {
    toastListeners.add(setItems)
    return () => { toastListeners.delete(setItems) }
  }, [])
  return items
}

export interface ConfirmRequest {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
}

let confirmResolve: ((value: boolean) => void) | null = null
const confirmListeners = new Set<(request: ConfirmRequest | null) => void>()
let confirmRequest: ConfirmRequest | null = null

export function confirmDialog(request: ConfirmRequest): Promise<boolean> {
  confirmRequest = request
  for (const listener of confirmListeners) listener(confirmRequest)
  return new Promise<boolean>(resolvePromise => { confirmResolve = resolvePromise })
}

export function answerConfirm(value: boolean): void {
  confirmRequest = null
  for (const listener of confirmListeners) listener(null)
  confirmResolve?.(value)
  confirmResolve = null
}

export function useConfirmState(): ConfirmRequest | null {
  const [request, setRequest] = useState<ConfirmRequest | null>(confirmRequest)
  useEffect(() => {
    confirmListeners.add(setRequest)
    return () => { confirmListeners.delete(setRequest) }
  }, [])
  return request
}
