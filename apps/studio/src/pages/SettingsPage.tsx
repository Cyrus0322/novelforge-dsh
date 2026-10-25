import { useState } from 'react'
import { api } from '../lib/api.ts'
import { toast, useResource } from '../lib/hooks.ts'
import type { PageProps } from '../app/types.ts'
import type { AuditEntry, Project, SearchResult } from '../lib/types.ts'
import { Badge, Card, Empty, ErrorBox, Field, Loading, SectionTitle, StatusBadge } from '../components/ui.tsx'
import { countWords, download, formatTime, label, prettyJson, relativeTime, truncate } from '../lib/format.ts'

function toMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function safeFilename(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
  return cleaned || 'novel'
}

export function SettingsPage({ projectId, navigate }: PageProps) {
  const overview = useResource(() => api.getOverview(projectId), [projectId])

  return (
    <div className="stack">
      <SectionTitle
        title="项目设置与导出"
        hint="元信息改动带乐观版本检查；导出只包含已定稿章节。"
        actions={<button type="button" className="btn btn-sm" onClick={overview.reload} disabled={overview.loading}>刷新</button>}
      />

      {overview.error && <ErrorBox error={overview.error} onRetry={overview.reload} />}

      {overview.loading && !overview.data ? (
        <Card><Loading text="正在载入项目信息…" /></Card>
      ) : overview.data ? (
        <>
          <ProjectMetaForm
            key={`${overview.data.project.id}-${overview.data.project.version}`}
            project={overview.data.project}
            onSaved={overview.reload}
          />
          <ExportCard projectId={projectId} title={overview.data.project.title} />
        </>
      ) : null}

      <AuditCard projectId={projectId} />
      <SearchCard projectId={projectId} navigate={navigate} />
    </div>
  )
}

// ── ① 项目元信息 ────────────────────────────────────────────

