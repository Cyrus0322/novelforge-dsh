import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PageProps } from '../app/types.ts'
import { api, ApiError } from '../lib/api.ts'
import type { ChangeProposal, IngestBatch, IngestOutcome, IngestStats } from '../lib/types.ts'
import { confirmDialog, toast, useResource } from '../lib/hooks.ts'
import { countWords, formatTime, label, prettyJson, relativeTime, safeJson, truncate } from '../lib/format.ts'
import type { Tone } from '../lib/format.ts'
import { Badge, Card, Empty, ErrorBox, Field, Kv, Loading, SectionTitle, Stat, StatusBadge } from '../components/ui.tsx'

type IngestMode = 'propose' | 'apply'

interface BatchDetail {
  batch: IngestBatch
  proposals: ChangeProposal[]
}

const MIN_MATERIAL_CHARS = 20

const MODE_HINTS: Record<IngestMode, string> = {
  propose: '默认模式：只生成待审批提议，不会直接改正式资料。',
  apply: '整理后立即应用全部提议（会先弹窗确认，并写入审计日志）。',
}

const BATCH_STATUS_LABELS: Record<string, string> = {
  analyzing: '整理中',
  ready: '待审批',
  applying: '应用中',
  applied: '已应用',
  partially_applied: '部分应用',
  failed: '失败',
}

const BATCH_MODE_LABELS: Record<string, string> = {
  propose: '只生成提议',
  apply: '整理并应用',
}

const TARGET_TYPE_LABELS: Record<string, string> = {
  entity: '实体',
  relation: '关系',
  event: '事件',
  foreshadowing: '伏笔',
  thread: '剧情线',
  project: '作品契约',
}

const OPERATION_LABELS: Record<string, string> = {
  create: '新建',
  update: '更新',
}

/** 服务端 quote-or-drop 的丢弃原因码 → 中文说明（只是文案映射，不是示例数据）。 */
const DROP_REASON_LABELS: Record<string, string> = {
  entity_evidence_missing: '实体：原文中找不到对应证据',
  relation_evidence_missing: '关系：原文中找不到对应证据',
  event_evidence_missing: '事件：原文中找不到对应证据',
  foreshadowing_evidence_missing: '伏笔：原文中找不到对应证据',
  thread_evidence_missing: '剧情线：原文中找不到对应证据',
  relation_unknown_entity: '关系：两端人物还不在资料库中',
  entity_proposal_failed: '实体：提议写入失败',
  relation_proposal_failed: '关系：提议写入失败',
  event_proposal_failed: '事件：提议写入失败',
  foreshadowing_proposal_failed: '伏笔：提议写入失败',
  thread_proposal_failed: '剧情线：提议写入失败',
}

const PRE_STYLE: CSSProperties = {
  margin: '6px 0 0',
  padding: '8px 10px',
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--bg-soft)',
  maxHeight: 220,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  fontFamily: 'var(--mono)',
  fontSize: 11.5,
  lineHeight: 1.6,
  color: 'var(--text-dim)',
}

function toMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function isVersionConflict(cause: unknown): boolean {
  return cause instanceof ApiError && (cause.code === 'CONFLICT' || cause.message.includes('版本已变化'))
}

function batchStatusText(status: string): string {
  return BATCH_STATUS_LABELS[status] ?? label(status)
}

function batchTone(status: string): Tone {
  switch (status) {
    case 'ready':
    case 'partially_applied':
      return 'warn'
    case 'applied':
      return 'ok'
    case 'failed':
      return 'danger'
    case 'analyzing':
    case 'applying':
      return 'info'
    default:
      return 'muted'
  }
}

function canApplyBatch(batch: IngestBatch): boolean {
  return batch.status === 'ready' || batch.status === 'partially_applied'
}

function parseStats(json: string): Partial<IngestStats> {
  const parsed = safeJson<unknown>(json, {})
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  return parsed as Partial<IngestStats>
}

function extractedCount(stats: Partial<IngestStats>): number {
  return (stats.entities ?? 0) + (stats.relations ?? 0) + (stats.events ?? 0)
    + (stats.foreshadowing ?? 0) + (stats.threads ?? 0)
}

