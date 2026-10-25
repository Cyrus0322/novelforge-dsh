import { describe, expect, it } from 'vitest'
import { NovelStore } from '../src/database/store.js'
import { NovelService } from '../src/workflow/novel-service.js'
import { MockLlm, emptyReview, json, oneChapterOutline, testConfig } from './helpers.js'

function setup(config = testConfig()) {
  const store = new NovelStore(':memory:')
  const project = store.createProject({ title: '续写测试', genre: '都市', premise: '调查', styleGuide: '简洁' })
  const chapter = store.appendOutline(project.id, oneChapterOutline).chapters[0]!
  const base = store.createRevision(chapter.id, '第一章开头。', 'draft')
  return { store, project, chapter, base, config }
}

describe('续写与改写', () => {
  it('续写保留原文并追加为新版本', async () => {
    const llm = new MockLlm(() => '他推开门。')
    const { store, base, chapter } = setup()
    const service = new NovelService(store, llm, testConfig())
    try {
      const next = await service.continueChapter(base.id, '接一段动作戏')
      expect(next.kind).toBe('continue')
      expect(next.content.startsWith('第一章开头。')).toBe(true)
      expect(next.content).toContain('他推开门。')
      const list = store.listRevisions(chapter.id)
      expect(list).toHaveLength(2)
      expect(store.getRevision(base.id).content).toBe('第一章开头。')
      expect(list.map(row => row.revisionNo).sort((left, right) => left - right)).toEqual([1, 2])
    } finally {
      service.close()
    }
  })

  it('改写生成新版本而不覆盖原版本', async () => {
    const llm = new MockLlm(() => '重写后的正文。')
    const { store, base, chapter } = setup()
    const service = new NovelService(store, llm, testConfig())
    try {
      const rewritten = await service.rewriteChapter(base.id, '改为第一人称')
      expect(rewritten.kind).toBe('rewrite')
      expect(rewritten.content).toBe('重写后的正文。')
      expect(store.getRevision(base.id).content).toBe('第一章开头。')
      expect(store.getLatestRevision(chapter.id)?.id).toBe(rewritten.id)
    } finally {
      service.close()
    }
  })
})

describe('修订轮次上限', () => {
  function withForbiddenTerm(config = testConfig()) {
    const context = setup(config)
    context.store.createEntity({
      projectId: context.project.id, kind: 'world_rule', name: '无魔法',
      summary: '世界不存在魔法', attributes: { forbiddenTerms: ['魔法'] }, status: 'confirmed',
    })
    const withMagic = context.store.createRevision(context.chapter.id, '他使用了魔法。', 'draft')
    const service = new NovelService(context.store, new MockLlm(() => json(emptyReview)), config)
    return { ...context, service, withMagic }
  }

  it('达到上限后暂停并将章节标记为需要作者决策', async () => {
    const { service, store, chapter, withMagic } = withForbiddenTerm(testConfig({ maxRevisionRounds: 0 }))
    try {
      const review = await service.reviewChapter(withMagic.id)
      const blocking = review.issues.filter(issue => issue.severity === 'critical')
      expect(blocking.length).toBeGreaterThan(0)
      await expect(service.reviseChapter(withMagic.id, blocking.map(issue => issue.id)))
        .rejects.toThrow(/最大自动修订轮次/)
      expect(store.getChapter(chapter.id).status).toBe('needs_author_decision')
      expect(store.listRevisions(chapter.id).filter(row => row.kind === 'revise')).toHaveLength(0)
    } finally {
      service.close()
    }
  })

  it('一轮修订会生成新版本并自动复检', async () => {
    const llm = new MockLlm(request => request.json ? json(emptyReview) : '他改用了刀。')
    const config = testConfig({ maxRevisionRounds: 1 })
    const { store, project, chapter } = setup(config)
    store.createEntity({
      projectId: project.id, kind: 'world_rule', name: '无魔法',
      summary: '世界不存在魔法', attributes: { forbiddenTerms: ['魔法'] }, status: 'confirmed',
    })
    const withMagic = store.createRevision(chapter.id, '他使用了魔法。', 'draft')
    const service = new NovelService(store, llm, config)
    try {
      const review = await service.reviewChapter(withMagic.id)
      const blocking = review.issues.filter(issue => issue.severity === 'critical').map(issue => issue.id)
      const result = await service.reviseChapter(withMagic.id, blocking)
      expect(result.revision.kind).toBe('revise')
      expect(result.revision.content).toBe('他改用了刀。')
      expect(result.review.issues.filter(issue => issue.severity === 'critical')).toHaveLength(0)
      expect(store.getRevision(withMagic.id).content).toBe('他使用了魔法。')
    } finally {
      service.close()
    }
  })
})
