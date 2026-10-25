import { describe, expect, it } from 'vitest'
import { NovelStore } from '../src/database/store.js'
import { ContextBuilder, estimateTokens } from '../src/retrieval/context.js'
import { oneChapterOutline, testConfig } from './helpers.js'

describe('ContextBuilder', () => {
  it('在预算内保留状态标签，并报告截断', () => {
    const config = testConfig({ maxInputTokens: 2000, maxContextTokens: 8192, maxTokens: 1024 as 256 })
    const store = new NovelStore(':memory:')
    try {
      const project = store.createProject({ title: '长书', genre: '科幻', premise: '长前提'.repeat(100), styleGuide: '克制' })
      store.createEntity({
        projectId: project.id, kind: 'world_rule', name: '超长规则',
        summary: '正式规则。'.repeat(1000), status: 'confirmed',
      })
      store.createEntity({ projectId: project.id, kind: 'event', name: '计划事件', summary: '尚未发生', status: 'planned' })
      const chapter = store.appendOutline(project.id, oneChapterOutline).chapters[0]!
      const pack = new ContextBuilder(store, config).build(chapter.id, 1024)
      expect(pack.estimatedTokens).toBeLessThanOrEqual(pack.budgetTokens + 5)
      expect(pack.truncated || pack.omittedSections.length > 0).toBe(true)
      expect(pack.text).toContain('当前章节与硬约束')
      expect(estimateTokens(pack.text)).toBe(pack.estimatedTokens)
    } finally {
      store.close()
    }
  })
})
