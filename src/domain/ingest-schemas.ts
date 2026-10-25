import { z } from 'zod'
import { entityKindSchema, factStatusSchema } from './schemas.js'

/**
 * 素材抽取的结构化契约。
 *
 * 设计依据 docs/story-bible.md §E：所有抽取项必须带 `evidence`（原文片段），
 * 服务端会逐条校验它是否真的是素材的子串（quote-or-drop），
 * 模型臆造的条目会被丢弃而不是写进资料库。
 */
const evidenceSchema = z.string().min(2).max(500)

export const ingestEntitySchema = z.object({
  kind: entityKindSchema,
  name: z.string().min(1).max(80),
  summary: z.string().max(2000).optional(),
  role: z.string().max(40).optional(),
  goal: z.string().max(500).optional(),
  motivation: z.string().max(500).optional(),
  flaw: z.string().max(500).optional(),
  secret: z.string().max(500).optional(),
  voice: z.string().max(500).optional(),
  arc: z.string().max(500).optional(),
  aliases: z.array(z.string().max(40)).max(8).optional(),
  importance: z.number().int().min(1).max(5).optional(),
  status: factStatusSchema.optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  evidence: evidenceSchema,
})

export const ingestRelationSchema = z.object({
  source: z.string().min(1).max(80),
  target: z.string().min(1).max(80),
  relationType: z.string().min(1).max(30),
  tension: z.string().max(300).optional(),
  notes: z.string().max(500).optional(),
  evidence: evidenceSchema,
})

export const ingestEventSchema = z.object({
  summary: z.string().min(2).max(600),
  eventTime: z.string().max(60).optional(),
  status: factStatusSchema.optional(),
  participants: z.array(z.string().max(80)).max(12).optional(),
  importance: z.number().int().min(1).max(5).optional(),
  evidence: evidenceSchema,
})

export const ingestForeshadowingSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(800).optional(),
  category: z.string().max(30).optional(),
  importance: z.number().int().min(1).max(5).optional(),
  notes: z.string().max(500).optional(),
  evidence: evidenceSchema,
})

export const ingestThreadSchema = z.object({
  name: z.string().min(1).max(80),
  threadKind: z.enum(['main', 'sub', 'romance', 'mystery', 'revenge', 'growth']).optional(),
  goal: z.string().max(400).optional(),
  summary: z.string().max(800).optional(),
  evidence: evidenceSchema,
})

export const ingestProjectPatchSchema = z.object({
  premise: z.string().max(2000).optional(),
  styleGuide: z.string().max(3000).optional(),
  pov: z.string().max(40).optional(),
  tense: z.string().max(20).optional(),
  themes: z.array(z.string().max(40)).max(10).optional(),
})

export const ingestExtractionSchema = z.object({
  project: ingestProjectPatchSchema.optional(),
  entities: z.array(ingestEntitySchema).max(60).default([]),
  relations: z.array(ingestRelationSchema).max(60).default([]),
  events: z.array(ingestEventSchema).max(60).default([]),
  foreshadowing: z.array(ingestForeshadowingSchema).max(30).default([]),
  threads: z.array(ingestThreadSchema).max(20).default([]),
  conflicts: z.array(z.object({
    type: z.string().max(30),
    description: z.string().max(400),
    evidence: z.string().max(500).optional(),
  })).max(20).default([]),
})

export type IngestExtraction = z.infer<typeof ingestExtractionSchema>
export type IngestEntity = z.infer<typeof ingestEntitySchema>

export interface IngestStats {
  entities: number
  relations: number
  events: number
  foreshadowing: number
  threads: number
  projectPatch: number
  dropped: number
  conflicts: number
  droppedReasons: Record<string, number>
}
