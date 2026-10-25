import { afterEach, describe, expect, it } from 'vitest'
import { NovelStore } from '../src/database/store.js'
import { NovelService } from '../src/workflow/novel-service.js'
import { MockLlm, json, testConfig } from './helpers.js'

/**
 * 知情矩阵接入审查器：角色在正文里提到自己「不知道」的事，应当被确定性检查抓出来。
 */

let store: NovelStore | null = null

afterEach(() => {
  store?.close()
  store = null
})

const emptyReview = { summary: '未发现阻断问题。', issues: [] }

function service(): NovelService {
  store = new NovelStore(':memory:')
  return new NovelService(store, new MockLlm(() => json(emptyReview)), testConfig())
}

describe('审查器：知情矩阵', () => {
  it('角色提到自己 unaware 的事实 → 产出 major 问题，并带证据', async () => {
    const svc = service()
    const project = svc.createProject({ title: '归墟', genre: '都市异能' })
    const lin = svc.store.createEntity({ projectId: project.id, kind: 'character', name: '林渊' })
    const shen = svc.store.createEntity({ projectId: project.id, kind: 'character', name: '沈砚' })
    const fact = svc.store.createKnowledge({
      projectId: project.id,
      proposition: '林渊每次回响会折寿三日',
      publicLevel: 'secret',
      knowers: [{ entityId: lin.id, state: 'knows' }, { entityId: shen.id, state: 'unaware' }],
    })
    const chapter = svc.store.createChapter(project.id, { title: '雨夜' })
    const revision = svc.store.createRevision(
      chapter.chapter.id,
      '沈砚盯着他，忽然说：“你每次回响都要折寿三日，值吗？”林渊没回答。',
      'manual',
    )

    const result = await svc.reviewChapter(revision.id)
    const issues = result.issues
    const hit = issues.find(issue => issue.issue.includes('沈砚') && issue.issue.includes('折寿'))
    expect(hit).toBeTruthy()
    expect(hit?.severity).toBe('major')
    expect(hit?.evidenceJson).toContain(fact.id)
    // 证据里点名了「沈砚=不知道」
    expect(hit?.evidenceJson).toContain('不知道')
  })

  it('人物不在本章出现时不误报', async () => {
    const svc = service()
    const project = svc.createProject({ title: '归墟', genre: '都市异能' })
    const lin = svc.store.createEntity({ projectId: project.id, kind: 'character', name: '林渊' })
    const shen = svc.store.createEntity({ projectId: project.id, kind: 'character', name: '沈砚' })
    svc.store.createKnowledge({
      projectId: project.id,
      proposition: '林渊每次回响会折寿三日',
      knowers: [{ entityId: lin.id, state: 'knows' }, { entityId: shen.id, state: 'unaware' }],
    })
    const chapter = svc.store.createChapter(project.id, { title: '独处' })
    const revision = svc.store.createRevision(chapter.chapter.id, '林渊一个人坐在码头，想着折寿三日这件事。', 'manual')

    const result = await svc.reviewChapter(revision.id)
    expect(result.issues.some(issue => issue.issue.includes('沈砚'))).toBe(false)
  })

  it('知情者知道时不报问题', async () => {
    const svc = service()
    const project = svc.createProject({ title: '归墟', genre: '都市异能' })
    const shen = svc.store.createEntity({ projectId: project.id, kind: 'character', name: '沈砚' })
    svc.store.createKnowledge({
      projectId: project.id,
      proposition: '林渊每次回响会折寿三日',
      knowers: [{ entityId: shen.id, state: 'knows' }],
    })
    const chapter = svc.store.createChapter(project.id, { title: '摊牌' })
    const revision = svc.store.createRevision(chapter.chapter.id, '沈砚说：“你每次回响都会折寿三日，我知道。”', 'manual')

    const result = await svc.reviewChapter(revision.id)
    expect(result.issues.some(issue => issue.issue.includes('信息来源不明'))).toBe(false)
  })
})
