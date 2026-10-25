import { useMemo } from 'react'
import { useResource, useHashRoute } from '../lib/hooks.ts'
import { api } from '../lib/api.ts'
import { AppHosts, Loading } from '../components/ui.tsx'
import { ProjectsPage } from '../pages/ProjectsPage.tsx'
import { DashboardPage } from '../pages/DashboardPage.tsx'
import { OutlinePage } from '../pages/OutlinePage.tsx'
import { EntitiesPage } from '../pages/EntitiesPage.tsx'
import { TimelinePage } from '../pages/TimelinePage.tsx'
import { ForeshadowingPage } from '../pages/ForeshadowingPage.tsx'
import { IngestPage } from '../pages/IngestPage.tsx'
import { ChaptersPage } from '../pages/ChaptersPage.tsx'
import { ChapterWorkspacePage } from '../pages/ChapterWorkspacePage.tsx'
import { ReviewsPage } from '../pages/ReviewsPage.tsx'
import { ComparePage } from '../pages/ComparePage.tsx'
import { ProposalsPage } from '../pages/ProposalsPage.tsx'
import { WorkflowsPage } from '../pages/WorkflowsPage.tsx'
import { SettingsPage } from '../pages/SettingsPage.tsx'

const NAV_SECTIONS: Array<{
  title: string
  items: Array<{ key: string; label: string; glyph: string; suffix?: string }>
}> = [
  {
    title: '创作',
    items: [
      { key: '', label: '项目总览', glyph: '◈' },
      { key: 'ingest', label: '素材导入', glyph: '⇥' },
      { key: 'outline', label: '大纲', glyph: '≣' },
      { key: 'chapters', label: '章节', glyph: '✎' },
    ],
  },
  {
    title: '资料库',
    items: [
      { key: 'entities', label: '人物与世界观', glyph: '☰' },
      { key: 'timeline', label: '事件时间线', glyph: '⏱' },
      { key: 'foreshadowing', label: '伏笔', glyph: '⟡' },
    ],
  },
  {
    title: '质量',
    items: [
      { key: 'reviews', label: '审查报告', glyph: '⌕' },
      { key: 'compare', label: '版本比较', glyph: '⇄' },
      { key: 'proposals', label: '待审批变更', glyph: '⚖' },
      { key: 'workflows', label: '工作流', glyph: '↻' },
    ],
  },
  {
    title: '其它',
    items: [{ key: 'settings', label: '项目设置与导出', glyph: '⚙' }],
  },
]

