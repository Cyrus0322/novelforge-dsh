import type { ChatMessage } from '../llm/client.js'
import type { ChapterPlan, ReviewIssueInput } from '../domain/schemas.js'
import type { Project, ReviewIssue } from '../database/store.js'
import { truncateToTokens } from '../retrieval/context.js'

const JSON_ONLY = '只输出一个合法 JSON 对象，不要 Markdown 代码围栏，不要解释。'
const FACT_RULES = '严格区分正式事实、计划和草稿。计划事件尚未发生；不得擅自改变已确认的人物状态、能力、关系、生死和世界观。'

export function blueprintMessages(idea: string): ChatMessage[] {
  return [
    { role: 'system', content: `你是长篇网文总策划。${FACT_RULES}${JSON_ONLY}` },
    { role: 'user', content: `根据创作意图生成可扩展的小说项目蓝图。人物应有明确动机、能力边界和关系张力；世界规则应可检验，避免空泛设定。\n创作意图：${idea}\nJSON 结构：{"title":"...","genre":"...","premise":"...","styleGuide":"...","characters":[{"name":"...","summary":"...","attributes":{"motivation":"...","limits":"..."}}],"worldRules":[{"name":"...","summary":"...","attributes":{"forbiddenTerms":[]}}]}` },
  ]
}

export function outlineMessages(project: Project, entitiesText: string, chapterCount: number): ChatMessage[] {
  return [
    { role: 'system', content: `你是长篇小说结构编辑。${FACT_RULES}${JSON_ONLY}` },
    { role: 'user', content: `为《${project.title}》规划后续恰好 ${chapterCount} 章，可分卷。每章必须有目标、冲突和结尾钩子，情节逐步升级，避免重复。\n前提：${project.premise}\n已有正式资料：\n${entitiesText}\nJSON 结构：{"volumes":[{"title":"...","summary":"...","chapters":[{"title":"...","summary":"...","goal":"...","conflict":"...","hook":"..."}]}]}` },
  ]
}

export function chapterPlanMessages(context: string): ChatMessage[] {
  return [
    { role: 'system', content: `你是章节策划编辑。${FACT_RULES}${JSON_ONLY}` },
    { role: 'user', content: `${context}\n\n基于以上资料制定本章执行计划，不替代章纲随意改主线。\nJSON 结构：{"title":"...","goal":"...","conflict":"...","turn":"...","hook":"...","involvedCharacters":["..."],"constraints":["..."]}` },
  ]
}

export function draftMessages(context: string, plan: ChapterPlan): ChatMessage[] {
  return [
    { role: 'system', content: `你是中文长篇小说作者。${FACT_RULES}写正文而非提纲；保持叙述视角和人物语气一致，以场景、行动和对白推进，不总结创作过程。` },
    { role: 'user', content: `${context}\n\n## 本章执行计划\n${JSON.stringify(plan)}\n\n请直接输出本章完整正文。不要输出标题、JSON、解释或“以下是正文”。` },
  ]
}

export function continueMessages(context: string, currentContent: string, instruction: string): ChatMessage[] {
  const fitted = truncateToTokens(currentContent, 8000)
  return [
    { role: 'system', content: `你是中文长篇小说作者。${FACT_RULES}只写接续部分，保持原文叙事视角、时态、人物语气和场景连续性。` },
    { role: 'user', content: `${context}\n\n## 现有正文${fitted.truncated ? '（因预算仅提供首尾）' : ''}\n${fitted.text}\n\n## 续写要求\n${instruction || '自然承接当前场景并推进冲突。'}\n只输出新增正文，不重复已有内容，不加解释。` },
  ]
}

export function rewriteMessages(context: string, currentContent: string, instruction: string): ChatMessage[] {
  const fitted = truncateToTokens(currentContent, 10_000)
  return [
    { role: 'system', content: `你是中文小说修订编辑。${FACT_RULES}保留仍然有效的情节，仅按修订要求改善正文，输出完整替换版本。` },
    { role: 'user', content: `${context}\n\n## 当前版本${fitted.truncated ? '（因预算仅提供首尾）' : ''}\n${fitted.text}\n\n## 修订要求\n${instruction}\n只输出修订后的完整正文，不加解释。` },
  ]
}

export function reviewMessages(context: string, content: string): ChatMessage[] {
  const fitted = truncateToTokens(content, 14_000)
  return [
    { role: 'system', content: `你是严格但不得臆测的小说审稿器。${FACT_RULES}每个问题必须引用正文位置或正式资料来源；没有证据不要报告。位置采用 JavaScript UTF-16 字符偏移。${JSON_ONLY}` },
    { role: 'user', content: `${context}\n\n## 待审正文${fitted.truncated ? '（因预算仅提供首尾；不得对未提供部分下结论）' : ''}\n${fitted.text}\n\n审查连续性、因果、人物、剧情、文风和伏笔。\nJSON 结构：{"summary":"...","issues":[{"category":"continuity|causality|character|plot|style|foreshadowing","severity":"minor|major|critical","start":0,"end":10,"issue":"...","evidence":[{"sourceId":"正式资料或版本ID","description":"证据"}],"suggestedFix":"..."}]}` },
  ]
}

export function revisionMessages(context: string, content: string, issues: ReviewIssue[], extraInstruction: string): ChatMessage[] {
  const simplified: ReviewIssueInput[] = issues.map(issue => ({
    category: issue.category as ReviewIssueInput['category'],
    severity: issue.severity as ReviewIssueInput['severity'],
    start: issue.locationStart,
    end: issue.locationEnd,
    issue: issue.issue,
    evidence: JSON.parse(issue.evidenceJson) as ReviewIssueInput['evidence'],
    suggestedFix: issue.suggestedFix,
  }))
  const instruction = `优先修复以下已确认问题，不引入新设定或新的连续性冲突：\n${JSON.stringify(simplified)}\n其他要求：${extraInstruction || '无'}`
  return rewriteMessages(context, content, instruction)
}
