import type { Chapter, ChapterRevision, Entity, Foreshadowing, Outline, Project, StoryEvent } from '../database/store.js'
import { NovelStore } from '../database/store.js'
import type { RuntimeConfig } from '../shared/config.js'

export interface ContextSource {
  id: string
  type: string
  status: string
}

export interface ContextPack {
  projectId: string
  chapterId: string
  text: string
  estimatedTokens: number
  budgetTokens: number
  truncated: boolean
  omittedSections: string[]
  sources: ContextSource[]
}

interface Section {
  name: string
  priority: number
  text: string
  sources: ContextSource[]
}

export function estimateTokens(text: string): number {
  let units = 0
  for (const char of text) {
    if (/\s/.test(char)) units += 0.25
    else if (/^[\x00-\x7F]$/.test(char)) units += 0.27
    else units += 1
  }
  return Math.max(1, Math.ceil(units))
}

function sliceByTokens(text: string, budget: number, fromEnd = false): string {
  if (estimateTokens(text) <= budget) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = fromEnd ? text.slice(-middle) : text.slice(0, middle)
    if (estimateTokens(candidate) <= budget) low = middle
    else high = middle - 1
  }
  return fromEnd ? text.slice(-low) : text.slice(0, low)
}

export function truncateToTokens(text: string, budget: number): { text: string; truncated: boolean } {
  if (budget <= 20) return { text: '', truncated: text.length > 0 }
  if (estimateTokens(text) <= budget) return { text, truncated: false }
  const marker = '\n…[中间内容已按上下文预算截断]…\n'
  const remaining = budget - estimateTokens(marker)
  const head = sliceByTokens(text, Math.ceil(remaining * 0.6))
  const tail = sliceByTokens(text, Math.floor(remaining * 0.4), true)
  return { text: `${head}${marker}${tail}`, truncated: true }
}

function entityLines(rows: Entity[], rich = false): { text: string; sources: ContextSource[] } {
  return {
    text: rows.map(row => {
      const head = `- [${row.status}] ${row.name}（${row.kind}）：${row.summary}`
      if (!rich) return `${head}\n  属性：${row.attributesJson} [来源:${row.id}]`
      // 人物深度档案：这些字段决定"会不会写歪"，比 attributes 更重要。
      const details: string[] = []
      if (row.role) details.push(`定位：${row.role}`)
      if (row.goal) details.push(`目标：${row.goal}`)
      if (row.motivation) details.push(`动机：${row.motivation}`)
      if (row.flaw) details.push(`缺陷：${row.flaw}`)
      if (row.secret) details.push(`秘密：${row.secret}`)
      if (row.voice) details.push(`说话方式：${row.voice}`)
      if (row.arc) details.push(`弧光：${row.arc}`)
      const aliases = parseAliases(row.aliasesJson)
      if (aliases.length) details.push(`别名：${aliases.join('、')}`)
      const detailLine = details.length ? `\n  ${details.join('；')}` : ''
      return `${head}${detailLine}\n  属性：${row.attributesJson} [来源:${row.id}]`
    }).join('\n'),
    sources: rows.map(row => ({ id: row.id, type: row.kind, status: row.status })),
  }
}

