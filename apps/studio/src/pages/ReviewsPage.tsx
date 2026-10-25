import { useEffect, useState } from 'react'
import { api } from '../lib/api.ts'
import { toast, useResource } from '../lib/hooks.ts'
import type { PageProps } from '../app/types.ts'
import type { ReviewIssue } from '../lib/types.ts'
import { Badge, Card, Empty, ErrorBox, Loading, SectionTitle, Stat, StatusBadge } from '../components/ui.tsx'
import { formatTime, label, prettyJson, safeJson, severityTone, truncate } from '../lib/format.ts'

const SEVERITY_ORDER: Record<string, number> = { critical: 0, major: 1, minor: 2 }

function toMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function severityRank(severity: string): number {
  return SEVERITY_ORDER[severity] ?? 9
}

export function ReviewsPage({ projectId, navigate }: PageProps) {
  const reviews = useResource(() => api.listReviews(projectId), [projectId])
  const [pickedRunId, setPickedRunId] = useState<string | null>(null)
  useEffect(() => { setPickedRunId(null) }, [projectId])

  const list = reviews.data ?? []
  const selectedRunId = pickedRunId ?? list[0]?.run.id ?? null
  const totals = list.reduce(
    (acc, item) => ({ issues: acc.issues + item.issueCount, open: acc.open + item.openCount }),
    { issues: 0, open: 0 },
  )

  return (
    <div className="stack">
      <SectionTitle
        title="审查报告"
        hint="模型只负责挑问题；每条问题是否成立由你裁决。"
        actions={<button type="button" className="btn btn-sm" onClick={reviews.reload} disabled={reviews.loading}>刷新</button>}
      />

      {reviews.error && <ErrorBox error={reviews.error} onRetry={reviews.reload} />}

      {reviews.loading && !reviews.data ? (
        <Card><Loading text="正在载入审查运行…" /></Card>
      ) : list.length === 0 ? (
        <Empty
          title="还没有审查记录"
          hint="先到章节工作台生成草稿，再对某个版本发起审查；审查结果会按运行记录保存在这里。"
          action={<button type="button" className="btn btn-primary" onClick={() => navigate(`/p/${encodeURIComponent(projectId)}/chapters`)}>去章节工作台</button>}
        />
      ) : (
        <>
          <div className="stat-grid">
            <Stat label="审查运行" value={list.length} hint="按时间倒序" />
            <Stat label="问题总数" value={totals.issues} hint="历次审查累计" />
            <Stat label="未解决" value={totals.open} tone={totals.open > 0 ? 'warn' : 'ok'} hint="open 状态" />
            <Stat label="当前查看" value={list.find(item => item.run.id === selectedRunId)?.chapter.chapterNo ?? '—'} hint="章节号" />
          </div>

          <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 300px', minWidth: 280, maxWidth: 420 }}>
              <Card tight title="审查运行" subtitle={`${list.length} 次`}>
                <div className="list" style={{ maxHeight: '72vh', overflowY: 'auto' }}>
                  {list.map(item => (
                    <button
                      key={item.run.id}
                      type="button"
                      className={`list-item${item.run.id === selectedRunId ? ' selected' : ''}`}
                      onClick={() => setPickedRunId(item.run.id)}
                    >
                      <div className="list-item-main">
                        <div className="list-item-title">
                          <span className="mono muted">第 {item.chapter.chapterNo} 章</span>
                          <span className="truncate">{item.chapter.title}</span>
                        </div>
                        <div className="list-item-meta btn-row" style={{ gap: 8 }}>
                          <StatusBadge status={item.run.status} />
                          <span>{item.issueCount} 问题 · {item.openCount} 未解决</span>
                        </div>
                        <div className="list-item-meta">{formatTime(item.run.createdAt)}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </Card>
            </div>

            <div style={{ flex: '3 1 520px', minWidth: 0 }}>
              {selectedRunId ? (
                <ReviewDetail
                  key={selectedRunId}
                  runId={selectedRunId}
                  projectId={projectId}
                  navigate={navigate}
                  onMutated={reviews.reload}
                />
              ) : (
                <Empty title="从左侧选择一次审查" hint="选中后会显示这次审查的问题清单与正文定位。" />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ReviewDetail({ runId, projectId, navigate, onMutated }: {
  runId: string
  projectId: string
  navigate: (path: string) => void
  onMutated: () => void
}) {
  const detail = useResource(() => api.getReview(runId), [runId])
  const revisionId = detail.data?.run.revisionId ?? ''
  const content = useResource<string>(() => {
    if (!revisionId) return Promise.resolve('')
    return api.getRevision(revisionId).then(revision => revision.content)
  }, [revisionId])
  const [focusedIssueId, setFocusedIssueId] = useState<string | null>(null)
  const [busyIssueId, setBusyIssueId] = useState<string | null>(null)
  useEffect(() => { setFocusedIssueId(null) }, [runId])

  async function resolveIssue(issueId: string, status: 'resolved' | 'wontfix'): Promise<void> {
    setBusyIssueId(issueId)
    try {
      await api.updateIssue(issueId, status)
      toast.ok(status === 'resolved' ? '已标记为「已解决」。' : '已标记为「不修」，不会再计入待处理。')
      detail.reload()
      onMutated()
    } catch (cause) {
      toast.error(toMessage(cause))
    } finally {
      setBusyIssueId(null)
    }
  }

  if (detail.loading && !detail.data) return <Card><Loading text="正在载入审查详情…" /></Card>
  if (detail.error) return <ErrorBox error={detail.error} onRetry={detail.reload} />
  if (!detail.data) return <Empty title="审查详情不可用" hint="这条审查记录可能已被删除。" />

  const { run, chapter, issues } = detail.data
  const sorted = [...issues].sort((left, right) => severityRank(left.severity) - severityRank(right.severity))
  const openCount = issues.filter(issue => issue.resolutionStatus === 'open').length

  return (
    <div className="stack">
      <Card
        title={`第 ${chapter.chapterNo} 章 · ${chapter.title}`}
        subtitle={run.summary || '本次审查没有留下总评。'}
        actions={(
          <>
            <StatusBadge status={run.status} />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => navigate(`/p/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapter.id)}`)}
            >
              打开章节工作台
            </button>
          </>
        )}
      >
        <div className="btn-row small muted" style={{ gap: 14 }}>
          <span>审查于 {formatTime(run.createdAt)}</span>
          <span>问题 {issues.length} 条</span>
          <span className={openCount > 0 ? 'dim' : 'muted'}>未解决 {openCount} 条</span>
          <span>正文 {content.data ? `${content.data.length} 字` : '…'}</span>
        </div>

        {content.error && <div className="hint-box" style={{ marginTop: 10 }}>正文片段未能载入：{content.error.message}</div>}

        {issues.length === 0 ? (
          <div style={{ marginTop: 12 }}>
            <Empty title="这次审查没有发现问题" hint="可以直接到章节工作台把该版本定稿，或继续修改后再审查一次。" />
          </div>
        ) : (
          <div className="stack-sm" style={{ marginTop: 12 }}>
            {sorted.map(issue => (
              <IssueCard
                key={issue.id}
                issue={issue}
                content={content.data ?? ''}
                focused={focusedIssueId === issue.id}
                busy={busyIssueId === issue.id}
                onFocus={() => setFocusedIssueId(previous => (previous === issue.id ? null : issue.id))}
                onResolve={status => { void resolveIssue(issue.id, status) }}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

function IssueCard({ issue, content, focused, busy, onFocus, onResolve }: {
  issue: ReviewIssue
  content: string
  focused: boolean
  busy: boolean
  onFocus: () => void
  onResolve: (status: 'resolved' | 'wontfix') => void
}) {
  const hasRange = issue.locationStart !== null
  const rangeText = hasRange
    ? `${issue.locationStart ?? 0}–${issue.locationEnd ?? issue.locationStart ?? 0} 字`
    : '未标注位置'
  return (
    <div className={`issue-card ${issue.severity}`}>
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <div className="btn-row">
          <Badge tone={severityTone(issue.severity)}>{label(issue.severity)}</Badge>
          <Badge tone="muted">{label(issue.category)}</Badge>
          <StatusBadge status={issue.resolutionStatus} />
        </div>
        <div className="btn-row">
          {hasRange ? (
            <button
              type="button"
              className="issue-loc"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              title="点击查看正文片段"
              onClick={onFocus}
            >
              {rangeText}{focused ? ' · 收起' : ' · 查看片段'}
            </button>
          ) : (
            <span className="issue-loc">{rangeText}</span>
          )}
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || issue.resolutionStatus === 'resolved'}
            onClick={() => onResolve('resolved')}
          >
            已解决
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={busy || issue.resolutionStatus === 'wontfix'}
            onClick={() => onResolve('wontfix')}
          >
            不修
          </button>
        </div>
      </div>

      <div style={{ marginTop: 8, fontSize: 13 }}>{issue.issue}</div>

      <IssueEvidence json={issue.evidenceJson} />

      {issue.suggestedFix && (
        <div className="hint-box" style={{ marginTop: 8 }}>
          <span className="muted small">建议改法：</span>{issue.suggestedFix}
        </div>
      )}

      {focused && <IssueSnippet content={content} start={issue.locationStart} end={issue.locationEnd} />}
    </div>
  )
}

function IssueEvidence({ json }: { json: string }) {
  const parsed = safeJson<unknown>(json, null)
  if (parsed === null) {
    return json ? <pre className="mono" style={PRE_STYLE}>{json}</pre> : null
  }
  const rows: Array<{ key: string; value: string }> = []
  if (Array.isArray(parsed)) {
    parsed.forEach((item, index) => { rows.push({ key: `证据 ${index + 1}`, value: describeValue(item) }) })
  } else if (typeof parsed === 'object') {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      rows.push({ key, value: describeValue(value) })
    }
  } else {
    rows.push({ key: '证据', value: describeValue(parsed) })
  }
  if (rows.length === 0) return null
  return (
    <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
      {rows.map((row, index) => (
        <li key={`${row.key}-${index}`} className="small dim" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          <span className="muted">{row.key}：</span>{truncate(row.value, 320)}
        </li>
      ))}
    </ul>
  )
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') return prettyJson(JSON.stringify(value))
  return String(value)
}

const PRE_STYLE = {
  margin: '8px 0 0',
  padding: '8px 10px',
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--bg-soft)',
  maxHeight: 220,
  overflow: 'auto',
  whiteSpace: 'pre-wrap' as const,
  wordBreak: 'break-word' as const,
  fontSize: 11.5,
  lineHeight: 1.6,
}

function IssueSnippet({ content, start, end }: { content: string; start: number | null; end: number | null }) {
  if (!content || start === null) return null
  const hitStart = Math.min(Math.max(start, 0), content.length)
  const hitEnd = Math.min(Math.max(end ?? hitStart, hitStart), content.length)
  const from = Math.max(0, hitStart - 80)
  const to = Math.min(content.length, hitEnd + 80)
  return (
    <div
      className="hint-box"
      style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
    >
      {from > 0 && <span className="muted">…</span>}
      {content.slice(from, hitStart)}
      <mark style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderBottom: '1px solid var(--accent-line)' }}>
        {content.slice(hitStart, hitEnd) || '（此处为空）'}
      </mark>
      {content.slice(hitEnd, to)}
      {to < content.length && <span className="muted">…</span>}
    </div>
  )
}
