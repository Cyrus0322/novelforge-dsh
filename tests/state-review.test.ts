import { afterEach, describe, expect, it } from 'vitest'
import { NovelStore } from '../src/database/store.js'
import { NovelService } from '../src/workflow/novel-service.js'
import { ContextBuilder } from '../src/retrieval/context.js'
import { MockLlm, json, testConfig } from './helpers.js'

/** 状态快照审查 / 伏笔逾期上下文 / 影响分析 / 创作控制台。 */

let store: NovelStore | null = null
afterEach(() => {
  store?.close()
  store = null
})

const emptyReview = { summary: '', issues: [] }

function makeService(): NovelService {
  store = new NovelStore(':memory:')
  return new NovelService(store, new MockLlm(() => json(emptyReview)), testConfig())
}

function finalizeChapters(service: NovelService, projectId: string, count: number): void {
  for (let index = 1; index <= count; index += 1) {
    const chapter = service.store.createChapter(projectId, { title: `第${index}章` })
    const revision = service.store.createRevision(chapter.chapter.id, `第 ${index} 章正文`.repeat(5), 'manual')
    service.store.finalizeChapter(revision.id, true, [], true)
  }
}

describe('状态快照接入审查', () => {
  it('伤势未愈却行动自如 → major，证据指向快照', async () => {
    const service = makeService()
    const project = service.createProject({ title: '归墟', genre: '都市异能' })
    const lin = service.store.createEntity({ projectId: project.id, kind: 'character', name: '林渊' })
    finalizeChapters(service, project.id, 10)
    const chapter = service.store.createChapter(project.id, { title: '第11章' })
    service.store.createCharacterState({
      characterId: lin.id,
      chapterId: chapter.chapter.id,
      summary: '左臂骨裂',
      state: { level: '引气七层', injuries: [{ desc: '左臂骨裂', healChapter: 15 }] },
    })
    const revision = service.store.createRevision(
      chapter.chapter.id,
      '林渊挥拳砸在铁门上，骨裂的左臂纹丝不动。',
      'manual',
    )
    const result = await service.reviewChapter(revision.id)
    const hit = result.issues.find(issue => issue.issue.includes('未愈') && issue.issue.includes('林渊'))
    expect(hit).toBeTruthy()
    expect(hit?.severity).toBe('major')
    expect(hit?.evidenceJson).toContain('左臂骨裂')
  })

  it('伤势已痊愈（healChapter 早于本章）不报', async () => {
    const service = makeService()
    const project = service.createProject({ title: '归墟', genre: '都市异能' })
    const lin = service.store.createEntity({ projectId: project.id, kind: 'character', name: '林渊' })
    finalizeChapters(service, project.id, 10)
    const chapter = service.store.createChapter(project.id, { title: '第11章' })
    service.store.createCharacterState({
      characterId: lin.id,
      chapterId: chapter.chapter.id,
      summary: '左臂骨裂',
      state: { injuries: [{ desc: '左臂骨裂', healChapter: 9 }] },
    })
    const revision = service.store.createRevision(chapter.chapter.id, '林渊挥拳砸在铁门上。', 'manual')
    const result = await service.reviewChapter(revision.id)
    expect(result.issues.some(issue => issue.issue.includes('未愈'))).toBe(false)
  })

  it('等级回退且未注明降级 → minor', async () => {
    const service = makeService()
    const project = service.createProject({ title: '归墟', genre: '都市异能' })
    const lin = service.store.createEntity({ projectId: project.id, kind: 'character', name: '林渊' })
    const chapter1 = service.store.createChapter(project.id, { title: '第1章' })
    const chapter2 = service.store.createChapter(project.id, { title: '第2章' })
    service.store.createCharacterState({ characterId: lin.id, chapterId: chapter1.chapter.id, summary: '引气七层', state: { level: '引气七层' } })
    service.store.createCharacterState({ characterId: lin.id, chapterId: chapter2.chapter.id, summary: '引气三层', state: { level: '引气三层' } })
    const revision = service.store.createRevision(chapter2.chapter.id, '林渊推门进去。', 'manual')
    const result = await service.reviewChapter(revision.id)
    const hit = result.issues.find(issue => issue.issue.includes('等级从'))
    expect(hit).toBeTruthy()
    expect(hit?.severity).toBe('minor')
  })
})

