import { useMemo } from 'react'
import { api } from '../lib/api.ts'
import type { PageProps } from '../app/types.ts'
import type { ControlCenter, Foreshadowing, IngestStats } from '../lib/types.ts'
import { useResource } from '../lib/hooks.ts'
import { countWords, formatTime, label, relativeTime, safeJson, severityTone, statusTone, truncate } from '../lib/format.ts'
import type { Tone } from '../lib/format.ts'
import { Badge, Card, Empty, ErrorBox, Kv, Loading, SectionTitle, Stat, StatusBadge } from '../components/ui.tsx'

const THREAD_KIND_LABELS: Record<string, string> = {
  main: '主线',
  sub: '支线',
  romance: '感情线',
  mystery: '悬疑线',
  revenge: '复仇线',
  growth: '成长线',
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

function threadKindText(kind: string): string {
  return THREAD_KIND_LABELS[kind] ?? label(kind)
}

function threadKindTone(kind: string): Tone {
  switch (kind) {
    case 'main':
      return 'accent'
    case 'sub':
      return 'info'
    case 'romance':
    case 'mystery':
    case 'revenge':
    case 'growth':
      return 'muted'
    default:
      return 'muted'
  }
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

function parseStats(json: string): Partial<IngestStats> {
  const parsed = safeJson<unknown>(json, {})
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  return parsed as Partial<IngestStats>
}

function extractedCount(stats: Partial<IngestStats>): number {
  return (stats.entities ?? 0) + (stats.relations ?? 0) + (stats.events ?? 0)
    + (stats.foreshadowing ?? 0) + (stats.threads ?? 0)
}

// ── 创作控制台 ───────────────────────────────────────────

const AUDIT_LABELS: Record<string, string> = {
  'chapter.create': '新建章节',
  'chapter.update': '更新章节',
  'chapter.plan': '规划章节',
  'chapter.finalize': '定稿',
  'chapter.finalize_manual': '人工定稿',
  'entity.create': '新建实体',
  'entity.update': '更新实体',
  'entity.apply_proposal': '应用实体变更',
  'event.create': '新建事件',
  'event.update': '更新事件',
  'event.apply_proposal': '应用事件变更',
  'foreshadowing.create': '埋设伏笔',
  'foreshadowing.update': '更新伏笔',
  'foreshadowing.deadline': '设置最晚回收章',
  'foreshadowing.apply_proposal': '应用伏笔变更',
  'relation.create': '新建关系',
  'relation.update': '更新关系',
  'relation.delete': '删除关系',
  'relation.apply_proposal': '应用关系变更',
  'thread.create': '新建剧情线',
  'thread.update': '更新剧情线',
  'thread.delete': '删除剧情线',
  'thread.apply_proposal': '应用剧情线变更',
  'knowledge.create': '新建知情事实',
  'knowledge.update': '更新知情事实',
  'knowledge.delete': '删除知情事实',
  'outline.update': '更新大纲',
  'scene.create': '新建场景',
  'scene.update': '更新场景',
  'scene.delete': '删除场景',
  'review.create': '发起审查',
  'issue.update': '处理审查问题',
  'proposal.create': '生成变更提议',
  'proposal.reject': '驳回变更提议',
  'ingest.create': '素材整理',
  'ingest.apply': '应用素材批次',
  'project.create': '新建项目',
  'project.update': '更新项目',
}

type ForeshadowingWithDeadline = Foreshadowing & { deadlineChapterId?: number | null }

function deadlineChapterNo(item: Foreshadowing): number | null {
  const value = (item as ForeshadowingWithDeadline).deadlineChapterId
  return typeof value === 'number' && value > 0 ? value : null
}

function auditText(action: string): string {
  return AUDIT_LABELS[action] ?? action
}

/** Dashboard 顶部的「创作控制台」：进度、伏笔风险、卡点、审计与工作流。 */
function ControlCenterBlock({ control, goto, openChapter }: {
  control: ControlCenter
  goto: (path: string) => void
  openChapter: (chapterId: string) => void
}) {
  const { progress, overdue, dueSoon, stalledThreads, needsDecisionChapters, unreviewedChapters, workflows, recentAudit } = control
  const target = progress.targetChapters > 0
    ? progress.targetChapters
    : Math.max(progress.totalChapters, progress.currentChapterNo + 1)
  const percent = Math.min(100, Math.round((progress.currentChapterNo / Math.max(target, 1)) * 100))

  return (
    <div className="stack">
      <div className="stat-grid">
        <Stat
          label="当前进度"
          value={`第 ${progress.currentChapterNo} 章`}
          hint={<div className="meter" style={{ marginTop: 6 }}><span style={{ width: `${percent}%` }} /></div>}
          tone="accent"
          onClick={() => goto('chapters')}
        />
        <Stat label="已定稿" value={`${progress.finalizedCount} / ${progress.totalChapters}`} hint={`定稿 ${progress.finalizedWords.toLocaleString()} 字`} />
        <Stat label="正文总字数" value={progress.totalWords.toLocaleString()} hint={progress.targetChapters > 0 ? `目标 ${progress.targetChapters} 章` : '目标章数未设定'} />
        <Stat
          label="待决策章节"
          value={needsDecisionChapters.length}
          hint="待定稿 / 待作者决策"
          tone={needsDecisionChapters.length > 0 ? 'warn' : undefined}
          onClick={() => goto('chapters')}
        />
        <Stat
          label="停滞剧情线"
          value={stalledThreads.length}
          hint="5 章未推进或未落到章节"
          tone={stalledThreads.length > 0 ? 'warn' : undefined}
          onClick={() => goto('entities')}
        />
        <Stat label="待审批变更" value={control.pendingProposals} tone={control.pendingProposals > 0 ? 'warn' : undefined} onClick={() => goto('proposals')} />
        <Stat
          label="工作流"
          value={`${workflows.running} 运行中`}
          hint={`失败 ${workflows.failed}`}
          tone={workflows.failed > 0 ? 'danger' : undefined}
          onClick={() => goto('workflows')}
        />
      </div>

      <div className="grid-2">
        <Card
          title="伏笔风险"
          subtitle="逾期会在写作上下文里标红，3 章内到期的会提前提醒"
          actions={<button type="button" className="btn btn-sm btn-ghost" onClick={() => goto('foreshadowing')}>管理伏笔</button>}
        >
          {overdue.length === 0 && dueSoon.length === 0 ? (
            <div className="small muted">没有逾期或临期的伏笔。</div>
          ) : (
            <div className="stack-sm">
              {overdue.length > 0 && (
                <div className="stack-sm">
                  <span className="tiny" style={{ color: 'var(--danger)' }}>逾期 {overdue.length} 条</span>
                  {overdue.slice(0, 6).map(item => {
                    const deadline = deadlineChapterNo(item)
                    return (
                      <div key={item.id} className="row-wrap" style={{ justifyContent: 'space-between' }}>
                        <span className="small" style={{ color: '#f0a49e' }}>{truncate(item.name, 26)}</span>
                        <span className="row-wrap">
                          <Badge tone="danger" dot>逾期</Badge>
                          <span className="tiny muted nowrap">
                            {deadline !== null ? `最晚第 ${deadline} 章 · 已到第 ${progress.currentChapterNo} 章` : '未设最晚回收章'}
                          </span>
                        </span>
                      </div>
                    )
                  })}
                  {overdue.length > 6 && <span className="tiny muted">还有 {overdue.length - 6} 条未显示。</span>}
                </div>
              )}
              {dueSoon.length > 0 && (
                <div className="stack-sm">
                  <span className="tiny" style={{ color: 'var(--warn)' }}>3 章内到期 {dueSoon.length} 条</span>
                  {dueSoon.slice(0, 6).map(item => {
                    const deadline = deadlineChapterNo(item)
                    return (
                      <div key={item.id} className="row-wrap" style={{ justifyContent: 'space-between' }}>
                        <span className="small dim">{truncate(item.name, 26)}</span>
                        <span className="row-wrap">
                          <Badge tone="warn" dot>临期</Badge>
                          <span className="tiny muted nowrap">
                            {deadline !== null ? `最晚第 ${deadline} 章 · 还差 ${Math.max(0, deadline - progress.currentChapterNo)} 章` : '未设最晚回收章'}
                          </span>
                        </span>
                      </div>
                    )
                  })}
                  {dueSoon.length > 6 && <span className="tiny muted">还有 {dueSoon.length - 6} 条未显示。</span>}
                </div>
              )}
            </div>
          )}
        </Card>

        <Card title="卡住的地方" subtitle="剧情线不推进、章节等你拍板">
          <div className="stack-sm">
            <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
              <span className="field-label">停滞剧情线</span>
              <span className="tiny muted">{stalledThreads.length} 条</span>
            </div>
            {stalledThreads.length === 0 ? (
              <div className="small muted">剧情线都在推进。</div>
            ) : (
              stalledThreads.slice(0, 5).map(thread => (
                <div key={thread.id} className="row-wrap" style={{ justifyContent: 'space-between' }}>
                  <span className="small dim truncate">{truncate(thread.name, 26)}</span>
                  <Badge tone="warn">未推进</Badge>
                </div>
              ))
            )}

            <div className="divider" style={{ margin: '6px 0' }} />

            <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
              <span className="field-label">等你拍板的章节</span>
              <span className="tiny muted">{needsDecisionChapters.length} 章</span>
            </div>
            {needsDecisionChapters.length === 0 ? (
              <div className="small muted">没有卡在作者决策的章节。</div>
            ) : (
              needsDecisionChapters.slice(0, 5).map(chapter => (
                <button
                  key={chapter.id}
                  type="button"
                  className="row-btn row-wrap"
                  style={{ justifyContent: 'space-between', width: '100%' }}
                  onClick={() => openChapter(chapter.id)}
                >
                  <span className="small dim truncate">第 {chapter.chapterNo} 章 · {truncate(chapter.title, 22)}</span>
                  <StatusBadge status={chapter.status} />
                </button>
              ))
            )}
            {unreviewedChapters.length > 0 && (
              <div className="tiny muted" style={{ marginTop: 4 }}>
                另有 {unreviewedChapters.length} 章还没有审查过的正文草稿。
              </div>
            )}
          </div>
        </Card>
      </div>

      <div className="grid-2">
        <Card title="最近审计" subtitle="最近 10 条正式资料变更（定稿 / 应用提议 / 手动修改）">
          {recentAudit.length === 0 ? (
            <div className="small muted">还没有审计记录。</div>
          ) : (
            <div className="stack-sm">
              {recentAudit.slice(0, 10).map(entry => (
                <div
                  key={entry.id}
                  className="row-wrap"
                  style={{ justifyContent: 'space-between', borderBottom: '1px solid var(--line-soft)', paddingBottom: 5 }}
                >
                  <span className="small dim">
                    {auditText(entry.action)}
                    <span className="mono tiny muted" style={{ marginLeft: 8 }} title={entry.action}>{entry.entityId.slice(0, 8)}</span>
                  </span>
                  <span className="tiny muted nowrap" title={formatTime(entry.createdAt)}>{relativeTime(entry.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card
          title="工作流状态"
          subtitle={`运行中 ${workflows.running} · 失败 ${workflows.failed}`}
          actions={<button type="button" className="btn btn-sm btn-ghost" onClick={() => goto('workflows')}>查看全部</button>}
        >
          {workflows.recent.length === 0 ? (
            <div className="small muted">还没有工作流记录。</div>
          ) : (
            <div className="stack-sm">
              {workflows.recent.slice(0, 8).map(run => (
                <div key={run.id} className="row-wrap" style={{ justifyContent: 'space-between' }}>
                  <span className="small dim">{label(run.taskType)}</span>
                  <span className="row-wrap">
                    <StatusBadge status={run.state} />
                    <span className="tiny muted nowrap">{relativeTime(run.updatedAt)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

export function DashboardPage({ projectId, navigate }: PageProps) {
  const overview = useResource(() => api.getOverview(projectId), [projectId])
  const control = useResource(() => api.getControlCenter(projectId), [projectId])
  const threads = useResource(() => api.listThreads(projectId), [projectId])
  const relations = useResource(() => api.listRelations(projectId), [projectId])
  const batches = useResource(() => api.listIngestBatches(projectId), [projectId])
  const data = overview.data

  const project = data?.project
  const themes = useMemo(() => {
    const parsed = safeJson<unknown>(project?.themesJson, [])
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
  }, [project?.themesJson])

  if (overview.loading && !data) return <Loading text="正在汇总项目状态…" />
  if (overview.error) return <ErrorBox error={overview.error} onRetry={overview.reload} />
  if (!data || !project) return <Empty title="没有数据" hint="项目状态接口没有返回内容。" />

  const { counts } = data
  const goto = (path: string): void => navigate(`/p/${encodeURIComponent(projectId)}/${path}`)
  const openChapter = (chapterId: string): void => navigate(`/p/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}`)
  const progress = counts.chapters ? Math.round((counts.finalizedChapters / counts.chapters) * 100) : 0

  const threadList = threads.data ?? []
  const relationList = relations.data ?? []
  const batchList = batches.data ?? []
  const stalledThreads = threadList.filter(thread => thread.currentChapterId === null && thread.status !== 'archived').length

  const todos: Array<{ text: string; action: string; label: string }> = []
  if (!counts.chapters) todos.push({ text: '还没有章节大纲，先把全书或本卷拆成章。', action: 'outline', label: '去规划大纲' })
  if (!counts.entities) todos.push({ text: '资料库还是空的，人物的动机和能力没有落成事实。', action: 'entities', label: '去建人物' })
  if (!counts.relations || !counts.threads) todos.push({ text: '还没有人物关系或剧情线，写作上下文会缺少冲突与推进方向。', action: 'entities', label: '去补资料' })
  if (counts.pendingProposals > 0) todos.push({ text: `有 ${counts.pendingProposals} 条 AI 提出的资料变更等待你批准。`, action: 'proposals', label: '去审批' })
  if (counts.openIssues > 0) todos.push({ text: `有 ${counts.openIssues} 个 major/critical 审查问题未解决，会阻断定稿。`, action: 'reviews', label: '去处理' })

  return (
    <div className="stack">
      <div className="row-wrap" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ maxWidth: 720 }}>
          <div className="muted small">{project.genre} · 更新于 {relativeTime(project.updatedAt)}</div>
          <div className="serif" style={{ fontSize: 17, lineHeight: 1.8, color: 'var(--text-dim)', marginTop: 4 }}>
            {project.premise || '（还没有故事前提，去「项目设置与导出」补一句）'}
          </div>
        </div>
        <button type="button" className="btn" onClick={overview.reload}>刷新</button>
      </div>

      <SectionTitle
        title="创作控制台"
        hint="写到哪、哪里卡住、最近发生了什么"
        actions={<button type="button" className="btn btn-sm btn-ghost" disabled={control.loading} onClick={control.reload}>刷新控制台</button>}
      />
      {control.loading && !control.data ? (
        <Loading text="正在汇总控制台…" />
      ) : control.error ? (
        <ErrorBox error={control.error} onRetry={control.reload} />
      ) : control.data ? (
        <ControlCenterBlock control={control.data} goto={goto} openChapter={openChapter} />
      ) : (
        <Empty title="控制台暂无数据" hint="控制台接口没有返回内容。" />
      )}

      <div className="stat-grid">
        <Stat label="章节" value={counts.chapters} hint={`已定稿 ${counts.finalizedChapters}`} />
        <Stat label="进度" value={`${progress}%`} hint={<div className="meter" style={{ marginTop: 6 }}><span style={{ width: `${progress}%` }} /></div>} tone="accent" />
        <Stat label="人物与设定" value={counts.entities} hint="confirmed 才算正式事实" />
        <Stat label="事件" value={counts.events} />
        <Stat label="剧情线" value={counts.threads} hint="主线 / 支线" tone={counts.threads ? undefined : 'warn'} />
        <Stat label="人物关系" value={counts.relations} hint="进入写作上下文" />
        <Stat label="场景" value={counts.scenes} hint="章节内节拍" />
        <Stat label="素材批次" value={counts.ingestBatches} hint="历史导入" onClick={() => goto('ingest')} />
        <Stat label="未回收伏笔" value={counts.foreshadowingOpen} tone={counts.foreshadowingOpen ? 'warn' : undefined} />
        <Stat label="待审批变更" value={counts.pendingProposals} tone={counts.pendingProposals ? 'warn' : undefined} onClick={() => goto('proposals')} />
        <Stat label="未解决审查问题" value={counts.openIssues} tone={counts.openIssues ? 'danger' : undefined} onClick={() => goto('reviews')} />
      </div>

      {todos.length > 0 && (
        <Card title="下一步" subtitle="按你自己的工作节奏，不必全部清空">
          <div className="stack-sm">
            {todos.map(todo => (
              <div key={todo.text} className="row-wrap" style={{ justifyContent: 'space-between', borderBottom: '1px solid var(--line-soft)', paddingBottom: 8 }}>
                <span className="small dim">{todo.text}</span>
                <button type="button" className="btn btn-sm" onClick={() => goto(todo.action)}>{todo.label}</button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <SectionTitle title="创作脉络" hint="关系与剧情线决定冲突和推进方向，会进入写作上下文" />

      <div className="grid-2">
        <Card
          title="剧情线"
          subtitle="主线 / 支线 / 感情线；未推进到任何章节的会标黄"
          actions={<button type="button" className="btn btn-sm btn-ghost" disabled={threads.loading} onClick={threads.reload}>刷新</button>}
        >
          {threads.error ? (
            <ErrorBox error={threads.error} onRetry={threads.reload} />
          ) : threads.loading && !threads.data ? (
            <Loading text="正在载入剧情线…" />
          ) : threadList.length === 0 ? (
            <Empty
              title="还没有剧情线"
              hint="把主线目标、支线伏笔落成剧情线；素材导入会自动抽取，也可以之后在资料库维护。"
              action={<button type="button" className="btn btn-sm" onClick={() => goto('ingest')}>去素材导入</button>}
            />
          ) : (
            <div className="stack-sm">
              <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
                <span className="tiny muted">{threadList.length} 条 · 未推进 {stalledThreads} 条</span>
              </div>
              <div className="list">
                {threadList.slice(0, 8).map(thread => {
                  const stalled = thread.currentChapterId === null && thread.status !== 'archived'
                  return (
                    <div key={thread.id} className="list-item" style={{ cursor: 'default' }}>
                      <div className="list-item-main">
                        <div className="list-item-title">
                          <Badge tone={threadKindTone(thread.kind)}>{threadKindText(thread.kind)}</Badge>
                          <span>{truncate(thread.name, 28)}</span>
                          {stalled && <Badge tone="warn">未推进</Badge>}
                        </div>
                        <div className="list-item-meta">
                          {thread.goal.trim() ? `目标：${truncate(thread.goal, 60)}` : '（没写目标，建议补一句：这条线要推进到什么结果）'}
                        </div>
                      </div>
                      <StatusBadge status={thread.status} />
                    </div>
                  )
                })}
              </div>
              {threadList.length > 8 && <span className="tiny muted">还有 {threadList.length - 8} 条未显示。</span>}
            </div>
          )}
        </Card>

        <Card
          title="人物关系"
          subtitle="源 → 目标（类型）+ 张力；写作时会作为冲突依据"
          actions={<button type="button" className="btn btn-sm btn-ghost" disabled={relations.loading} onClick={relations.reload}>刷新</button>}
        >
          {relations.error ? (
            <ErrorBox error={relations.error} onRetry={relations.reload} />
          ) : relations.loading && !relations.data ? (
            <Loading text="正在载入人物关系…" />
          ) : relationList.length === 0 ? (
            <Empty
              title="还没有人物关系"
              hint="关系决定冲突与对白语气：师徒、宿敌、利益同盟都会影响写作。去人物页看看，或让素材导入抽一批。"
              action={<button type="button" className="btn btn-sm" onClick={() => goto('entities')}>去人物页</button>}
            />
          ) : (
            <div className="stack-sm">
              <span className="tiny muted">{relationList.length} 条关系</span>
              <div className="list">
                {relationList.slice(0, 8).map(relation => (
                  <div key={relation.id} className="list-item" style={{ cursor: 'default' }}>
                    <div className="list-item-main">
                      <div className="list-item-title">
                        <span>{truncate(relation.sourceName, 14)}</span>
                        <span className="muted">→</span>
                        <span>{truncate(relation.targetName, 14)}</span>
                        <Badge tone="info">{relation.kind || '关系'}</Badge>
                        <StatusBadge status={relation.status} />
                      </div>
                      <div className="list-item-meta">
                        {relation.tension.trim() ? `张力：${truncate(relation.tension, 70)}` : '（没写张力，补一句「谁欠谁 / 谁恨谁」会让对白更准）'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {relationList.length > 8 && <span className="tiny muted">还有 {relationList.length - 8} 条未显示。</span>}
            </div>
          )}
        </Card>
      </div>

      <div className="split">
        <div className="stack">
          <Card
            title="当前章节"
            subtitle={data.currentChapter ? '第一个尚未定稿的章节' : '全部章节都已定稿'}
            actions={data.currentChapter && (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => openChapter(data.currentChapter?.id ?? '')}>打开工作台</button>
            )}
          >
            {data.currentChapter ? (
              <div className="stack-sm">
                <div className="row-wrap">
                  <span className="mono muted">第 {data.currentChapter.chapterNo} 章</span>
                  <span style={{ fontSize: 16, fontFamily: 'var(--serif)' }}>{data.currentChapter.title}</span>
                  <StatusBadge status={data.currentChapter.status} />
                </div>
                <div className="small muted">状态流转：计划 → 上下文就绪 → 草稿 → 审查 → 修订 → 待定稿 → 已定稿。所有正文版本只追加、不覆盖。</div>
              </div>
            ) : (
              <Empty title="没有待写章节" hint="去大纲页规划后续章节，或用 AI 规划一批。" action={<button type="button" className="btn btn-sm" onClick={() => goto('outline')}>前往大纲</button>} />
            )}
          </Card>

          <Card title="最近正文版本" subtitle="任何一次写作/改写/修订/回滚都会留下一条">
            {data.recentRevisions.length ? (
              <div className="list">
                {data.recentRevisions.slice(0, 8).map(revision => (
                  <div key={revision.id} className="list-item" style={{ cursor: 'default' }}>
                    <div className="list-item-main">
                      <div className="list-item-title">
                        <span className="mono muted">#{revision.revisionNo}</span>
                        <Badge tone="muted">{label(revision.kind)}</Badge>
                        <StatusBadge status={revision.status} />
                        <span className="tiny muted">{countWords(revision.content)} 字</span>
                      </div>
                      <div className="list-item-meta">{truncate(revision.content.replace(/\s+/g, ' ').trim(), 90) || '（空正文）'}</div>
                    </div>
                    <div className="list-item-actions">
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => openChapter(revision.chapterId)}>打开</button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="还没有正文" hint="在工作台里写第一段，或让模型生成草稿。" />
            )}
          </Card>

          <Card title="最近定稿" subtitle="导出 Markdown 只包含这些章节">
            {data.lastFinalized ? (
              <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontFamily: 'var(--serif)' }}>第 {data.lastFinalized.chapter.chapterNo} 章 {data.lastFinalized.chapter.title}</div>
                  <div className="tiny muted">{formatTime(data.lastFinalized.revision.createdAt)} · {countWords(data.lastFinalized.revision.content)} 字</div>
                </div>
                <button type="button" className="btn btn-sm" onClick={() => goto('settings')}>导出</button>
              </div>
            ) : (
              <Empty title="还没有定稿章节" hint="定稿必须由作者确认；在章节工作台里完成后点「定稿」。" />
            )}
          </Card>

          <Card
            title="最近导入"
            subtitle="素材整理的批次；待审批的可以回去一次性应用"
            actions={<button type="button" className="btn btn-sm btn-ghost" onClick={() => goto('ingest')}>打开素材导入</button>}
          >
            {batches.error ? (
              <ErrorBox error={batches.error} onRetry={batches.reload} />
            ) : batches.loading && !batches.data ? (
              <Loading text="正在载入导入批次…" />
            ) : batchList.length === 0 ? (
              <Empty
                title="还没有素材导入"
                hint="把人物小传、章节摘要或设定文档丢进素材导入页，AI 会抽成待审批的结构化资料。"
                action={<button type="button" className="btn btn-sm" onClick={() => goto('ingest')}>去导入素材</button>}
              />
            ) : (
              <div className="list">
                {batchList.slice(0, 3).map(batch => {
                  const stats = parseStats(batch.statsJson)
                  return (
                    <div
                      key={batch.id}
                      role="button"
                      tabIndex={0}
                      className="list-item"
                      onClick={() => goto('ingest')}
                      onKeyDown={event => { if (event.key === 'Enter') goto('ingest') }}
                    >
                      <div className="list-item-main">
                        <div className="list-item-title">
                          <span>{truncate(batch.title || '未命名素材', 24)}</span>
                          <Badge tone={batchTone(batch.status)} dot>{batchStatusText(batch.status)}</Badge>
                        </div>
                        <div className="list-item-meta">
                          {BATCH_MODE_LABELS[batch.mode] ?? batch.mode} · 抽取 {extractedCount(stats)} 条 · {relativeTime(batch.createdAt)}
                        </div>
                      </div>
                      <div className="list-item-actions">
                        <span className="tiny muted">查看</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        </div>

        <div className="stack">
          <Card title="作品契约" subtitle="写作与素材整理共用的作品级约束">
            <Kv rows={[
              { key: '叙述视角', value: project.pov || '—' },
              { key: '时态', value: project.tense || '—' },
              {
                key: '章节字数',
                value: project.chapterWordsMin || project.chapterWordsMax
                  ? `${project.chapterWordsMin || '—'} – ${project.chapterWordsMax || '—'} 字`
                  : '—',
              },
              { key: '目标章数', value: project.targetChapters > 0 ? `${project.targetChapters} 章` : '—' },
              {
                key: '主题',
                value: themes.length ? (
                  <span className="row-wrap" style={{ gap: 5 }}>
                    {themes.map(theme => <span key={theme} className="chip">{theme}</span>)}
                  </span>
                ) : '—',
              },
            ]} />
            <div className="small muted" style={{ marginTop: 10 }}>
              这些契约会约束写作与素材整理：人物深度档案、人物关系、剧情线、本章场景已进入写作上下文，POV / 时态 / 章节字数 / 主题作为作品级契约一起参与生成约束。
              留空的字段不会进上下文，可用素材导入的 apply 模式自动补齐。
            </div>
          </Card>

          <Card title="待处理审查问题" subtitle="major / critical 会切断定稿路径" actions={<button type="button" className="btn btn-sm btn-ghost" onClick={() => goto('reviews')}>全部</button>}>
            {data.openIssues.length ? (
              <div className="stack-sm">
                {data.openIssues.slice(0, 6).map(issue => (
                  <div
                    key={issue.id}
                    role="button"
                    tabIndex={0}
                    className="row-btn"
                    style={{ cursor: 'pointer' }}
                    onClick={() => openChapter(issue.chapterId ?? '')}
                    onKeyDown={event => { if (event.key === 'Enter') openChapter(issue.chapterId ?? '') }}
                  >
                    <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
                      <Badge tone={severityTone(issue.severity)}>{label(issue.severity)}</Badge>
                      <span className="tiny muted">第 {issue.chapterNo} 章</span>
                    </div>
                    <div className="small" style={{ marginTop: 3 }}>{truncate(issue.issue, 70)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="small muted">没有未解决的阻断问题。</div>
            )}
          </Card>

          <Card title="未回收伏笔" actions={<button type="button" className="btn btn-sm btn-ghost" onClick={() => goto('foreshadowing')}>管理</button>}>
            {data.openForeshadowing.length ? (
              <div className="stack-sm">
                {data.openForeshadowing.slice(0, 6).map(item => (
                  <div key={item.id}>
                    <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
                      <span className="small">{item.name}</span>
                      <Badge tone={statusTone(item.status)}>{label(item.status)}</Badge>
                    </div>
                    <div className="tiny muted">{truncate(item.description, 60) || '（无描述）'}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="small muted">没有未回收的伏笔。</div>
            )}
          </Card>

          <Card title="最近工作流" actions={<button type="button" className="btn btn-sm btn-ghost" onClick={() => goto('workflows')}>查看</button>}>
            {data.recentWorkflows.length ? (
              <div className="stack-sm">
                {data.recentWorkflows.slice(0, 6).map(run => (
                  <div key={run.id} className="row-wrap" style={{ justifyContent: 'space-between' }}>
                    <span className="small dim">{label(run.taskType)}</span>
                    <span className="row-wrap">
                      <StatusBadge status={run.state} />
                      <span className="tiny muted">{relativeTime(run.updatedAt)}</span>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="small muted">还没有工作流记录。写作、审查、规划会自动留下检查点。</div>
            )}
          </Card>
        </div>
      </div>

      <SectionTitle title="硬约束" hint="这些是插件层面的规则，不是提示词建议" />
      <div className="grid-3">
        <Card tight><div className="small dim"><b>计划 ≠ 事实</b><br />事件与实体带 planned / draft / confirmed / cancelled 状态，上下文包会显式标注，未发生的内容不会被当作已发生。</div></Card>
        <Card tight><div className="small dim"><b>正文不可无记录覆盖</b><br />每次写作、续写、改写、修订、回滚都新建版本；只有定稿会移动正式版本指针。</div></Card>
        <Card tight><div className="small dim"><b>AI 不能自行改写正式资料</b><br />模型只能提出变更；应用与定稿都需要你显式批准，并写入审计日志。</div></Card>
      </div>
    </div>
  )
}
