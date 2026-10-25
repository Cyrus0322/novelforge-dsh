const STATUS_LABELS: Record<string, string> = {
  active: '进行中',
  paused: '已暂停',
  archived: '已归档',
  planned: '计划中',
  context_ready: '上下文就绪',
  chapter_planned: '章节已规划',
  draft: '草稿',
  draft_generated: '草稿已生成',
  manual_draft: '人工草稿',
  reviewing: '审查中',
  revising: '修订中',
  validated: '已复检',
  awaiting_approval: '待定稿',
  needs_author_decision: '待作者决策',
  finalized: '已定稿',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  open: '打开',
  resolved: '已解决',
  wontfix: '不修',
  abandoned: '已废弃',
  reinforced: '已强化',
  payoff: '已回收',
  confirmed: '已确认',
  cancelled: '已取消',
  pending: '待审批',
  applied: '已应用',
  rejected: '已驳回',
  passed: '通过',
  issues_found: '发现问题',
  reviewed: '已审查',
  planned_event: '计划事件',
  volume: '卷',
  chapter: '章',
  character: '人物',
  world_rule: '世界规则',
  location: '地点',
  faction: '势力',
  item: '物品',
  ability: '能力',
  other: '其他',
  entity: '实体',
  event: '事件',
  foreshadowing: '伏笔',
  critical: '致命',
  major: '严重',
  minor: '轻微',
  continuity: '连续性',
  causality: '因果',
  character_consistency: '人物',
  plot: '剧情',
  style: '文风',
  foreshadow: '伏笔',
  manual: '人工',
  revise: '修订',
  rewrite: '改写',
  continue: '续写',
  rollback: '回滚',
}

export function label(value: string | null | undefined): string {
  if (!value) return '—'
  return STATUS_LABELS[value] ?? value
}

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'muted' | 'accent'

export function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'finalized':
    case 'confirmed':
    case 'completed':
    case 'resolved':
    case 'passed':
    case 'applied':
    case 'active':
    case 'reinforced':
      return 'ok'
    case 'awaiting_approval':
    case 'needs_author_decision':
    case 'issues_found':
    case 'revising':
    case 'reviewing':
    case 'pending':
    case 'draft':
    case 'draft_generated':
    case 'manual_draft':
      return 'warn'
    case 'failed':
    case 'rejected':
    case 'critical':
      return 'danger'
    case 'major':
    case 'open':
    case 'planned':
      return 'info'
    case 'minor':
    case 'wontfix':
    case 'abandoned':
    case 'cancelled':
    case 'archived':
      return 'muted'
    default:
      return 'muted'
  }
}

export function severityTone(severity: string): Tone {
  if (severity === 'critical') return 'danger'
  if (severity === 'major') return 'warn'
  return 'muted'
}

const pad = (value: number): string => String(value).padStart(2, '0')

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const delta = Date.now() - date.getTime()
  const minute = 60_000
  if (delta < minute) return '刚刚'
  if (delta < 60 * minute) return `${Math.floor(delta / minute)} 分钟前`
  if (delta < 24 * 60 * minute) return `${Math.floor(delta / (60 * minute))} 小时前`
  if (delta < 30 * 24 * 60 * minute) return `${Math.floor(delta / (24 * 60 * minute))} 天前`
  return formatTime(iso).slice(0, 10)
}

/** 中文按字计，英文按词计，用于正文工作量估算。 */
export function countWords(text: string): number {
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/g)?.length ?? 0
  const latin = text.replace(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/g, ' ').match(/[A-Za-z0-9_'-]+/g)?.length ?? 0
  return cjk + latin
}

export function safeJson<T = unknown>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export function prettyJson(text: string | null | undefined): string {
  const value = safeJson<unknown>(text, null)
  return value === null ? (text ?? '') : JSON.stringify(value, null, 2)
}

/** diff 的逐行 change 列表 → 带行号的行数组，便于渲染红绿对照。 */
export interface DiffLine {
  kind: 'added' | 'removed' | 'context'
  text: string
  leftNo: number | null
  rightNo: number | null
}

export function toDiffLines(changes: Array<{ value: string; added?: boolean; removed?: boolean }>): DiffLine[] {
  const lines: DiffLine[] = []
  let leftNo = 0
  let rightNo = 0
  for (const change of changes) {
    const parts = change.value.split('\n')
    if (parts.at(-1) === '') parts.pop()
    for (const text of parts) {
      if (change.added) {
        rightNo += 1
        lines.push({ kind: 'added', text, leftNo: null, rightNo })
      } else if (change.removed) {
        leftNo += 1
        lines.push({ kind: 'removed', text, leftNo, rightNo: null })
      } else {
        leftNo += 1
        rightNo += 1
        lines.push({ kind: 'context', text, leftNo, rightNo })
      }
    }
  }
  return lines
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

export function download(filename: string, content: string, type = 'text/markdown;charset=utf-8'): void {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