function statsLine(stats: Partial<IngestStats>): string {
  const parts = [
    `实体 ${stats.entities ?? 0}`,
    `关系 ${stats.relations ?? 0}`,
    `事件 ${stats.events ?? 0}`,
    `伏笔 ${stats.foreshadowing ?? 0}`,
    `剧情线 ${stats.threads ?? 0}`,
    `丢弃 ${stats.dropped ?? 0}`,
    `矛盾 ${stats.conflicts ?? 0}`,
  ]
  if (stats.applied !== undefined) parts.push(`已应用 ${stats.applied}`)
  if (stats.failed !== undefined) parts.push(`失败 ${stats.failed}`)
  return parts.join(' · ')
}

function targetTypeText(targetType: string): string {
  return TARGET_TYPE_LABELS[targetType] ?? label(targetType)
}

function operationText(operation: string): string {
  return OPERATION_LABELS[operation] ?? label(operation)
}

function payloadRecord(json: string): Record<string, unknown> {
  const parsed = safeJson<unknown>(json, {})
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  return parsed as Record<string, unknown>
}

function textField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function firstText(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const text = textField(payload, key)
    if (text) return text
  }
  return ''
}

function shortToken(text: string): string {
  return text ? truncate(text, 16) : '?'
}

function describeProposal(proposal: ChangeProposal): { title: string; meta: string } {
  const payload = payloadRecord(proposal.payloadJson)
  switch (proposal.targetType) {
    case 'entity':
      return {
        title: firstText(payload, 'name') || '（未命名实体）',
        meta: [textField(payload, 'kind'), textField(payload, 'role'), firstText(payload, 'summary', 'goal')]
          .filter(Boolean).join(' · '),
      }
    case 'relation':
      return {
        title: `${shortToken(firstText(payload, 'sourceName', 'sourceId'))} → ${shortToken(firstText(payload, 'targetName', 'targetId'))}`,
        meta: [firstText(payload, 'relationType', 'kind'), firstText(payload, 'tension')].filter(Boolean).join(' · '),
      }
    case 'event':
      return {
        title: firstText(payload, 'summary') || '（未命名事件）',
        meta: [firstText(payload, 'eventTime'), firstText(payload, 'status')].filter(Boolean).join(' · '),
      }
    case 'foreshadowing':
      return {
        title: firstText(payload, 'name') || '（未命名伏笔）',
        meta: [firstText(payload, 'category', 'kind'), firstText(payload, 'description')].filter(Boolean).join(' · '),
      }
    case 'thread':
      return {
        title: firstText(payload, 'name') || '（未命名剧情线）',
        meta: [firstText(payload, 'threadKind', 'kind'), firstText(payload, 'goal')].filter(Boolean).join(' · '),
      }
    default:
      return { title: firstText(payload, 'name', 'summary') || targetTypeText(proposal.targetType), meta: '' }
  }
}

function ProposalRow({ proposal }: { proposal: ChangeProposal }) {
  const description = describeProposal(proposal)
  return (
    <div className="list-item" style={{ cursor: 'default' }}>
      <div className="list-item-main">
        <div className="list-item-title">
          <Badge tone="accent">{targetTypeText(proposal.targetType)}</Badge>
          <Badge tone={proposal.operation === 'create' ? 'info' : 'warn'}>{operationText(proposal.operation)}</Badge>
          <span className="small">{truncate(description.title, 44)}</span>
        </div>
        {description.meta && <div className="list-item-meta">{truncate(description.meta, 160)}</div>}
        <details style={{ marginTop: 4 }}>
          <summary className="tiny muted" style={{ cursor: 'pointer' }}>
            payload · 期望版本 {proposal.expectedVersion === null ? '不校验' : `v${proposal.expectedVersion}`}
          </summary>
          <pre style={PRE_STYLE}>{prettyJson(proposal.payloadJson)}</pre>
        </details>
      </div>
      <StatusBadge status={proposal.status} />
    </div>
  )
}

