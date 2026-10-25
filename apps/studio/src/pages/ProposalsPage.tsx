import { useMemo, useState } from 'react'
import { api } from '../lib/api.ts'
import { confirmDialog, toast, useResource } from '../lib/hooks.ts'
import type { PageProps } from '../app/types.ts'
import type { ChangeProposal } from '../lib/types.ts'
import { Badge, Card, Empty, ErrorBox, Kv, Loading, SectionTitle, StatusBadge, Tabs } from '../components/ui.tsx'
import { formatTime, label, prettyJson, truncate } from '../lib/format.ts'

type ProposalTab = 'pending' | 'applied' | 'rejected' | 'all'

function toMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function ProposalsPage({ projectId }: PageProps) {
  const proposals = useResource(() => api.listProposals(projectId), [projectId])
  const chapters = useResource(() => api.listChapters(projectId), [projectId])
  const [tab, setTab] = useState<ProposalTab>('pending')
  const [busyId, setBusyId] = useState<string | null>(null)

  const all = proposals.data ?? []
  const counts = useMemo(() => ({
    pending: all.filter(item => item.status === 'pending').length,
    applied: all.filter(item => item.status === 'applied').length,
    rejected: all.filter(item => item.status === 'rejected').length,
    all: all.length,
  }), [all])

  const visible = useMemo(
    () => (tab === 'all' ? all : all.filter(item => item.status === tab)),
    [all, tab],
  )

  const chapterLabel = (chapterId: string | null): string => {
    if (!chapterId) return '—'
    const chapter = (chapters.data ?? []).find(item => item.id === chapterId)
    if (!chapter) return truncate(chapterId, 20)
    return truncate(`第 ${chapter.chapterNo} 章 · ${chapter.title}`, 40)
  }

  async function apply(proposal: ChangeProposal): Promise<void> {
    const confirmed = await confirmDialog({
      title: '应用这条变更提议？',
      message: `应用后立即写入正式资料并记审计日志。\n\n目标：${label(proposal.targetType)} · ${label(proposal.operation)}${proposal.targetId ? ` · ${proposal.targetId}` : ''}\n\n如果正式资料版本已经变化，服务端会拒绝这次应用。`,
      confirmLabel: '应用变更',
    })
    if (!confirmed) return
    setBusyId(proposal.id)
    try {
      await api.applyProposal(proposal.id)
      toast.ok('变更已应用，正式资料已更新并记录审计日志。')
      proposals.reload()
    } catch (cause) {
      toast.error(toMessage(cause))
    } finally {
      setBusyId(null)
    }
  }

  async function reject(proposal: ChangeProposal): Promise<void> {
    const confirmed = await confirmDialog({
      title: '驳回这条变更提议？',
      message: `驳回不会修改任何正式资料，提议会被标记为「已驳回」并保留在历史里。\n\n目标：${label(proposal.targetType)} · ${label(proposal.operation)}`,
      confirmLabel: '驳回提议',
      danger: true,
    })
    if (!confirmed) return
    setBusyId(proposal.id)
    try {
      await api.rejectProposal(proposal.id)
      toast.ok('提议已驳回，未修改正式资料。')
      proposals.reload()
    } catch (cause) {
      toast.error(toMessage(cause))
    } finally {
      setBusyId(null)
    }
  }

  const tabs: Array<{ key: ProposalTab; label: string; count: number }> = [
    { key: 'pending', label: '待审批', count: counts.pending },
    { key: 'applied', label: '已应用', count: counts.applied },
    { key: 'rejected', label: '已驳回', count: counts.rejected },
    { key: 'all', label: '全部', count: counts.all },
  ]

  return (
    <div className="stack">
      <SectionTitle
        title="待审批变更"
        hint="AI 只能提议，应用必须由作者批准。"
        actions={<button type="button" className="btn btn-sm" onClick={() => { proposals.reload(); chapters.reload() }} disabled={proposals.loading}>刷新</button>}
      />

      <div className="notice">
        AI 只能提议：写作、续写、修订过程中发现的人物、事件、伏笔变更都会先落成「提议」。
        只有你点「应用」之后，正式资料才会被写入，并同时记一条审计日志；驳回不会修改任何正式资料。
      </div>

      {proposals.error && <ErrorBox error={proposals.error} onRetry={proposals.reload} />}
      {chapters.error && <div className="hint-box">章节标题暂时载入失败，来源章节将显示为 ID：{chapters.error.message}</div>}

      <div>
        <Tabs items={tabs} value={tab} onChange={setTab} />
      </div>

      {proposals.loading && !proposals.data ? (
        <Card><Loading text="正在载入变更提议…" /></Card>
      ) : visible.length === 0 ? (
        <Empty
          title={tab === 'pending' ? '没有待审批的变更' : '这个状态下没有提议'}
          hint={tab === 'pending'
            ? 'AI 在写作与修订时提出的设定变更会先出现在这里；等它产出提议后再回来审批。'
            : '切换标签可以查看已应用或已驳回的历史提议。'}
        />
      ) : (
        <div className="stack-sm">
          {visible.map(proposal => (
            <Card key={proposal.id} tight>
              <div className="row-wrap" style={{ justifyContent: 'space-between', gap: 10 }}>
                <div className="btn-row">
                  <Badge tone="accent">{label(proposal.targetType)}</Badge>
                  <Badge tone={proposal.operation === 'create' ? 'info' : 'warn'}>{label(proposal.operation)}</Badge>
                  <span className="mono muted small">{proposal.targetId ? truncate(proposal.targetId, 28) : '新对象（暂无 ID）'}</span>
                </div>
                <div className="btn-row">
                  <StatusBadge status={proposal.status} />
                  <span className="tiny muted">{formatTime(proposal.createdAt)}</span>
                </div>
              </div>

              <div style={{ marginTop: 10 }}>
                <Kv rows={[
                  { key: '目标对象', value: `${label(proposal.targetType)}${proposal.targetId ? ` · ${truncate(proposal.targetId, 32)}` : '（新建）'}` },
                  { key: '期望版本', value: proposal.expectedVersion === null ? '不校验' : `v${proposal.expectedVersion}` },
                  { key: '来源章节', value: chapterLabel(proposal.chapterId) },
                  { key: '来源版本', value: proposal.sourceRevisionId ? <span className="mono">{truncate(proposal.sourceRevisionId, 26)}</span> : '—' },
                  { key: '创建时间', value: formatTime(proposal.createdAt) },
                  { key: '应用时间', value: formatTime(proposal.appliedAt) },
                ]} />
              </div>

              <div className="divider" />
              <div className="small muted" style={{ marginBottom: 4 }}>变更内容（payload）</div>
              <pre style={PRE_STYLE}>{prettyJson(proposal.payloadJson)}</pre>

              {proposal.status === 'pending' && (
                <div className="btn-row" style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    disabled={busyId === proposal.id}
                    onClick={() => { void apply(proposal) }}
                  >
                    应用
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    disabled={busyId === proposal.id}
                    onClick={() => { void reject(proposal) }}
                  >
                    驳回
                  </button>
                  <span className="tiny muted">应用会立即写入正式资料并记审计日志。</span>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

const PRE_STYLE = {
  margin: 0,
  padding: '9px 11px',
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--bg-soft)',
  maxHeight: 280,
  overflow: 'auto',
  whiteSpace: 'pre-wrap' as const,
  wordBreak: 'break-word' as const,
  fontFamily: 'var(--mono)',
  fontSize: 11.5,
  lineHeight: 1.6,
  color: 'var(--text-dim)',
}
