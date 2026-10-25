import { afterEach, describe, expect, it } from 'vitest'
import { NovelStore } from '../src/database/store.js'
import { NovelService } from '../src/workflow/novel-service.js'
import { MockLlm, json, testConfig } from './helpers.js'

/**
 * 素材 → 资料库（ingest）：
 * - 每条抽取都必须能在素材里找到 evidence，否则丢弃（quote-or-drop）
 * - 抽取结果默认进入待审批提议，不直接改正式资料
 * - mode='apply' 时一次性应用；关系两端必须已存在于资料库
 */

const MATERIAL = `林渊，24岁，镇魔司外勤。母亲在他十二岁那年失踪，他因此一直想证明自己不是灾星。
他习惯独走，说话很短，常挂一句「行吧」。右眉骨有一道旧疤。
沈砚是他的搭档，两人关系紧张——沈砚曾隐瞒上级命令。
归墟巷在老城区，子时后只有引气五层以上的人能进。
青铜灯是林渊父亲留下的法器，每月只能封存一次回响。`

const extraction = {
  entities: [
    { kind: 'character', name: '林渊', summary: '镇魔司外勤，母亲失踪', role: '主角', goal: '查清母亲失踪', motivation: '证明自己不是灾星', flaw: '习惯独走', voice: '说话很短，常挂「行吧」', evidence: '林渊，24岁，镇魔司外勤' },
    { kind: 'character', name: '沈砚', summary: '林渊的搭档', role: '搭档', evidence: '沈砚是他的搭档' },
    { kind: 'location', name: '归墟巷', summary: '老城区，子时后需引气五层', evidence: '归墟巷在老城区' },
    { kind: 'item', name: '青铜灯', summary: '每月只能封存一次回响', evidence: '青铜灯是林渊父亲留下的法器' },
    { kind: 'character', name: '林无咎', summary: '模型编出来的角色', evidence: '这段原文里根本没有林无咎这个人' },
  ],
  relations: [
    { source: '林渊', target: '沈砚', relationType: '搭档', tension: '沈砚曾隐瞒上级命令', evidence: '沈砚是他的搭档' },
    { source: '林渊', target: '不存在的人', relationType: '敌人', evidence: '沈砚是他的搭档' },
  ],
  events: [
    { summary: '林渊母亲在他十二岁那年失踪', eventTime: '十二岁那年', importance: 5, evidence: '母亲在他十二岁那年失踪' },
  ],
  foreshadowing: [
    { name: '青铜灯的回响', description: '每月只能封存一次', category: '道具', importance: 4, evidence: '每月只能封存一次回响' },
  ],
  threads: [
    { name: '查清母亲失踪', threadKind: 'main', goal: '找到母亲失踪真相', evidence: '他因此一直想证明自己不是灾星' },
  ],
  conflicts: [
    { type: 'setting', description: '素材没说清归墟巷的进入条件例外', evidence: '子时后只有引气五层以上的人能进' },
  ],
}

let store: NovelStore | null = null

function makeService(reply: unknown): NovelService {
  store = new NovelStore(':memory:')
  const llm = new MockLlm(() => json(reply))
  return new NovelService(store, llm, testConfig())
}

afterEach(() => {
  store?.close()
  store = null
})