function parseAliases(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function chapterLines(rows: Array<{ chapter: Chapter; revision: ChapterRevision }>, full: boolean): { text: string; sources: ContextSource[] } {
  return {
    text: rows.map(({ chapter, revision }) => {
      const body = full ? revision.content : (revision.summary || revision.content.slice(0, 500))
      return `### 第${chapter.chapterNo}章 ${chapter.title} [正式版本:${revision.id}]\n${body}`
    }).join('\n\n'),
    sources: rows.map(({ revision }) => ({ id: revision.id, type: 'chapter', status: 'confirmed' })),
  }
}

function contractLines(project: Project): string {
  const parts: string[] = []
  if (project.pov) parts.push(`叙事视角：${project.pov}`)
  if (project.tense) parts.push(`时态：${project.tense}`)
  if (project.chapterWordsMin || project.chapterWordsMax) {
    parts.push(`单章字数：${project.chapterWordsMin || '不限'}–${project.chapterWordsMax || '不限'}`)
  }
  if (project.targetChapters) parts.push(`目标章数：${project.targetChapters}`)
  const themes = parseAliases(project.themesJson)
  if (themes.length) parts.push(`主题：${themes.join('、')}`)
  return parts.length ? `作品契约：${parts.join('；')}` : ''
}

export class ContextBuilder {
  constructor(private readonly store: NovelStore, private readonly config: RuntimeConfig) {}

  build(chapterId: string, outputTokens = this.config.maxTokens): ContextPack {
    const chapter = this.store.getChapter(chapterId)
    const project = this.store.getProject(chapter.projectId)
    const outline = chapter.outlineId ? this.store.getOutline(chapter.outlineId) : undefined
    const previous = this.store.listFinalChapters(project.id, chapter.chapterNo)
    const recent = previous.slice(-this.config.recentChapters)
    const older = previous.slice(0, Math.max(0, previous.length - recent.length))
    const confirmedEntities = this.store.listEntities(project.id, undefined, 'confirmed')
    const plannedEntities = this.store.listEntities(project.id).filter(row => row.status !== 'confirmed')
    const events = this.store.listEvents(project.id)
    const openForeshadowing = this.store.listForeshadowing(project.id).filter(row => row.status === 'open' || row.status === 'reinforced')
    const sections: Section[] = []

    const currentSources: ContextSource[] = outline ? [{ id: outline.id, type: 'outline', status: 'planned' }] : []
    sections.push({
      name: '当前章节与硬约束', priority: 0,
      text: [
        `项目：${project.title}（${project.genre}）`,
        `故事前提：${project.premise}`,
        `文风规范：${project.styleGuide}`,
        contractLines(project),
        `当前章节：第${chapter.chapterNo}章 ${chapter.title}`,
        `章纲（计划，不是已发生事实）：${outline?.content ?? '无'}`,
        '硬约束：不得把计划或草稿当作事实；不得无依据改变人物能力、生死、关系和世界观规则。',
      ].filter(Boolean).join('\n'),
      sources: currentSources,
    })
    const characters = entityLines(confirmedEntities.filter(row => row.kind === 'character'), true)
    if (characters.text) sections.push({ name: '人物当前正式状态', priority: 1, text: characters.text, sources: characters.sources })
    const world = entityLines(confirmedEntities.filter(row => row.kind !== 'character'))
    if (world.text) sections.push({ name: '正式世界观与规则', priority: 2, text: world.text, sources: world.sources })

    // 人物关系：冲突与张力的直接来源。
    const relationRows = this.store.listRelations(project.id)
    if (relationRows.length) {
      sections.push({
        name: '人物与势力关系',
        priority: 2,
        text: relationRows
          .map(row => `- ${row.sourceName} —${row.kind}→ ${row.targetName}${row.tension ? `（张力：${row.tension}）` : ''}${row.status !== 'active' ? ` [${row.status}]` : ''} [来源:${row.id}]`)
          .join('\n'),
        sources: relationRows.map(row => ({ id: row.id, type: 'relation', status: row.status })),
      })
    }

    // 剧情线：主线/支线的当前目标与进度。
    const threadRows = this.store.listPlotThreads(project.id).filter(row => row.status !== 'closed')
    if (threadRows.length) {
      sections.push({
        name: '剧情线（主线与支线）',
        priority: 2,
        text: threadRows
          .map(row => `- [${row.kind}] ${row.name}（${row.status}）${row.goal ? `目标：${row.goal}` : ''}${row.summary ? ` · ${row.summary}` : ''} [来源:${row.id}]`)
          .join('\n'),
        sources: threadRows.map(row => ({ id: row.id, type: 'thread', status: row.status })),
      })
    }

    // 本章场景/节拍：写作时最直接的落地指令。
    const sceneRows = this.store.listScenes(chapter.id)
    if (sceneRows.length) {
      sections.push({
        name: '本章场景与节拍（计划）',
        priority: 1,
        text: sceneRows
          .map(row => `- S${row.sceneNo}${row.beat ? `[${row.beat}]` : ''} 目标：${row.goal || '未填'}；冲突：${row.conflict || '未填'}；结果：${row.outcome || '未填'}${row.castNames.length ? `；出场：${row.castNames.join('、')}` : ''} [来源:${row.id}]`)
          .join('\n'),
        sources: sceneRows.map(row => ({ id: row.id, type: 'scene', status: row.status })),
      })
    }
    if (recent.length) {
      const data = chapterLines(recent, true)
      sections.push({ name: '最近正式章节正文', priority: 3, text: data.text, sources: data.sources })
    }
    if (older.length) {
      const data = chapterLines(older, false)
      sections.push({ name: '较早章节摘要', priority: 5, text: data.text, sources: data.sources })
    }
    if (openForeshadowing.length) {
      sections.push({
        name: '未回收伏笔', priority: 4,
        text: openForeshadowing.map(row => `- ${row.name}：${row.description} [来源:${row.id}]`).join('\n'),
        sources: openForeshadowing.map(row => ({ id: row.id, type: 'foreshadowing', status: row.status })),
      })
    }
    if (events.length) {
      sections.push({
        name: '事件时间线（逐项标注状态）', priority: 4,
        text: events.map(row => `- [${row.status}] ${row.eventTime || '未定时间'}：${row.summary} [来源:${row.id}]`).join('\n'),
        sources: events.map(row => ({ id: row.id, type: 'event', status: row.status })),
      })
    }
    if (plannedEntities.length) {
      const data = entityLines(plannedEntities, true)
      sections.push({ name: '计划或待确认资料（禁止视为事实）', priority: 6, text: data.text, sources: data.sources })
    }

    const budgetTokens = Math.max(1000, Math.min(this.config.maxInputTokens, this.config.maxContextTokens - outputTokens))
    let remaining = budgetTokens
    let truncated = false
    const omittedSections: string[] = []
    const accepted: string[] = []
    const sources: ContextSource[] = []
    for (const section of sections.sort((a, b) => a.priority - b.priority)) {
      const header = `\n\n## ${section.name}\n`
      const overhead = estimateTokens(header) + 2
      if (remaining <= overhead + 40) {
        omittedSections.push(section.name)
        continue
      }
      const sectionCap = section.priority === 0
        ? remaining
        : Math.min(remaining, Math.max(300, Math.floor(budgetTokens * (section.priority <= 2 ? 0.2 : 0.28))))
      const fitted = truncateToTokens(section.text, sectionCap - overhead)
      if (!fitted.text) {
        omittedSections.push(section.name)
        continue
      }
      truncated ||= fitted.truncated
      accepted.push(`${header}${fitted.text}`)
      sources.push(...section.sources)
      remaining -= estimateTokens(accepted.at(-1) ?? '')
    }
    const text = accepted.join('').trim()
    return {
      projectId: project.id, chapterId, text,
      estimatedTokens: estimateTokens(text), budgetTokens, truncated, omittedSections,
      sources: [...new Map(sources.map(source => [source.id, source])).values()],
    }
  }
}

export type ContextData = {
  outline?: Outline
  entities: Entity[]
  events: StoryEvent[]
  foreshadowing: Foreshadowing[]
}
