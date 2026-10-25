import { useState } from 'react'
import type { FormEvent } from 'react'
import { api, ApiError } from '../lib/api.ts'
import type { Project } from '../lib/types.ts'
import { useResource, toast } from '../lib/hooks.ts'
import { relativeTime } from '../lib/format.ts'
import { Card, Empty, ErrorBox, Field, Loading, SectionTitle, Stat } from '../components/ui.tsx'

export interface ProjectsPageProps {
  projects: Project[]
  loading: boolean
  error: Error | null
  reload: () => void
  navigate: (path: string) => void
}

type Mode = 'idle' | 'manual' | 'ai'

export function ProjectsPage({ projects, loading, error, reload, navigate }: ProjectsPageProps) {
  const [mode, setMode] = useState<Mode>('idle')
  const [title, setTitle] = useState('')
  const [genre, setGenre] = useState('')
  const [premise, setPremise] = useState('')
  const [styleGuide, setStyleGuide] = useState('')
  const [idea, setIdea] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const health = useResource(() => api.health(), [])

  const open = (project: Project): void => navigate(`/p/${encodeURIComponent(project.id)}`)

  const submitManual = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!title.trim() || !genre.trim()) {
      setFormError('书名和题材都不能为空。')
      return
    }
    setBusy(true)
    setFormError(null)
    try {
      const project = await api.createProject({
        title: title.trim(),
        genre: genre.trim(),
        ...(premise.trim() ? { premise: premise.trim() } : {}),
        ...(styleGuide.trim() ? { styleGuide: styleGuide.trim() } : {}),
      })
      toast.ok(`项目「${project.title}」已创建`)
      reload()
      open(project)
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const submitAi = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!idea.trim()) {
      setFormError('请先写下创作意图，例如「近未来侦探 + 家族秘密」。')
      return
    }
    setBusy(true)
    setFormError(null)
    try {
      const result = await api.generateSetting(idea.trim())
      toast.ok(`已由模型生成项目「${result.project.title}」`)
      reload()
      open(result.project)
    } catch (cause) {
      setFormError(cause instanceof ApiError ? `${cause.message}（${cause.code}）` : cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const aiReady = health.data?.hasApiKey === true

  return (
    <div className="stack">
      <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontFamily: 'var(--serif)', letterSpacing: '0.04em' }}>小说项目</h1>
          <div className="muted small">持久化在本地 SQLite；正文不可覆盖，定稿与资料变更都需要你批准。</div>
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => setMode(mode === 'manual' ? 'idle' : 'manual')}>
            手动创建
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setMode(mode === 'ai' ? 'idle' : 'ai')}
            disabled={!aiReady}
            title={aiReady ? '按创作意图自动生成题材、人物与世界规则' : '需要 DEEPSEEK_API_KEY 或 DSH 宿主模型'}
          >
            AI 生成设定
          </button>
        </div>
      </div>

      {!aiReady && health.data && (
        <div className="hint-box">
          当前没有可用的模型凭据，<b>AI 生成设定</b> 与全部 <code>novel_*</code> 生成类能力会不可用；
          资料管理、正文人工写作、审查查看、版本比较与导出完全不受影响。
        </div>
      )}

      {mode === 'manual' && (
        <Card title="新建小说项目" subtitle="书名与题材必填；故事前提与文风规范可以在项目设置里随时补充">
          <form onSubmit={submitManual} className="stack-sm">
            <div className="grid-2">
              <Field label="书名"><input className="input" value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：雾港" /></Field>
              <Field label="题材"><input className="input" value={genre} onChange={event => setGenre(event.target.value)} placeholder="例如：悬疑 / 赛博修仙 / 都市复仇" /></Field>
            </div>
            <Field label="故事前提"><textarea className="textarea" rows={3} value={premise} onChange={event => setPremise(event.target.value)} placeholder="一句话讲清核心冲突" /></Field>
            <Field label="文风规范" hint="会进入每次写作的上下文包，作为硬约束">
              <textarea className="textarea" rows={2} value={styleGuide} onChange={event => setStyleGuide(event.target.value)} placeholder="例如：冷峻短句，克制的第三人称；每章结尾留一个悬念。" />
            </Field>
            {formError && <div className="error-box">{formError}</div>}
            <div className="btn-row">
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '创建中…' : '创建并进入'}</button>
              <button type="button" className="btn btn-ghost" onClick={() => setMode('idle')} disabled={busy}>取消</button>
            </div>
          </form>
        </Card>
      )}

      {mode === 'ai' && (
        <Card title="AI 生成设定" subtitle="模型会产出题材、故事前提、人物档案与世界规则并落库，之后仍需你逐项确认">
          <form onSubmit={submitAi} className="stack-sm">
            <Field label="创作意图">
              <textarea
                className="textarea"
                rows={3}
                value={idea}
                onChange={event => setIdea(event.target.value)}
                placeholder="例如：近未来海滨城市，侦探主角在查一桩失踪案时发现家族三十年前的秘密；想要冷硬派口吻 + 少量超自然元素。"
              />
            </Field>
            {formError && <div className="error-box">{formError}</div>}
            <div className="btn-row">
              <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? '生成中…（可能需要十几次网络往返）' : '生成并创建项目'}</button>
              <button type="button" className="btn btn-ghost" onClick={() => setMode('idle')} disabled={busy}>取消</button>
            </div>
          </form>
        </Card>
      )}

      <SectionTitle title="全部项目" hint={loading ? '载入中…' : `共 ${projects.length} 个`} />

      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !projects.length && <Loading />}

      {!loading && !error && !projects.length && (
        <Empty
          title="还没有小说项目"
          hint="手动创建可以从零搭建资料库；AI 生成设定适合先要一个可用的骨架再改。"
          action={<button type="button" className="btn btn-primary" onClick={() => setMode('manual')}>创建第一个项目</button>}
        />
      )}

      {projects.length > 0 && (
        <div className="grid-3">
          {projects.map(project => (
            <div
              key={project.id}
              role="button"
              tabIndex={0}
              className="card"
              style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit' }}
              onClick={() => open(project)}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(project) } }}
            >
              <div className="row-wrap" style={{ justifyContent: 'space-between' }}>
                <span className="badge badge-accent">{project.genre}</span>
                <span className="tiny muted">{relativeTime(project.updatedAt)}</span>
              </div>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 18, margin: '9px 0 4px' }}>{project.title}</div>
              <div className="small dim" style={{ minHeight: 40, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {project.premise || '（还没有故事前提）'}
              </div>
              <div className="row-wrap" style={{ marginTop: 10 }}>
                <Stat label="状态" value={<span className="small">{project.status === 'active' ? '进行中' : project.status}</span>} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