describe('素材导入 ingest', () => {
  it('抽取结果进入待审批提议，编造的条目因证据缺失被丢弃', async () => {
    const service = makeService(extraction)
    const project = service.createProject({ title: '归墟', genre: '都市异能' })

    const outcome = await service.ingestMaterial(project.id, { material: MATERIAL, title: '初始设定' })

    // 4 条实体有原文依据；林无咎的 evidence 不在素材里 → 丢弃
    expect(outcome.stats.entities).toBe(4)
    expect(outcome.stats.droppedReasons.entity_evidence_missing).toBe(1)
    // 关系：只有两端都存在于资料库的那条能生成；未知人物那条丢弃
    expect(outcome.stats.relations).toBe(1)
    expect(outcome.stats.droppedReasons.relation_unknown_entity).toBe(1)
    expect(outcome.stats.events).toBe(1)
    expect(outcome.stats.foreshadowing).toBe(1)
    expect(outcome.stats.threads).toBe(1)
    expect(outcome.stats.conflicts).toBe(1)

    // 提议都是 pending，带 batchId 与来源
    expect(outcome.proposals.length).toBeGreaterThanOrEqual(7)
    expect(outcome.proposals.every(proposal => proposal.status === 'pending')).toBe(true)
    expect(outcome.proposals.every(proposal => proposal.batchId === outcome.batch.id)).toBe(true)
    expect(outcome.proposals.every(proposal => proposal.source === 'ai_ingest')).toBe(true)

    // 正式资料没有被直接改写
    expect(service.store.listEntities(project.id)).toHaveLength(0)
    expect(service.store.listPlotThreads(project.id)).toHaveLength(0)
  })

  it('应用批次后正式资料落库，关系两端正确解析', async () => {
    const service = makeService(extraction)
    const project = service.createProject({ title: '归墟', genre: '都市异能' })
    const outcome = await service.ingestMaterial(project.id, { material: MATERIAL })

    const applied = service.applyIngestBatch(outcome.batch.id, true)
    expect(applied.applied.length).toBe(outcome.proposals.length)
    expect(applied.failed).toHaveLength(0)

    const entities = service.store.listEntities(project.id)
    expect(entities.map(entity => entity.name).sort()).toEqual(['归墟巷', '沈砚', '林渊', '青铜灯'].sort())
    const lin = entities.find(entity => entity.name === '林渊')
    expect(lin?.role).toBe('主角')
    expect(lin?.goal).toBe('查清母亲失踪')
    expect(lin?.flaw).toBe('习惯独走')

    const relations = service.store.listRelations(project.id)
    expect(relations).toHaveLength(1)
    expect(relations[0]?.sourceName).toBe('林渊')
    expect(relations[0]?.targetName).toBe('沈砚')
    expect(relations[0]?.kind).toBe('搭档')

    expect(service.store.listPlotThreads(project.id)[0]?.name).toBe('查清母亲失踪')
    expect(service.store.listForeshadowing(project.id)[0]?.name).toBe('青铜灯的回响')
    expect(service.store.listEvents(project.id)[0]?.summary).toContain('母亲')

    expect(service.store.getIngestBatch(outcome.batch.id).status).toBe('applied')
  })

  it('mode=apply 时直接应用，并把项目级文本（前提/风格）写回', async () => {
    const payload = {
      project: { premise: '一个能读取死者最后一秒的外勤，用折寿换线索。', pov: '三人称限知', themes: ['代价', '亲情'] },
      entities: [
        { kind: 'character', name: '林渊', summary: '外勤', evidence: '林渊，24岁，镇魔司外勤' },
      ],
      relations: [], events: [], foreshadowing: [], threads: [], conflicts: [],
    }
    const service = makeService(payload)
    const project = service.createProject({ title: '归墟', genre: '都市异能' })

    const outcome = await service.ingestMaterial(project.id, { material: MATERIAL, mode: 'apply' })
    expect(outcome.applied?.failed).toHaveLength(0)
    expect(service.store.listEntities(project.id)).toHaveLength(1)
    expect(service.store.getProject(project.id).pov).toBe('三人称限知')
    expect(service.store.getProject(project.id).premise).toContain('折寿')
  })

  it('能从素材里抽「谁知道什么」，并解析知情者', async () => {
    const material = '林渊每次回响会折寿三日。这件事只有他自己知道，沈砚一直蒙在鼓里。'
    const payload = {
      entities: [
        { kind: 'character', name: '林渊', summary: '外勤', evidence: '林渊每次回响会折寿三日' },
        { kind: 'character', name: '沈砚', summary: '搭档', evidence: '沈砚一直蒙在鼓里' },
      ],
      knowledge: [
        {
          proposition: '林渊每次回响会折寿三日',
          truth: 'true',
          publicLevel: 'secret',
          knowers: [{ name: '林渊', state: 'knows' }, { name: '沈砚', state: 'unaware' }],
          evidence: '这件事只有他自己知道，沈砚一直蒙在鼓里',
        },
        {
          proposition: '林渊是镇魔司暗桩',
          knowers: [{ name: '不存在的人', state: 'knows' }],
          evidence: '林渊每次回响会折寿三日',
        },
      ],
      relations: [], events: [], foreshadowing: [], threads: [], conflicts: [],
    }
    const service = makeService(payload)
    const project = service.createProject({ title: '归墟', genre: '都市异能' })
    const outcome = await service.ingestMaterial(project.id, { material })

    // 一条正常生成提议；另一条知情者名字在素材里找不到 → 丢弃
    expect(outcome.stats.knowledge).toBe(1)
    expect(outcome.stats.droppedReasons.knowledge_unknown_knower).toBe(1)
    expect(outcome.proposals.some(proposal => proposal.targetType === 'knowledge')).toBe(true)

    service.applyIngestBatch(outcome.batch.id, true)
    const facts = service.store.listKnowledge(project.id)
    expect(facts).toHaveLength(1)
    expect(facts[0]?.proposition).toContain('折寿')
    const states = facts[0]?.knowers.map(entry => `${entry.name}:${entry.state}`).sort()
    expect(states).toEqual(['沈砚:unaware', '林渊:knows'].sort())
  })

  it('素材太短会被拒绝，不会产生空批次', async () => {
    const service = makeService(extraction)
    const project = service.createProject({ title: '归墟', genre: '都市异能' })
    await expect(service.ingestMaterial(project.id, { material: '太短' })).rejects.toThrowError(/至少需要/)
    expect(service.store.listIngestBatches(project.id)).toHaveLength(0)
  })

  it('同一实体再次导入时生成 update 提议，而不是重复创建', async () => {
    const service = makeService({
      entities: [
        { kind: 'character', name: '林渊', summary: '镇魔司外勤', evidence: '林渊，24岁，镇魔司外勤' },
      ],
      relations: [], events: [], foreshadowing: [], threads: [], conflicts: [],
    })
    const project = service.createProject({ title: '归墟', genre: '都市异能' })
    const first = await service.ingestMaterial(project.id, { material: MATERIAL })
    service.applyIngestBatch(first.batch.id, true)

    const second = await service.ingestMaterial(project.id, { material: MATERIAL })
    expect(second.stats.entities).toBe(1)
    expect(second.proposals[0]?.operation).toBe('update')
    expect(second.proposals[0]?.targetId).toBe(service.store.listEntities(project.id)[0]?.id)
  })
})