describe('伏笔逾期进入写作上下文', () => {
  it('逾期与即将到期分别标注并给出提醒', () => {
    const service = makeService()
    const project = service.createProject({ title: '归墟', genre: '都市异能' })
    finalizeChapters(service, project.id, 5)
    const overdue = service.store.createForeshadowing({ projectId: project.id, name: '青铜钥匙' })
    service.store.updateForeshadowing(overdue.id, { deadlineChapterId: 3 })
    const dueSoon = service.store.createForeshadowing({ projectId: project.id, name: '旧船票' })
    service.store.updateForeshadowing(dueSoon.id, { deadlineChapterId: 7 })

    const chapter = service.store.createChapter(project.id, { title: '第6章' })
    const builder = new ContextBuilder(service.store, { ...testConfig(), databasePath: ':memory:' })
    const pack = builder.build(chapter.chapter.id)
    expect(pack.text).toContain('未回收伏笔（含回收期限）')
    expect(pack.text).toContain('【逾期】青铜钥匙')
    expect(pack.text).toContain('【即将到期】旧船票')
    expect(pack.text).toContain('已逾期 1 条')
    expect(pack.text).toContain('未来 3 章内到期 1 条')
  })
})

describe('影响分析', () => {
  it('改一个事件能列出受影响的后续章节/伏笔/剧情线/知情', () => {
    const service = makeService()
    const project = service.createProject({ title: '归墟', genre: '都市异能' })
    const lin = service.store.createEntity({ projectId: project.id, kind: 'character', name: '林渊' })
    const chapter3 = service.store.createChapter(project.id, { title: '第3章' })
    const chapter5 = service.store.createChapter(project.id, { title: '第5章' })
    service.store.updateOutline(chapter5.outline.id, {
      content: JSON.stringify({ summary: '林渊拿到青铜钥匙，决定去旧港', goal: '', conflict: '', hook: '' }),
    })

    const event = service.store.createEvent({
      projectId: project.id,
      chapterId: chapter3.chapter.id,
      summary: '林渊在码头拿到青铜钥匙',
      participants: [lin.id],
      status: 'confirmed',
    })
    const foreshadowing = service.store.createForeshadowing({ projectId: project.id, name: '钥匙的来历' })
    service.store.updateForeshadowing(foreshadowing.id, { plantChapterId: chapter3.chapter.id })
    service.store.createPlotThread({ projectId: project.id, name: '查明钥匙来历', currentChapterId: chapter5.chapter.id })
    service.store.createKnowledge({ projectId: project.id, proposition: '青铜钥匙能打开旧港的闸门', knowers: [{ entityId: lin.id, state: 'knows' }] })

    const impact = service.store.analyzeEventImpact(project.id, event.id)
    expect(impact.keywords.length).toBeGreaterThan(0)
    expect(impact.chapters.some(item => item.chapter.id === chapter5.chapter.id)).toBe(true)
    expect(impact.foreshadowing.some(item => item.name === '钥匙的来历')).toBe(true)
    expect(impact.threads.some(item => item.name === '查明钥匙来历')).toBe(true)
    expect(impact.knowledge.length).toBeGreaterThan(0)
    expect(impact.total).toBeGreaterThan(0)
  })
})

describe('创作控制台', () => {
  it('汇总进度、逾期、停滞剧情线、待决策章节与最近记录', () => {
    const service = makeService()
    const project = service.createProject({ title: '归墟', genre: '都市异能', targetChapters: 300 })
    finalizeChapters(service, project.id, 6)
    const overdue = service.store.createForeshadowing({ projectId: project.id, name: '青铜钥匙' })
    service.store.updateForeshadowing(overdue.id, { deadlineChapterId: 2 })
    service.store.createPlotThread({ projectId: project.id, name: '主线' })
    const pending = service.store.createChapter(project.id, { title: '待决策章' })
    service.store.updateChapter(pending.chapter.id, { status: 'needs_author_decision' })
    service.store.createChapter(project.id, { title: '未审章' })

    const center = service.store.getControlCenter(project.id)
    expect(center.progress.currentChapterNo).toBe(6)
    expect(center.progress.finalizedCount).toBe(6)
    expect(center.progress.targetChapters).toBe(300)
    expect(center.overdue.map(item => item.name)).toContain('青铜钥匙')
    expect(center.stalledThreads.length).toBe(1)
    expect(center.needsDecisionChapters.map(item => item.title)).toContain('待决策章')
    expect(center.unreviewedChapters.length).toBeGreaterThanOrEqual(1)
    expect(center.recentAudit.length).toBeGreaterThan(0)
  })
})
