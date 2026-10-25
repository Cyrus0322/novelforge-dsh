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
  kind: entityKindSchema.optional(),
  name: z.string().min(1).optional(),
  summary: z.string().optional(),
  attributes: attributesSchema.optional(),
  status: factStatusSchema.optional(),
  eventTime: z.string().optional(),
  description: z.string().optional(),
  plantChapterId: z.string().nullable().optional(),
  payoffChapterId: z.string().nullable().optional(),
}).refine(value => Object.keys(value).length > 0, '变更 payload 不能为空。')

export const writingResultSchema = z.object({
  content: z.string().min(1),
})
