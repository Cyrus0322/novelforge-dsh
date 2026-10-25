import { afterEach, describe, expect, it } from 'vitest'
import { NovelStore } from '../src/database/store.js'

/** 知情矩阵、伏笔逾期、关系/剧情线删除。 */

let store: NovelStore | null = null

function setup(): { store: NovelStore; projectId: string; lin: string; shen: string } {
  store = new NovelStore(':memory:')
  const project = store.createProject({ title: '归墟', genre: '都市异能' })
  const lin = store.createEntity({ projectId: project.id, kind: 'character', name: '林渊', role: '主角' })
  const shen = store.createEntity({ projectId: project.id, kind: 'character', name: '沈砚', role: '搭档' })
  return { store, projectId: project.id, lin: lin.id, shen: shen.id }
}

afterEach(() => {
  store?.close()
  store = null
})

describe('知情矩阵', () => {
  it('创建后能按人物查到「谁知道 / 谁不知道」', () => {
    const { store: s, projectId, lin, shen } = setup()
    const fact = s.createKnowledge({
      projectId,
      proposition: '林渊每次回响会折寿三日',
      truth: 'true',
      publicLevel: 'secret',
      knowers: [
        { entityId: lin, state: 'knows' },
        { entityId: shen, state: 'suspects' },
      ],
    })
    expect(fact.proposition).toContain('折寿')

    const forLin = s.listKnowledgeForEntity(lin)
    expect(forLin).toHaveLength(1)
    expect(forLin[0]?.knowers.map(entry => `${entry.name}:${entry.state}`).sort()).toEqual(['林渊:knows', '沈砚:suspects'].sort())

    const view = s.listKnowledge(projectId)[0]
    expect(view?.knowers.find(entry => entry.entityId === shen)?.name).toBe('沈砚')
  })

  it('支持修改知情状态与删除；乐观锁冲突会报 CONFLICT', () => {
    const { store: s, projectId, lin, shen } = setup()
    const fact = s.createKnowledge({
      projectId, proposition: '青铜灯每月只能封存一次回响',
      knowers: [{ entityId: lin, state: 'knows' }],
    })
    const updated = s.updateKnowledge(fact.id, {
      knowers: [{ entityId: lin, state: 'knows' }, { entityId: shen, state: 'unaware' }],
    }, fact.version)
    expect(updated.version).toBe(fact.version + 1)

    expect(() => s.updateKnowledge(fact.id, { truth: 'false' }, fact.version)).toThrowError(/版本已变化/)

    s.deleteKnowledge(fact.id)
    expect(s.listKnowledge(projectId)).toHaveLength(0)
  })

  it('知情事实会进入写作上下文', async () => {
    const { store: s, projectId, lin } = setup()
    const chapter = s.createChapter(projectId, { title: '雨夜' })
    s.createKnowledge({ projectId, proposition: '林渊每次回响会折寿三日', knowers: [{ entityId: lin, state: 'knows' }] })
    const { ContextBuilder } = await import('../src/retrieval/context.js')
    const { DEFAULT_CONFIG } = await import('../src/shared/config.js')
    const builder = new ContextBuilder(s, { ...DEFAULT_CONFIG, databasePath: ':memory:' })
    const pack = builder.build(chapter.chapter.id)
    expect(pack.text).toContain('知情矩阵')
    expect(pack.text).toContain('折寿三日')
    expect(pack.text).toContain('林渊=知道')
  })
})

describe('伏笔逾期', () => {
  it('已过截止章且未回收的伏笔会被列出来，回收后不再算逾期', () => {
    const { store: s, projectId } = setup()
    for (let index = 1; index <= 5; index += 1) {
      const chapter = s.createChapter(projectId, { title: `第${index}章` })
      const content = s.createRevision(chapter.chapter.id, `第 ${index} 章正文`, 'manual')
      s.finalizeChapter(content.id, true, [], true)
    }
    const overdue = s.createForeshadowing({ projectId, name: '青铜钥匙' })
    s.updateForeshadowing(overdue.id, { deadlineChapterId: 3 })
    const notDue = s.createForeshadowing({ projectId, name: '旧船票' })
    s.updateForeshadowing(notDue.id, { deadlineChapterId: 9 })

    const list = s.listOverdueForeshadowing(projectId)
    expect(list.map(item => item.name)).toEqual(['青铜钥匙'])
    expect(list[0]?.progressChapterNo).toBe(5)
    expect(s.getProjectOverview(projectId).counts.overdueForeshadowing).toBe(1)

    const paid = s.updateForeshadowing(overdue.id, { status: 'payoff' })
    expect(s.listOverdueForeshadowing(projectId)).toHaveLength(0)
    expect(paid.status).toBe('payoff')
  })
})

describe('关系与剧情线删除', () => {
  it('删除后列表为空，且写审计', () => {
    const { store: s, projectId, lin, shen } = setup()
    const relation = s.createRelation({ projectId, sourceId: lin, targetId: shen, kind: '搭档' })
    const thread = s.createPlotThread({ projectId, name: '查清母亲失踪' })

    s.deleteRelation(relation.id)
    s.deletePlotThread(thread.id)

    expect(s.listRelations(projectId)).toHaveLength(0)
    expect(s.listPlotThreads(projectId)).toHaveLength(0)
    const actions = s.listAuditEntries(projectId, 20).map(entry => entry.action)
    expect(actions).toContain('relation.delete')
    expect(actions).toContain('thread.delete')
  })
})
