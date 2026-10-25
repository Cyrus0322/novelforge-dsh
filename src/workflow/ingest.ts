import type { NovelStore, ChangeProposal, IngestBatch, Entity } from '../database/store.js'
import type { LlmClient } from '../llm/client.js'
import type { RuntimeConfig } from '../shared/config.js'
import { completeStructured } from '../llm/structured.js'
import { ingestExtractionSchema } from '../domain/ingest-schemas.js'
import type { IngestStats } from '../domain/ingest-schemas.js'
import { ingestMessages } from './ingest-prompt.js'
import { NovelForgeError, errorMessage, requireNonEmpty } from '../shared/errors.js'
import { parseJson } from '../shared/json.js'
import { truncateToTokens, estimateTokens } from '../retrieval/context.js'

export interface IngestDeps {
  store: NovelStore
  llm: LlmClient
  config: RuntimeConfig
}

export interface IngestInput {
  material: string
  title?: string | undefined
  focus?: string | undefined
  mode?: 'propose' | 'apply' | undefined
}

export interface IngestOutcome {
  batch: IngestBatch
  stats: IngestStats
  proposals: ChangeProposal[]
  applied?: { applied: string[]; failed: Array<{ id: string; error: string }> } | undefined
}

const MAX_MATERIAL_TOKENS = 12_000
const MIN_MATERIAL_CHARS = 20

/** 去掉空白后比对，避免模型把换行/空格复制错导致误判。 */
function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, '')
}

function evidenceSupported(evidence: string | undefined, haystack: string): boolean {
  if (!evidence) return false
  const needle = normalizeForMatch(evidence)
  return needle.length >= 2 && haystack.includes(needle)
}

function findByAlias(entities: Entity[], name: string): Entity | undefined {
  const target = name.trim().toLowerCase()
  for (const entity of entities) {
    if (entity.name.trim().toLowerCase() === target) return entity
    const aliases = parseJson<string[]>(entity.aliasesJson, [])
    if (aliases.some(alias => alias.trim().toLowerCase() === target)) return entity
  }
  return undefined
}

/**
 * 素材 → 结构化资料库。
 *
 * 流程：建批次 → 调模型抽结构 → 逐条校验 evidence 是否真在素材里（quote-or-drop）
 * → 转成待审批的 change_proposals → 返回统计。mode='apply' 时再一次性应用。
 */
