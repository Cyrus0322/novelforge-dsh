import { describe, expect, it } from 'vitest'
import { NovelStore } from '../src/database/store.js'
import { NovelService } from '../src/workflow/novel-service.js'
import { MockLlm, emptyReview, json, oneChapterOutline, testConfig } from './helpers.js'

function plannedService(llm: MockLlm) {
  const config = testConfig()
  const store = new NovelStore(':memory:')
  const project = store.createProject({ title: 'workflow', genre: '悬疑', premise: '调查失踪案', styleGuide: '冷静' })
  const chapter = store.appendOutline(project.id, oneChapterOutline).chapters[0]!
  const service = new NovelService(store, llm, config)
  return { service, store, project, chapter }
}

describe('NovelService 工作流', () => {
  it('完成计划、草稿、审查和人工定稿，导出只含定稿', async () => {
    const llm = new MockLlm(request => {
      if (!request.json) return '雨声掩盖了脚步。'
      if (request.messages.some(message => message.content.includes('本章执行计划') || message.content.includes('制定本章执行计划'))) {
        return json({ title: '雨夜', goal: '进城', conflict: '被跟踪', turn: '反跟踪', hook: '门后有人', involvedCharacters: [], constraints: [] })
      }
      return json(emptyReview)
    })
    const { service, project, chapter } = plannedService(llm)
    try {
      const draft = await service.writeDraft(chapter.id)
      expect(draft.revision.content).toContain('雨声')
      expect(() => service.finalizeChapter(draft.revision.id, true)).toThrow(/尚未审查/)
      const review = await service.reviewChapter(draft.revision.id)
      expect(review.issues).toHaveLength(0)
      expect(() => service.finalizeChapter(draft.revision.id, false)).toThrow(/approved/)
      service.finalizeChapter(draft.revision.id, true)
      expect(service.exportMarkdown(project.id)).toContain('雨声掩盖了脚步')
      expect(service.store.listWorkflowRuns(project.id).every(run => run.state === 'completed')).toBe(true)
    } finally {
      service.close()
    }
  })

  it('确定性规则发现违禁内容并阻断定稿', async () => {
    const llm = new MockLlm(() => json(emptyReview))
    const { service, store, project, chapter } = plannedService(llm)
    try {
      store.createEntity({
        projectId: project.id, kind: 'world_rule', name: '无魔法', summary: '世界不存在魔法',
        attributes: { forbiddenTerms: ['魔法'] }, status: 'confirmed',
      })
      const revision = store.createRevision(chapter.id, '他使用了魔法。', 'draft')
      const review = await service.reviewChapter(revision.id)
      expect(review.issues.some(issue => issue.severity === 'critical' && issue.issue.includes('魔法'))).toBe(true)
      expect(() => service.finalizeChapter(revision.id, true)).toThrow(/不能定稿/)
      expect(service.store.getChapter(chapter.id).currentRevisionId).toBeNull()
    } finally {
      service.close()
    }
  })

  it('模型生成设定后才创建项目，章节规划数量不符时不落库', async () => {
    const llm = new MockLlm(request => {
      if (request.messages.some(message => message.content.includes('小说项目蓝图'))) {
        return json({ title: '新书', genre: '科幻', premise: '前提', styleGuide: '简洁', characters: [], worldRules: [] })
      }
      return json({ volumes: [{ title: '卷', summary: '卷纲', chapters: [] }] })
    })
    const config = testConfig()
    const service = new NovelService(new NovelStore(':memory:'), llm, config)
    try {
      const generated = await service.generateSetting('写一本近未来侦探小说')
      expect(generated.project.title).toBe('新书')
      await expect(service.planOutline(generated.project.id, 2)).rejects.toThrow(/未写入数据库|返回/)
      expect(service.store.listChapters(generated.project.id)).toHaveLength(0)
    } finally {
      service.close()
    }
  })
})
