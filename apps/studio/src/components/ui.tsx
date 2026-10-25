import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { answerConfirm, toast, useConfirmState, useToasts } from '../lib/hooks.ts'
import type { ConfirmRequest } from '../lib/hooks.ts'
import { label, statusTone } from '../lib/format.ts'
import type { Tone } from '../lib/format.ts'

export function Badge({ tone = 'muted', children, dot = false }: { tone?: Tone; children: ReactNode; dot?: boolean }) {
  return <span className={`badge badge-${tone}${dot ? ' badge-dot' : ''}`}>{children}</span>
}

export function StatusBadge({ status, text }: { status: string | null | undefined; text?: string }) {
  return <Badge tone={statusTone(status)} dot>{text ?? label(status)}</Badge>
}

export function Card({ title, subtitle, actions, children, tight = false, className = '' }: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  tight?: boolean
  className?: string
}) {
  return (
    <section className={`card${tight ? ' tight' : ''} ${className}`.trim()}>
      {(title || actions) && (
        <header className="card-head">
          <div style={{ minWidth: 0 }}>
            {title && <div className="card-title">{title}</div>}
            {subtitle && <div className="card-sub">{subtitle}</div>}
          </div>
          {actions && <div className="btn-row" style={{ marginLeft: 'auto' }}>{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function SectionTitle({ title, hint, actions }: { title: ReactNode; hint?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      {hint && <span className="hint">{hint}</span>}
      {actions && <div className="btn-row" style={{ marginLeft: 'auto' }}>{actions}</div>}
    </div>
  )
}

export function Field({ label: fieldLabel, hint, children, span = false }: {
  label: ReactNode
  hint?: ReactNode
  children: ReactNode
  span?: boolean
}) {
  return (
    <label className="field" style={span ? { gridColumn: '1 / -1' } : undefined}>
      <span className="field-label">{fieldLabel}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export function Empty({ title, hint, action }: { title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint && <div>{hint}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  )
}

export function Loading({ text = '加载中…' }: { text?: string }) {
  return <div className="loader">{text}</div>
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="error-box">
      <div>{error.message}</div>
      {onRetry && <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={onRetry}>重试</button>}
    </div>
  )
}

export function Stat({ label: statLabel, value, hint, tone, onClick }: {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  tone?: 'accent' | 'ok' | 'warn' | 'danger'
  onClick?: () => void
}) {
  const content = (
    <>
      <div className="stat-label">{statLabel}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </>
  )
  if (onClick) {
    return <button type="button" className={`stat${tone ? ` ${tone}` : ''}`} style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }} onClick={onClick}>{content}</button>
  }
  return <div className={`stat${tone ? ` ${tone}` : ''}`}>{content}</div>
}

export function Tabs<T extends string>({ items, value, onChange }: {
  items: Array<{ key: T; label: ReactNode; count?: number }>
  value: T
  onChange: (key: T) => void
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map(item => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={item.key === value}
          className={`tab${item.key === value ? ' active' : ''}`}
          onClick={() => onChange(item.key)}
        >
          {item.label}
          {item.count !== undefined && <span className="count">{item.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Modal({ open, title, onClose, children, footer, wide = false }: {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head"><h2>{title}</h2><div className="spacer" /><button type="button" className="icon-btn" onClick={onClose}>✕</button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function Kv({ rows }: { rows: Array<{ key: ReactNode; value: ReactNode }> }) {
  return (
    <dl className="kv">
      {rows.map((row, index) => (
        <div key={index} style={{ display: 'contents' }}>
          <dt>{row.key}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function CopyButton({ text, label: textLabel = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="btn btn-sm btn-ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1600)
        } catch {
          toast.error('浏览器拒绝了剪贴板访问。')
        }
      }}
    >
      {copied ? '已复制' : textLabel}
    </button>
  )
}

/** 全局提示与确认框：挂在 App 根部，所有页面共用。 */
export function AppHosts() {
  const toasts = useToasts()
  const confirm = useConfirmState()
  return (
    <>
      <div className="toasts">
        {toasts.map(item => <div key={item.id} className={`toast ${item.kind}`}>{item.message}</div>)}
      </div>
      <ConfirmHost request={confirm} />
    </>
  )
}

function ConfirmHost({ request }: { request: ConfirmRequest | null }) {
  useEffect(() => {
    if (!request) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') answerConfirm(false)
      if (event.key === 'Enter') answerConfirm(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request])
  if (!request) return null
  return (
    <div className="overlay">
      <div className="modal">
        <div className="modal-head"><h2>{request.title}</h2></div>
        <div className="modal-body" style={{ whiteSpace: 'pre-wrap' }}>{request.message}</div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={() => answerConfirm(false)}>取消</button>
          <button type="button" className={`btn ${request.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => answerConfirm(true)}>
            {request.confirmLabel ?? '确认'}
          </button>
        </div>
      </div>
    </div>
  )
}