export function IngestPage({ projectId, navigate }: PageProps) {
  const health = useResource(() => api.health(), [])
  const batches = useResource(() => api.listIngestBatches(projectId), [projectId])
  const [material, setMaterial] = useState('')
  const [title, setTitle] = useState('')
  const [focus, setFocus] = useState('')
  const [mode, setMode] = useState<IngestMode>('propose')
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<IngestOutcome | null>(null)
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null)
  const [applyingId, setApplyingId] = useState<string | null>(null)

  const detail = useResource<BatchDetail | null>(
    () => (selectedBatchId ? api.getIngestBatch(selectedBatchId) : Promise.resolve(null)),
    [selectedBatchId],
  )

  // 切换项目时清掉上一个项目的整理结果与批次选择，避免串项目显示。
  useEffect(() => {
    setOutcome(null)
    setSelectedBatchId(null)
  }, [projectId])

  useEffect(() => {
    if (selectedBatchId !== null || batches.loading) return
    const first = batches.data?.[0]
    if (first) setSelectedBatchId(first.id)
  }, [batches.data, batches.loading, selectedBatchId])

  const batchList = batches.data ?? []
  const trimmedMaterial = material.trim()
  const materialLength = trimmedMaterial.length
  const canSubmit = materialLength >= MIN_MATERIAL_CHARS
  const aiUnavailable = health.data?.hasApiKey === false

  function clearForm(): void {
    setMaterial('')
    setTitle('')
    setFocus('')
    setFormError(null)
  }

  async function startIngest(): Promise<void> {
    if (!canSubmit || submitting || aiUnavailable) return
    if (mode === 'apply') {
      const confirmed = await confirmDialog({
        title: '直接应用本次整理结果？',
        message: '「整理并直接应用」会在 AI 抽完后立刻把提议写入正式资料；版本冲突的条目会失败并保留为待审批。\n\n建议先用「只生成待审批提议」检查一遍，再决定应用。',
        confirmLabel: '继续并应用',
        danger: true,
      })
      if (!confirmed) return
    }
    setSubmitting(true)
    setFormError(null)
    try {
      const result = await api.ingest(projectId, {
        material: trimmedMaterial,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(focus.trim() ? { focus: focus.trim() } : {}),
        mode,
      })
      setOutcome(result)
      if (mode === 'apply' && result.applied) {
        if (result.applied.failed.length > 0) {
          toast.error(`已应用 ${result.applied.applied.length} 条提议，${result.applied.failed.length} 条失败，失败条目仍保留为待审批。`)
        } else {
          toast.ok(`已整理并应用 ${result.applied.applied.length} 条提议，正式资料已更新。`)
        }
      } else {
        toast.ok(`整理完成：生成 ${result.proposals.length} 条待审批提议，未修改正式资料。`)
      }
      batches.reload()
      setSelectedBatchId(result.batch.id)
    } catch (cause) {
      if (isVersionConflict(cause)) {
        toast.error('资料已被其它窗口修改，已刷新')
        batches.reload()
        detail.reload()
      } else {
        const message = toMessage(cause)
        setFormError(message)
        toast.error(message)
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function handleApply(batch: IngestBatch): Promise<void> {
    if (applyingId) return
    let pendingCount = 0
    try {
      const loaded = await api.getIngestBatch(batch.id)
      pendingCount = loaded.proposals.filter(proposal => proposal.status === 'pending').length
    } catch {
      pendingCount = 0
    }
    if (pendingCount === 0) {
      toast.info('这个批次没有待审批的提议，无需应用。')
      return
    }
    const confirmed = await confirmDialog({
      title: '应用整个导入批次？',
      message: `批次「${batch.title || '未命名素材'}」里有 ${pendingCount} 条待审批提议。应用后会把它们逐条写入正式资料并记录审计日志；版本冲突的条目会失败并保留为待审批。\n\n建议先展开每条提议的 payload 检查一遍。`,
      confirmLabel: '应用全部',
      danger: true,
    })
    if (!confirmed) return
    setApplyingId(batch.id)
    try {
      const result = await api.applyIngestBatch(batch.id)
      if (result.failed.length > 0) {
        toast.error(`已应用 ${result.applied.length} 条，${result.failed.length} 条失败（多数是版本冲突），失败条目仍保留为待审批。`)
      } else {
        toast.ok(`已将 ${result.applied.length} 条提议写入正式资料，并记录审计日志。`)
      }
      batches.reload()
      detail.reload()
    } catch (cause) {
      if (isVersionConflict(cause)) {
        toast.error('资料已被其它窗口修改，已刷新')
        batches.reload()
        detail.reload()
      } else {
        toast.error(toMessage(cause))
      }
    } finally {
      setApplyingId(null)
    }
  }

  const detailData = detail.data
  const detailProposals = detailData?.proposals ?? []
  const pendingProposals = detailProposals.filter(proposal => proposal.status === 'pending').length
  const appliedProposals = detailProposals.filter(proposal => proposal.status === 'applied').length
  const rejectedProposals = detailProposals.filter(proposal => proposal.status === 'rejected').length
  const outcomeStats = outcome?.stats ?? null

  return (
    <div className="stack">
      <SectionTitle title="素材导入" hint="把素材变成可审批的结构化资料，不会直接改正式资料" />

      <div className="notice">
        AI 只抽素材里写明的内容，每条都要能在原文找到证据（找不到证据的条目会被丢弃，不会写进资料库）。
        默认生成待审批提议，不会直接改正式资料；只有你确认「应用」之后，正式资料才会更新并记审计日志。
      </div>

      <div className="split">
        <Card title="粘贴素材" subtitle="长文节选、作者手记、设定文档都可以，越具体越好">
          <div className="stack-sm">
            <div className="grid-2">
              <Field label="标题（可选）" hint="不填会记为「未命名素材」，只影响批次列表显示。">
                <input
                  className="input"
                  value={title}
                  placeholder="例如：第 12–15 章作者手记"
                  onChange={event => setTitle(event.target.value)}
                />
              </Field>
              <Field label="模式" hint={MODE_HINTS[mode]}>
                <select
                  className="select"
                  value={mode}
                  onChange={event => setMode(event.target.value === 'apply' ? 'apply' : 'propose')}
                >
                  <option value="propose">只生成待审批提议</option>
                  <option value="apply">整理并直接应用</option>
                </select>
              </Field>
            </div>

            <Field label="整理重点（可选）" hint="只抽你关心的部分，例如「只抽人物动机与人物关系，忽略境界等级」。">
              <input
                className="input"
                value={focus}
                placeholder="例如：只抽人物动机与人物关系"
                onChange={event => setFocus(event.target.value)}
              />
            </Field>

            <Field
              label="素材原文"
              hint={`至少 ${MIN_MATERIAL_CHARS} 字；超过约 12000 tokens 会被截断后再整理（服务端保护上下文预算）。`}
            >
              <textarea
                className="textarea prose-input"
                value={material}
                spellCheck={false}
                placeholder="把素材粘贴到这里：章节节选、逐章剧情摘要、人物小传、世界观设定……"
                onChange={event => setMaterial(event.target.value)}
              />
            </Field>

            <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
              <div className="row-wrap">
                <Badge tone={canSubmit ? 'ok' : 'muted'}>{countWords(trimmedMaterial)} 字</Badge>
                <span className="tiny muted">
                  {canSubmit ? '满足最小长度' : `至少 ${MIN_MATERIAL_CHARS} 字，当前 ${materialLength} 字`}
                </span>
              </div>
              <span className="tiny muted">实体 / 关系 / 事件 / 伏笔 / 剧情线都会先落成提议</span>
            </div>

            {aiUnavailable && (
              <div className="hint-box">
                <strong>AI 不可用：</strong>
                需要设置环境变量 <span className="mono">DEEPSEEK_API_KEY</span> 并重启本地服务，才能调用素材整理。
                当前「开始整理」按钮已置灰。
              </div>
            )}
            {health.error && <ErrorBox error={health.error} onRetry={health.reload} />}
            {formError && <div className="error-box">{formError}</div>}

            <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-sm"
                disabled={submitting || (!material && !title && !focus)}
                onClick={clearForm}
              >
                清空
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={submitting || aiUnavailable || !canSubmit}
                onClick={() => { void startIngest() }}
              >
                {submitting ? '整理中…' : '开始整理'}
              </button>
            </div>
          </div>
        </Card>

        <Card
          title="本次整理结果"
          subtitle={outcome ? `${BATCH_MODE_LABELS[outcome.batch.mode] ?? outcome.batch.mode} · ${formatTime(outcome.batch.createdAt)}` : '整理完成前这里是空的'}
          actions={outcome ? <Badge tone={batchTone(outcome.batch.status)} dot>{batchStatusText(outcome.batch.status)}</Badge> : undefined}
        >
          {!outcome || !outcomeStats ? (
            <Empty
              title="还没有整理结果"
              hint="在左侧粘贴素材、选择模式后点「开始整理」。AI 只抽原文写明的内容，找不到证据的条目会被丢弃。"
            />
          ) : (
            <div className="stack-sm">
              <div className="stat-grid">
                <Stat label="实体" value={outcomeStats.entities} />
                <Stat label="关系" value={outcomeStats.relations} />
                <Stat label="事件" value={outcomeStats.events} />
                <Stat label="伏笔" value={outcomeStats.foreshadowing} />
                <Stat label="剧情线" value={outcomeStats.threads} />
                <Stat label="丢弃" value={outcomeStats.dropped} tone={outcomeStats.dropped > 0 ? 'warn' : undefined} />
                <Stat label="内部矛盾" value={outcomeStats.conflicts} tone={outcomeStats.conflicts > 0 ? 'danger' : undefined} />
              </div>

              {outcomeStats.projectPatch > 0 && (
                <div className="tiny muted">同时整理了作品契约字段（故事前提 / 文风 / POV / 时态 / 主题）。</div>
              )}
              {outcome.applied && (
                <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
                  <span className="tiny muted">应用结果</span>
                  <span className="row-wrap">
                    <Badge tone="ok">成功 {outcome.applied.applied.length}</Badge>
                    <Badge tone={outcome.applied.failed.length > 0 ? 'danger' : 'muted'}>失败 {outcome.applied.failed.length}</Badge>
                  </span>
                </div>
              )}

              {outcomeStats.dropped > 0 && (
                <details className="hint-box" style={{ padding: '8px 10px' }}>
                  <summary className="small" style={{ cursor: 'pointer' }}>
                    被丢弃 {outcomeStats.dropped} 条 · 展开原因
                  </summary>
                  <div className="stack-sm" style={{ marginTop: 8 }}>
                    {Object.entries(outcomeStats.droppedReasons).length === 0 ? (
                      <span className="tiny muted">没有原因明细。</span>
                    ) : (
                      Object.entries(outcomeStats.droppedReasons).map(([reason, count]) => (
                        <div key={reason} className="row-wrap" style={{ justifyContent: 'space-between' }}>
                          <span className="tiny dim">{DROP_REASON_LABELS[reason] ?? reason}</span>
                          <Badge tone="muted">{count}</Badge>
                        </div>
                      ))
                    )}
                  </div>
                </details>
              )}

              {outcomeStats.conflicts > 0 && (
                <div className="notice">
                  <div className="row-wrap" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                    <strong className="small">素材内部矛盾 {outcomeStats.conflicts} 处</strong>
                    <Badge tone="danger">需人工判断</Badge>
                  </div>
                  <div className="stack-sm">
                    {(outcomeStats.conflictList ?? []).length === 0 && (
                      <span className="tiny muted">服务端只返回了矛盾数量，没有提供明细。</span>
                    )}
                    {(outcomeStats.conflictList ?? []).map((conflict, index) => (
                      <div key={`${conflict.type}-${index}`}>
                        <div className="tiny" style={{ color: 'var(--text-dim)' }}>
                          {targetTypeText(conflict.type)}：{conflict.description}
                        </div>
                        {conflict.evidence && <div className="tiny muted">证据：{truncate(conflict.evidence, 140)}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {outcome.proposals.length > 0 && (
                <div>
                  <div className="small muted" style={{ marginBottom: 4 }}>本批提议（{outcome.proposals.length}）</div>
                  <div className="stack-sm">
                    {outcome.proposals.slice(0, 6).map(proposal => {
                      const description = describeProposal(proposal)
                      return (
                        <div key={proposal.id} className="row-wrap" style={{ justifyContent: 'space-between' }}>
                          <span className="tiny dim">
                            {targetTypeText(proposal.targetType)} · {operationText(proposal.operation)} · {truncate(description.title, 18)}
                          </span>
                          <StatusBadge status={proposal.status} />
                        </div>
                      )
                    })}
                    {outcome.proposals.length > 6 && (
                      <span className="tiny muted">还有 {outcome.proposals.length - 6} 条，见下方批次详情。</span>
                    )}
                  </div>
                  {outcome.proposals.some(proposal => proposal.status === 'pending') && (
                    <div style={{ marginTop: 8 }}>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => navigate(`/p/${encodeURIComponent(projectId)}/proposals`)}
                      >
                        去待审批变更
                      </button>
                    </div>
                  )}
                </div>
              )}

              <div className="tiny muted">
                {outcomeStats.truncated ? '素材超长已截断后整理；' : ''}
                {outcomeStats.estimatedTokens !== undefined ? `估算 ${outcomeStats.estimatedTokens} tokens。` : ''}
              </div>
            </div>
          )}
        </Card>
      </div>

      <SectionTitle
        title="导入批次"
        hint="每次整理都会留下批次与提议清单；未应用的提议会一直保留，等应用或驳回。"
        actions={(
          <button
            type="button"
            className="btn btn-sm"
            disabled={batches.loading}
            onClick={() => { batches.reload(); detail.reload() }}
          >
            刷新
          </button>
        )}
      />

      <Card tight>
        {batches.loading && !batches.data ? (
          <Loading text="正在载入导入批次…" />
        ) : batches.error ? (
          <ErrorBox error={batches.error} onRetry={batches.reload} />
        ) : batchList.length === 0 ? (
          <Empty
            title="还没有导入批次"
            hint="在左侧粘贴一段素材并点「开始整理」，这里会出现第一次导入；之后可以回来审批或应用。"
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>素材</th>
                <th>模式</th>
                <th>状态</th>
                <th style={{ textAlign: 'right' }}>抽取</th>
                <th>时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {batchList.map(batch => {
                const stats = parseStats(batch.statsJson)
                const selected = batch.id === selectedBatchId
                return (
                  <tr
                    key={batch.id}
                    style={{ cursor: 'pointer', background: selected ? 'var(--accent-soft)' : undefined }}
                    onClick={() => setSelectedBatchId(batch.id)}
                  >
                    <td>
                      <div className="small">{truncate(batch.title || '未命名素材', 34)}</div>
                      <div className="tiny muted">{batch.sourceText.length} 字素材</div>
                    </td>
                    <td><span className="small dim">{BATCH_MODE_LABELS[batch.mode] ?? batch.mode}</span></td>
                    <td><Badge tone={batchTone(batch.status)} dot>{batchStatusText(batch.status)}</Badge></td>
                    <td className="num small">{extractedCount(stats)}</td>
                    <td className="small muted" title={formatTime(batch.createdAt)}>{relativeTime(batch.createdAt)}</td>
                    <td>
                      <div className="btn-row">
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={event => { event.stopPropagation(); setSelectedBatchId(batch.id) }}
                        >
                          查看
                        </button>
                        {canApplyBatch(batch) && (
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            disabled={applyingId !== null}
                            onClick={event => { event.stopPropagation(); void handleApply(batch) }}
                          >
                            {applyingId === batch.id ? '应用中…' : '应用全部'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>

      {selectedBatchId && (
        <Card
          title={detailData ? `批次详情：${truncate(detailData.batch.title || '未命名素材', 40)}` : '批次详情'}
          subtitle={detailData ? `${BATCH_MODE_LABELS[detailData.batch.mode] ?? detailData.batch.mode} · 创建于 ${formatTime(detailData.batch.createdAt)}` : '正在载入…'}
          actions={detailData && canApplyBatch(detailData.batch) ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={applyingId !== null}
              onClick={() => { void handleApply(detailData.batch) }}
            >
              {applyingId === detailData.batch.id ? '应用中…' : '应用全部'}
            </button>
          ) : undefined}
        >
          {detail.loading && !detailData ? (
            <Loading text="正在载入批次提议…" />
          ) : detail.error ? (
            <ErrorBox error={detail.error} onRetry={detail.reload} />
          ) : !detailData ? (
            <Empty title="还没有选择批次" hint="点上方任意批次查看它留下的提议。" />
          ) : (
            <div className="stack-sm">
              <Kv rows={[
                { key: '批次 ID', value: <span className="mono">{truncate(detailData.batch.id, 26)}</span> },
                { key: '状态', value: <Badge tone={batchTone(detailData.batch.status)} dot>{batchStatusText(detailData.batch.status)}</Badge> },
                { key: '模型', value: detailData.batch.model || '—' },
                { key: '整理重点', value: detailData.batch.focus || '—' },
                { key: '应用时间', value: formatTime(detailData.batch.appliedAt) },
                { key: '素材长度', value: `${detailData.batch.sourceText.length} 字 · ${countWords(detailData.batch.sourceText)} 词/字` },
                { key: '抽取统计', value: statsLine(parseStats(detailData.batch.statsJson)) },
              ]} />

              {detailData.batch.error && <div className="error-box">{detailData.batch.error}</div>}

              <details>
                <summary className="tiny muted" style={{ cursor: 'pointer' }}>素材原文（前 400 字）</summary>
                <div className="small dim" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
                  {truncate(detailData.batch.sourceText, 400)}
                </div>
              </details>

              <div className="divider" />

              <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
                <span className="small muted">本批提议（{detailProposals.length}）</span>
                <span className="tiny muted">
                  待审批 {pendingProposals} · 已应用 {appliedProposals} · 已驳回 {rejectedProposals}
                </span>
              </div>

              {detailProposals.length === 0 ? (
                <Empty
                  title="这个批次没有留下提议"
                  hint="可能素材里没有能找到原文证据的条目（全部被丢弃），或整理在调用模型时失败了。"
                />
              ) : (
                <div className="list scroll-y">
                  {detailProposals.map(proposal => <ProposalRow key={proposal.id} proposal={proposal} />)}
                </div>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
