import { api } from '../lib/api.ts'
import type { PageProps } from '../app/types.ts'
import { useResource } from '../lib/hooks.ts'
import { countWords, formatTime, label, relativeTime, severityTone, statusTone, truncate } from '../lib/format.ts'
import { Badge, Card, Empty, ErrorBox, Loading, SectionTitle, Stat, StatusBadge } from '../components/ui.tsx'

export function DashboardPage({ projectId, navigate }: PageProps) {
  const overview = useResource(() => api.getOverview(projectId), [projectId])
  const data = overview.data

  if (overview.loading && !data) return <Loading text="正在汇总项目状态…" />
  if (overview.error) return <ErrorBox error={overview.error} onRetry={overview.reload} />
  if (!data) return <Empty title="没有数据" hint="项目状态接口没有返回内容。" />

  const { counts, project } = data
  const goto = (path: string): void => navigate(`/p/${encodeURIComponent(projectId)}/${path}`)
  const openChapter = (chapterId: string): void => navigate(`/p/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}`)
  const progress = counts.chapters ? Math.round((counts.finalizedChapters / counts.chapters) * 100) : 0

  const todos: Array<{ text: string; action: string; label: string }> = []
  if (!counts.chapters) todos.push({ text: '还没有章节大纲，先把全书或本卷拆成章。', action: 'outline', label: '去规划大纲' })
  if (!counts.entities) todos.push({ text: '资料库还是空的，人物的动机和能力没有落成事实。', action: 'entities', label: '去建人物' })
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

      <div className="stat-grid">
        <Stat label="章节" value={counts.chapters} hint={`已定稿 ${counts.finalizedChapters}`} />
        <Stat label="进度" value={`${progress}%`} hint={<div className="meter" style={{ marginTop: 6 }}><span style={{ width: `${progress}%` }} /></div>} tone="accent" />
        <Stat label="人物与设定" value={counts.entities} hint="confirmed 才算正式事实" />
        <Stat label="事件" value={counts.events} />
        <Stat label="未回收伏笔" value={counts.foreshadowingOpen} tone={counts.foreshadowingOpen ? 'warn' : undefined} />
        <Stat label="待审批变更" value={counts.pendingProposals} tone={counts.pendingProposals ? 'warn' : undefined} onClick={() => goto('proposals')} />
        <Stat label="未解决审查问题" value={counts.openIssues} tone={counts.openIssues ? 'danger' : undefined} onClick={() => goto('reviews')} />
      </div>

      {todos.length > 0 && (
        <Card title="下一步" subtitle="按你自己的工作节奏，不必全部清空">
          <div className="stack-sm">
            {todos.map(todo => (
              <div key={todo.action} className="row-wrap" style={{ justifyContent: 'space-between', borderBottom: '1px solid var(--line-soft)', paddingBottom: 8 }}>
                <span className="small dim">{todo.text}</span>
                <button type="button" className="btn btn-sm" onClick={() => goto(todo.action)}>{todo.label}</button>
              </div>
            ))}
          </div>
        </Card>
      )}

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
        </div>

        <div className="stack">
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
