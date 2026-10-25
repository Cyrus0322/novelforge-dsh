import { z } from 'zod'

export const factStatusSchema = z.enum(['planned', 'draft', 'confirmed', 'cancelled'])
export type FactStatus = z.infer<typeof factStatusSchema>

export const entityKindSchema = z.enum(['character', 'world_rule', 'location', 'faction', 'item', 'event', 'other'])
export type EntityKind = z.infer<typeof entityKindSchema>

export const attributesSchema = z.record(z.string(), z.unknown()).default({})

export const blueprintEntitySchema = z.object({
  name: z.string().min(1),
  summary: z.string().min(1),
  attributes: attributesSchema,
})

export const blueprintSchema = z.object({
  title: z.string().min(1),
  genre: z.string().min(1),
  premise: z.string().min(1),
  styleGuide: z.string().min(1),
  characters: z.array(blueprintEntitySchema).max(30).default([]),
  worldRules: z.array(blueprintEntitySchema).max(50).default([]),
})
export type NovelBlueprint = z.infer<typeof blueprintSchema>

export const outlineChapterSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  goal: z.string().min(1),
  conflict: z.string().min(1),
  hook: z.string().min(1),
})

export const outlinePlanSchema = z.object({
  volumes: z.array(z.object({
    title: z.string().min(1),
    summary: z.string().min(1),
    chapters: z.array(outlineChapterSchema).min(1).max(100),
  })).min(1).max(20),
})
export type OutlinePlan = z.infer<typeof outlinePlanSchema>

export const chapterPlanSchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  conflict: z.string().min(1),
  turn: z.string().min(1),
  hook: z.string().min(1),
  involvedCharacters: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
})
export type ChapterPlan = z.infer<typeof chapterPlanSchema>

export const reviewIssueSchema = z.object({
  category: z.enum(['continuity', 'causality', 'character', 'plot', 'style', 'foreshadowing']),
  severity: z.enum(['minor', 'major', 'critical']),
  start: z.number().int().nonnegative().nullable().default(null),
  end: z.number().int().nonnegative().nullable().default(null),
  issue: z.string().min(1),
  evidence: z.array(z.object({
    sourceId: z.string().min(1),
    description: z.string().min(1),
  })).default([]),
  suggestedFix: z.string().min(1),
})
export type ReviewIssueInput = z.infer<typeof reviewIssueSchema>

export const reviewResultSchema = z.object({
  summary: z.string(),
  issues: z.array(reviewIssueSchema).max(100).default([]),
})
export type ReviewResult = z.infer<typeof reviewResultSchema>

export const changePayloadSchema = z.object({
  // 实体通用
  kind: entityKindSchema.optional(),
  name: z.string().min(1).optional(),
  summary: z.string().optional(),
  attributes: attributesSchema.optional(),
  status: factStatusSchema.optional(),
  // 人物档案
  role: z.string().optional(),
  goal: z.string().optional(),
  motivation: z.string().optional(),
  flaw: z.string().optional(),
  secret: z.string().optional(),
  voice: z.string().optional(),
  arc: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  firstAppearanceChapterId: z.string().nullable().optional(),
  importance: z.number().int().min(1).max(5).optional(),
  // 事件
  eventTime: z.string().optional(),
  participants: z.array(z.string()).optional(),
  locationEntityId: z.string().nullable().optional(),
  // 伏笔
  description: z.string().optional(),
  kind2: z.string().optional(),
  plantChapterId: z.string().nullable().optional(),
  payoffChapterId: z.string().nullable().optional(),
  notes: z.string().optional(),
  // 伏笔类型（避免和 kind 的实体类型枚举冲突）
  category: z.string().optional(),
  // 关系与剧情线（素材导入会用到）
  sourceId: z.string().optional(),
  targetId: z.string().optional(),
  sourceName: z.string().optional(),
  targetName: z.string().optional(),
  relationType: z.string().optional(),
  tension: z.string().optional(),
  threadKind: z.enum(['main', 'sub', 'romance', 'mystery', 'revenge', 'growth']).optional(),
}).refine(
  value => Boolean(
    value.name?.trim() || value.summary?.trim() || value.description?.trim() || value.eventTime?.trim()
    || value.goal?.trim() || value.role?.trim() || value.notes?.trim()
    || value.sourceName?.trim() || value.relationType?.trim() || value.threadKind?.trim(),
  ),
  '变更 payload 至少需要 name / summary / description / eventTime 之一，不能是空对象。',
)

export const writingResultSchema = z.object({
  content: z.string().min(1),
})