export async function runIngest(
  deps: IngestDeps,
  projectId: string,
  input: IngestInput,
  signal?: AbortSignal,
): Promise<IngestOutcome> {
  const { store, llm, config } = deps
  const project = store.getProject(projectId)
  const material = requireNonEmpty(input.material, '素材正文')
  if (material.length < MIN_MATERIAL_CHARS) {
    throw new NovelForgeError('INVALID_INPUT', `素材太短（${material.length} 字），至少需要 ${MIN_MATERIAL_CHARS} 字才能抽出可用资料。`)
  }
  const mode = input.mode ?? 'propose'
  const fitted = truncateToTokens(material, MAX_MATERIAL_TOKENS)
  const haystack = normalizeForMatch(fitted.text)

  const batch = store.createIngestBatch({
    projectId,
    ...(input.title === undefined ? {} : { title: input.title }),
    sourceText: material,
    mode,
    ...(input.focus === undefined ? {} : { focus: input.focus }),
    model: config.model,
  })
  const workflow = store.startWorkflow(projectId, 'ingest_material', undefined)

  const existingEntities = store.listEntities(projectId)
  const existingThreads = store.listPlotThreads(projectId)
  const existingForeshadowing = store.listForeshadowing(projectId)

  const stats: IngestStats = {
    entities: 0, relations: 0, events: 0, foreshadowing: 0, threads: 0, knowledge: 0,
    projectPatch: 0, dropped: 0, conflicts: 0, droppedReasons: {},
  }
  const drop = (reason: string): void => {
    stats.dropped += 1
    stats.droppedReasons[reason] = (stats.droppedReasons[reason] ?? 0) + 1
  }

  try {
    store.checkpointWorkflow(workflow.id, 'ingest_started', { batchId: batch.id, chars: material.length })

    const { data } = await completeStructured(llm, {
      messages: ingestMessages({
        projectTitle: project.title,
        genre: project.genre,
        premise: project.premise,
        existingEntities: existingEntities
          .slice(0, 80)
          .map(entity => `${entity.name}（${entity.kind}）${entity.summary ? `：${entity.summary.slice(0, 60)}` : ''}`)
          .join('；'),
        existingThreads: existingThreads.map(thread => `${thread.name}（${thread.kind}）`).join('；'),
        existingForeshadowing: existingForeshadowing.map(item => item.name).join('；'),
        focus: input.focus ?? '',
        material: fitted.text,
      }),
      temperature: Math.min(0.3, config.temperature),
      maxTokens: Math.min(config.maxTokens, 4096),
    }, ingestExtractionSchema, signal)

    store.checkpointWorkflow(workflow.id, 'ingest_extracted', {
      entities: data.entities.length, relations: data.relations.length,
      events: data.events.length, foreshadowing: data.foreshadowing.length,
      threads: data.threads.length, conflicts: data.conflicts.length,
    })
    stats.conflicts = data.conflicts.length

    // —— 项目级文本：只在 apply 模式下直接落地（低风险纯文本字段）——
    if (data.project && Object.keys(data.project).length > 0) {
      stats.projectPatch = 1
    }

    // —— 实体 ——
    const entityIdByName = new Map<string, string>()
    const namesInBatch = new Set<string>()
    for (const existing of existingEntities) entityIdByName.set(existing.name.trim().toLowerCase(), existing.id)
    for (const item of data.entities) {
      if (!evidenceSupported(item.evidence, haystack)) { drop('entity_evidence_missing'); continue }
      const payload: Record<string, unknown> = { kind: item.kind, name: item.name }
      for (const key of ['summary', 'role', 'goal', 'motivation', 'flaw', 'secret', 'voice', 'arc', 'aliases', 'importance'] as const) {
        const value = (item as Record<string, unknown>)[key]
        if (value !== undefined) payload[key] = value
      }
      if (item.status !== undefined) payload.status = item.status
      if (item.attributes !== undefined) payload.attributes = item.attributes
      const existing = findByAlias(existingEntities, item.name)
      try {
        const proposal = store.proposeChange({
          projectId,
          targetType: 'entity',
          operation: existing ? 'update' : 'create',
          ...(existing ? { targetId: existing.id, expectedVersion: existing.version } : {}),
          payload,
          batchId: batch.id,
          source: 'ai_ingest',
          ...(item.importance === undefined ? {} : { confidence: item.importance / 5 }),
        })
        stats.entities += 1
        namesInBatch.add(item.name.trim().toLowerCase())
        if (existing) entityIdByName.set(existing.name.trim().toLowerCase(), existing.id)
      } catch (error) {
        metricsFail(stats, 'entity_proposal_failed', error)
      }
    }

    // —— 关系：两端必须能在资料库或本批抽取结果里找到（应用时再解析成 ID）——
    for (const item of data.relations) {
      if (!evidenceSupported(item.evidence, haystack)) { drop('relation_evidence_missing'); continue }
      const sourceKey = item.source.trim().toLowerCase()
      const targetKey = item.target.trim().toLowerCase()
      const known = (key: string): boolean => entityIdByName.has(key) || namesInBatch.has(key)
      if (!known(sourceKey) || !known(targetKey) || sourceKey === targetKey) { drop('relation_unknown_entity'); continue }
      try {
        store.proposeChange({
          projectId, targetType: 'relation', operation: 'create',
          payload: {
            sourceName: item.source.trim(), targetName: item.target.trim(),
            ...(entityIdByName.get(sourceKey) === undefined ? {} : { sourceId: entityIdByName.get(sourceKey) }),
            ...(entityIdByName.get(targetKey) === undefined ? {} : { targetId: entityIdByName.get(targetKey) }),
            relationType: item.relationType,
            ...(item.tension === undefined ? {} : { tension: item.tension }),
            ...(item.notes === undefined ? {} : { notes: item.notes }),
          },
          batchId: batch.id, source: 'ai_ingest',
        })
        stats.relations += 1
      } catch (error) {
        metricsFail(stats, 'relation_proposal_failed', error)
      }
    }

    // —— 事件 ——
    for (const item of data.events) {
      if (!evidenceSupported(item.evidence, haystack)) { drop('event_evidence_missing'); continue }
      try {
        store.proposeChange({
          projectId, targetType: 'event', operation: 'create',
          payload: {
            summary: item.summary,
            ...(item.eventTime === undefined ? {} : { eventTime: item.eventTime }),
            status: item.status ?? 'confirmed',
            ...(item.participants === undefined ? {} : { participants: item.participants }),
            ...(item.importance === undefined ? {} : { importance: item.importance }),
          },
          batchId: batch.id, source: 'ai_ingest',
        })
        stats.events += 1
      } catch (error) {
        metricsFail(stats, 'event_proposal_failed', error)
      }
    }

    // —— 伏笔 ——
    for (const item of data.foreshadowing) {
      if (!evidenceSupported(item.evidence, haystack)) { drop('foreshadowing_evidence_missing'); continue }
      const existing = existingForeshadowing.find(entry => entry.name.trim() === item.name.trim())
      try {
        store.proposeChange({
          projectId, targetType: 'foreshadowing', operation: existing ? 'update' : 'create',
          ...(existing ? { targetId: existing.id, expectedVersion: existing.version } : {}),
          payload: {
            name: item.name,
            ...(item.description === undefined ? {} : { description: item.description }),
            ...(item.category === undefined ? {} : { category: item.category }),
            ...(item.notes === undefined ? {} : { notes: item.notes }),
            ...(item.importance === undefined ? {} : { importance: item.importance }),
          },
          batchId: batch.id, source: 'ai_ingest',
        })
        stats.foreshadowing += 1
      } catch (error) {
        metricsFail(stats, 'foreshadowing_proposal_failed', error)
      }
    }

    // —— 剧情线 ——
    for (const item of data.threads) {
      if (!evidenceSupported(item.evidence, haystack)) { drop('thread_evidence_missing'); continue }
      const existing = existingThreads.find(thread => thread.name.trim() === item.name.trim())
      try {
        store.proposeChange({
          projectId, targetType: 'thread', operation: existing ? 'update' : 'create',
          ...(existing ? { targetId: existing.id, expectedVersion: existing.version } : {}),
          payload: {
            name: item.name,
            ...(item.threadKind === undefined ? {} : { threadKind: item.threadKind }),
            ...(item.goal === undefined ? {} : { goal: item.goal }),
            ...(item.summary === undefined ? {} : { summary: item.summary }),
          },
          batchId: batch.id, source: 'ai_ingest',
        })
        stats.threads += 1
      } catch (error) {
        metricsFail(stats, 'thread_proposal_failed', error)
      }
    }

    // —— 知情事实（谁知道什么）——
    for (const item of data.knowledge) {
      if (!evidenceSupported(item.evidence, haystack)) { drop('knowledge_evidence_missing'); continue }
      // 只保留能在本批或资料库里找到名字的知情者，避免脏数据
      const knowers = (item.knowers ?? []).filter(knower => {
        const key = knower.name.trim().toLowerCase()
        return entityIdByName.has(key) || namesInBatch.has(key)
      })
      if ((item.knowers ?? []).length > 0 && knowers.length === 0) { drop('knowledge_unknown_knower'); continue }
      try {
        store.proposeChange({
          projectId, targetType: 'knowledge', operation: 'create',
          payload: {
            proposition: item.proposition,
            ...(item.truth === undefined ? {} : { truth: item.truth }),
            ...(item.publicLevel === undefined ? {} : { publicLevel: item.publicLevel }),
            ...(knowers.length ? { knowers } : {}),
          },
          batchId: batch.id, source: 'ai_ingest',
        })
        stats.knowledge += 1
      } catch (error) {
        metricsFail(stats, 'knowledge_proposal_failed', error)
      }
    }

    // —— 素材内部矛盾：记进批次统计，供界面提示 ——
    const conflicts = data.conflicts

    store.updateIngestBatch(batch.id, {
      status: mode === 'apply' ? 'applying' : 'ready',
      stats: { ...stats, conflicts, conflictList: conflicts, truncated: fitted.truncated, estimatedTokens: estimateTokens(fitted.text) },
    })

    let applied: IngestOutcome['applied']
    if (mode === 'apply') {
      // 项目级文本字段（前提/文风/POV）风险低，apply 模式下直接落地并写审计。
      if (data.project && Object.keys(data.project).length > 0) {
        store.updateProject(projectId, {
          ...(data.project.premise === undefined ? {} : { premise: data.project.premise }),
          ...(data.project.styleGuide === undefined ? {} : { styleGuide: data.project.styleGuide }),
          ...(data.project.pov === undefined ? {} : { pov: data.project.pov }),
          ...(data.project.tense === undefined ? {} : { tense: data.project.tense }),
          ...(data.project.themes === undefined ? {} : { themes: data.project.themes }),
        })
      }
      applied = store.applyIngestBatch(batch.id, true)
    }

    store.finishWorkflow(workflow.id, 'completed', { batchId: batch.id, stats })
    return {
      batch: store.getIngestBatch(batch.id),
      stats,
      proposals: store.listProposalsByBatch(batch.id),
      ...(applied === undefined ? {} : { applied }),
    }
  } catch (error) {
    store.updateIngestBatch(batch.id, { status: 'failed', error: errorMessage(error), stats })
    store.finishWorkflow(workflow.id, 'failed', { batchId: batch.id }, errorMessage(error))
    throw error
  }
}

function metricsFail(stats: IngestStats, reason: string, error: unknown): void {
  stats.dropped += 1
  stats.droppedReasons[reason] = (stats.droppedReasons[reason] ?? 0) + 1
  void error
}