function ProjectMetaForm({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [title, setTitle] = useState(project.title)
  const [genre, setGenre] = useState(project.genre)
  const [premise, setPremise] = useState(project.premise)
  const [styleGuide, setStyleGuide] = useState(project.styleGuide)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const dirty = title !== project.title || genre !== project.genre
    || premise !== project.premise || styleGuide !== project.styleGuide

  function reset(): void {
    setTitle(project.title)
    setGenre(project.genre)
    setPremise(project.premise)
    setStyleGuide(project.styleGuide)
    setError(null)
  }

  async function save(): Promise<void> {
    if (!title.trim() || !genre.trim()) {
      toast.error('书名与题材不能为空。')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api.updateProject(project.id, {
        title: title.trim(),
        genre: genre.trim(),
        premise,
        styleGuide,
        expectedVersion: project.version,
      })
      toast.ok('项目元信息已保存。')
      onSaved()
    } catch (cause) {
      setError(toError(cause))
      toast.error(toMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card
      title="项目元信息"
      subtitle={`当前版本 v${project.version} · 最后更新 ${formatTime(project.updatedAt)}`}
      actions={(
        <>
          {dirty && <Badge tone="warn">有未保存修改</Badge>}
          <button type="button" className="btn btn-sm" onClick={reset} disabled={!dirty || saving}>重置</button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => { void save() }}
            disabled={saving || !dirty}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      )}
    >
      {error && <div style={{ marginBottom: 12 }}><ErrorBox error={error} /></div>}
      <div className="grid-2">
        <Field label="书名">
          <input className="input" value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：长夜将明" />
        </Field>
        <Field label="题材">
          <input className="input" value={genre} onChange={event => setGenre(event.target.value)} placeholder="例如：东方玄幻 / 悬疑" />
        </Field>
        <Field label="故事前提" span hint="一句话讲清核心冲突；会进入上下文包与规划提示词。">
          <textarea className="textarea" value={premise} onChange={event => setPremise(event.target.value)} placeholder="主角是谁、想要什么、被什么阻挡。" />
        </Field>
        <Field label="文风指南" span hint="叙述人称、语感、忌讳的桥段等，写作与修订都会参考。">
          <textarea className="textarea" value={styleGuide} onChange={event => setStyleGuide(event.target.value)} placeholder="例如：第三人称有限视角，冷峻克制，不使用网络流行语。" />
        </Field>
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <span className="tiny muted">
          保存会带上 expectedVersion={project.version}：如果数据库里的版本已经变化，服务端会拒绝覆盖。
        </span>
      </div>
    </Card>
  )
}

// ── ② 导出 Markdown ────────────────────────────────────────

function ExportCard({ projectId, title }: { projectId: string; title: string }) {
  const [busy, setBusy] = useState(false)
  const [exported, setExported] = useState<{ filename: string; bytes: number; words: number; at: string } | null>(null)

  async function run(): Promise<void> {
    setBusy(true)
    try {
      const text = await api.exportMarkdown(projectId)
      const filename = `${safeFilename(title)}.md`
      download(filename, text)
      const bytes = new TextEncoder().encode(text).length
      setExported({ filename, bytes, words: countWords(text), at: new Date().toISOString() })
      toast.ok(`已导出 ${filename}`)
    } catch (cause) {
      toast.error(toMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="导出 Markdown"
      subtitle="把已定稿章节按顺序拼成一份 .md 文件，直接在浏览器下载。"
      actions={(
        <button type="button" className="btn btn-sm btn-primary" onClick={() => { void run() }} disabled={busy}>
          {busy ? '导出中…' : exported ? '再次导出' : '导出 Markdown'}
        </button>
      )}
    >
      <div className="notice">只含已定稿章节：草稿、待定稿版本、未完成大纲与审查记录都不会写入导出文件。</div>
      {exported && (
        <div className="hint-box" style={{ marginTop: 10 }}>
          <div className="small">
            已下载 <span className="mono">{exported.filename}</span>
          </div>
          <div className="row-wrap tiny muted" style={{ marginTop: 4 }}>
            <span>{exported.bytes.toLocaleString('zh-CN')} 字节</span>
            <span>约 {exported.words.toLocaleString('zh-CN')} 字</span>
            <span>{formatTime(exported.at)}</span>
          </div>
        </div>
      )}
    </Card>
  )
}

// ── ③ 审计日志 ──────────────────────────────────────────────

function AuditCard({ projectId }: { projectId: string }) {
  const audit = useResource(() => api.audit(projectId, 80), [projectId])
  const entries = audit.data ?? []

  return (
    <Card
      title="审计日志"
      subtitle={`最近 ${entries.length} 条 · 所有写操作都会留痕`}
      actions={<button type="button" className="btn btn-sm" onClick={audit.reload} disabled={audit.loading}>刷新</button>}
    >
      {audit.error && <ErrorBox error={audit.error} onRetry={audit.reload} />}
      {audit.loading && !audit.data ? (
        <Loading text="正在载入审计日志…" />
      ) : entries.length === 0 ? (
        <Empty title="还没有审计记录" hint="创建项目、保存元信息、应用变更提议等写操作都会在这里留下记录。" />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>动作</th>
                <th>实体</th>
                <th>变更摘要</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr key={entry.id}>
                  <td className="tiny muted nowrap" title={entry.createdAt}>
                    {formatTime(entry.createdAt)}
                    <div className="tiny" style={{ opacity: 0.7 }}>{relativeTime(entry.createdAt)}</div>
                  </td>
                  <td><span className="mono small">{label(entry.action)}</span></td>
                  <td><span className="mono tiny">{truncate(entry.entityId, 26)}</span></td>
                  <td>{renderAuditDetail(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function renderAuditDetail(entry: AuditEntry) {
  if (!entry.beforeJson && !entry.afterJson) return <span className="tiny muted">—</span>
  return (
    <details>
      <summary className="small" style={{ cursor: 'pointer', color: 'var(--accent)' }}>展开变更</summary>
      <div style={{ marginTop: 6 }}>
        {entry.beforeJson && (
          <>
            <div className="tiny muted">变更前</div>
            <pre style={PRE_STYLE}>{prettyJson(entry.beforeJson)}</pre>
          </>
        )}
        {entry.afterJson && (
          <>
            <div className="tiny muted" style={{ marginTop: 6 }}>变更后</div>
            <pre style={PRE_STYLE}>{prettyJson(entry.afterJson)}</pre>
          </>
        )}
      </div>
    </details>
  )
}

// ── ④ 全局搜索 ──────────────────────────────────────────────

const SEARCH_TYPES = ['character', 'world_rule', 'chapter', 'event', 'foreshadowing'] as const

function SearchCard({ projectId, navigate }: { projectId: string; navigate: (path: string) => void }) {
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [types, setTypes] = useState<string[]>([])
  const typesKey = types.join(',')

  const results = useResource<SearchResult[]>(() => {
    const term = submitted.trim()
    if (!term) return Promise.resolve([])
    return api.search(projectId, term, types, 30)
  }, [projectId, submitted, typesKey])

  function submit(): void {
    const next = query.trim()
    if (!next) {
      setSubmitted('')
      return
    }
    if (next === submitted) results.reload()
    else setSubmitted(next)
  }

  function toggleType(type: string): void {
    setTypes(previous => (previous.includes(type) ? previous.filter(item => item !== type) : [...previous, type]))
  }

  const list = results.data ?? []

  return (
    <Card
      title="全局搜索"
      subtitle="在人物、世界规则、正文版本、事件与伏笔的词条索引里检索。"
    >
      <form
        className="row-wrap"
        style={{ gap: 8 }}
        onSubmit={event => { event.preventDefault(); submit() }}
      >
        <input
          className="input"
          style={{ flex: '1 1 260px', width: 'auto' }}
          value={query}
          placeholder="输入关键词，回车搜索…"
          onChange={event => setQuery(event.target.value)}
        />
        <button type="submit" className="btn btn-sm btn-primary" disabled={results.loading}>搜索</button>
        {submitted && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => { setQuery(''); setSubmitted('') }}
          >
            清空
          </button>
        )}
      </form>

      <div className="row-wrap" style={{ marginTop: 10 }}>
        <span className="tiny muted">类型：</span>
        {SEARCH_TYPES.map(type => (
          <button
            key={type}
            type="button"
            className={`chip${types.includes(type) ? ' active' : ''}`}
            onClick={() => toggleType(type)}
          >
            {label(type)}
          </button>
        ))}
        {types.length > 0 && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setTypes([])}>不限类型</button>
        )}
      </div>

      <div className="divider" />

      {!submitted ? (
        <Empty title="输入关键词开始搜索" hint="搜索覆盖资料库与所有正文版本；选中类型可以缩小范围。" />
      ) : results.error ? (
        <ErrorBox error={results.error} onRetry={results.reload} />
      ) : results.loading ? (
        <Loading text={`正在搜索「${submitted}」…`} />
      ) : list.length === 0 ? (
        <Empty title={`没有匹配「${submitted}」的内容`} hint="换个关键词（至少 2 个字更容易命中），或放宽类型筛选。" />
      ) : (
        <>
          <div className="tiny muted" style={{ marginBottom: 6 }}>
            命中 {list.length} 条{types.length > 0 ? ` · 已按 ${types.map(type => label(type)).join(' / ')} 筛过` : ''}
          </div>
          <div className="list">
            {list.map(result => {
              const target = result.recordType === 'chapter'
                ? `/p/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(result.sourceId)}`
                : null
              const body = (
                <div className="list-item-main">
                  <div className="list-item-title">
                    <Badge tone="accent">{label(result.recordType)}</Badge>
                    <StatusBadge status={result.status} />
                    <span className="mono tiny muted">{truncate(result.recordId, 22)}</span>
                  </div>
                  <div className="list-item-meta small dim" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {truncate(result.snippet.replace(/\s+/g, ' ').trim(), 260)}
                  </div>
                </div>
              )
              return target ? (
                <button
                  key={result.recordId}
                  type="button"
                  className="list-item"
                  title="打开章节工作台"
                  onClick={() => navigate(target)}
                >
                  {body}
                </button>
              ) : (
                <div key={result.recordId} className="list-item" style={{ cursor: 'default' }}>{body}</div>
              )
            })}
          </div>
        </>
      )}
    </Card>
  )
}

const PRE_STYLE = {
  margin: '4px 0 0',
  padding: '8px 10px',
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--bg-soft)',
  maxHeight: 240,
  overflow: 'auto',
  whiteSpace: 'pre-wrap' as const,
  wordBreak: 'break-word' as const,
  fontFamily: 'var(--mono)',
  fontSize: 11.5,
  lineHeight: 1.6,
  color: 'var(--text-dim)',
}