export function App() {
  const { segments, navigate } = useHashRoute()
  const projects = useResource(() => api.listProjects(), [])
  const health = useResource(() => api.health(), [])

  const projectId = segments[0] === 'p' ? segments[1] ?? null : null
  const section = projectId ? (segments[2] ?? '') : ''
  const chapterId = projectId && segments[2] === 'chapters' ? segments[3] ?? null : null

  const project = useMemo(
    () => projects.data?.find(item => item.id === projectId) ?? null,
    [projects.data, projectId],
  )

  const base = projectId ? `/p/${encodeURIComponent(projectId)}` : ''
  const open = (key: string): void => navigate(key ? `${base}/${key}` : base)

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <div className="brand-mark">墨</div>
          <div>
            <div className="brand-name">NovelForge</div>
            <div className="brand-sub">小说工作台</div>
          </div>
        </div>

        <div className="project-switch">
          <select
            className="select input-sm"
            value={projectId ?? ''}
            onChange={event => {
              const next = event.target.value
              if (!next) navigate('/')
              else navigate(`/p/${encodeURIComponent(next)}`)
            }}
            aria-label="切换小说项目"
          >
            <option value="">选择项目…</option>
            {(projects.data ?? []).map(item => (
              <option key={item.id} value={item.id}>{item.title}</option>
            ))}
          </select>
        </div>

        {projectId ? (
          <nav className="nav">
            {NAV_SECTIONS.map(sectionGroup => (
              <div key={sectionGroup.title}>
                <div className="nav-label">{sectionGroup.title}</div>
                {sectionGroup.items.map(item => {
                  const active = item.key === '' ? section === '' || section === 'dashboard' : section === item.key
                  return (
                    <button
                      key={item.key || 'overview'}
                      type="button"
                      className={`nav-item${active ? ' active' : ''}`}
                      onClick={() => open(item.key)}
                    >
                      <span className="nav-glyph">{item.glyph}</span>
                      <span>{item.label}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </nav>
        ) : (
          <div className="stack-sm" style={{ padding: '4px 2px' }}>
            <button type="button" className="nav-item active" onClick={() => navigate('/')}>
              <span className="nav-glyph">◈</span><span>全部项目</span>
            </button>
            <div className="hint-box">先选择或新建一个小说项目，左侧会出现大纲、章节、资料库等入口。</div>
          </div>
        )}

        <div className="rail-foot">
          <div>
            <span className="dot" style={{ background: health.data?.hasApiKey ? 'var(--ok)' : 'var(--muted)' }} />
            AI {health.data?.hasApiKey ? '可用' : '未配置'}
          </div>
          <div className="tiny" style={{ marginTop: 4 }}>v{health.data?.version ?? '—'} · 本地服务</div>
        </div>
      </aside>

      <main className="main">
        {projectId && !project && projects.loading ? (
          <div className="content"><Loading text="正在载入项目…" /></div>
        ) : projectId && !project && !projects.loading ? (
          <div className="content">
            <div className="error-box">项目不存在或已被删除：{projectId}</div>
            <div style={{ marginTop: 12 }}><button type="button" className="btn" onClick={() => navigate('/')}>返回项目列表</button></div>
          </div>
        ) : (
          <>
            {project && (
              <header className="topbar">
                <div className="topbar-title">
                  <span className="eyebrow">{project.genre}</span>
                  <h1>{project.title}</h1>
                </div>
                <div className="topbar-actions">
                  <span className="badge badge-muted">{project.status === 'active' ? '进行中' : project.status}</span>
                  <button type="button" className="btn btn-sm" onClick={() => open('chapters')}>继续写作</button>
                </div>
              </header>
            )}
            <div className="content">
              <RouteView
                projectId={projectId}
                section={section}
                chapterId={chapterId}
                navigate={navigate}
                projects={projects.data ?? []}
                projectsLoading={projects.loading}
                projectsError={projects.error}
                reloadProjects={projects.reload}
              />
            </div>
          </>
        )}
      </main>
      <AppHosts />
    </div>
  )
}

function RouteView({ projectId, section, chapterId, navigate, projects, projectsLoading, projectsError, reloadProjects }: {
  projectId: string | null
  section: string
  chapterId: string | null
  navigate: (path: string) => void
  projects: import('../lib/types.ts').Project[]
  projectsLoading: boolean
  projectsError: Error | null
  reloadProjects: () => void
}) {
  if (!projectId) {
    return (
      <ProjectsPage
        projects={projects}
        loading={projectsLoading}
        error={projectsError}
        reload={reloadProjects}
        navigate={navigate}
      />
    )
  }
  const props = { projectId, navigate }
  if (section === '' || section === 'dashboard') return <DashboardPage {...props} />
  if (section === 'ingest') return <IngestPage {...props} />
  if (section === 'outline') return <OutlinePage {...props} />
  if (section === 'entities') return <EntitiesPage {...props} />
  if (section === 'timeline') return <TimelinePage {...props} />
  if (section === 'foreshadowing') return <ForeshadowingPage {...props} />
  if (section === 'chapters' && chapterId) return <ChapterWorkspacePage {...props} chapterId={chapterId} />
  if (section === 'chapters') return <ChaptersPage {...props} />
  if (section === 'reviews') return <ReviewsPage {...props} />
  if (section === 'compare') return <ComparePage {...props} />
  if (section === 'proposals') return <ProposalsPage {...props} />
  if (section === 'workflows') return <WorkflowsPage {...props} />
  if (section === 'settings') return <SettingsPage {...props} />
  return (
    <div className="empty">
      <strong>页面不存在</strong>
      <div>未知路径：{section}</div>
    </div>
  )
}
