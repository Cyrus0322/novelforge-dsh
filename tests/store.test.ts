import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NovelStore } from '../src/database/store.js'
import { oneChapterOutline } from './helpers.js'

let directory = ''
let databasePath = ''

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'novelforge-store-'))
  databasePath = join(directory, 'novel.db')
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('NovelStore', () => {
  it('重启后恢复项目、设定、大纲和正文版本', () => {
    const first = new NovelStore(databasePath)
    const project = first.createProject({ title: '测试书', genre: '科幻' })
    first.createEntity({ projectId: project.id, kind: 'character', name: '林澈', summary: '调查员' })
    const planned = first.appendOutline(project.id, oneChapterOutline)
    const revision = first.createRevision(planned.chapters[0]!.id, '雨落在旧城。', 'draft')
    first.close()

    const second = new NovelStore(databasePath)
    try {
      expect(second.getProject(project.id).title).toBe('测试书')
      expect(second.search(project.id, '林澈')[0]?.recordType).toBe('character')
      expect(second.search(project.id, '雨落')[0]?.recordId).toBe(revision.id)
      expect(second.getRevision(revision.id).content).toBe('雨落在旧城。')
      expect(second.listChapters(project.id)).toHaveLength(1)
    } finally {
      second.close()
    }
  })

  it('正文修订和回滚只追加版本，不覆盖历史', () => {
    const store = new NovelStore(':memory:')
    try {
      const project = store.createProject({ title: '版本书', genre: '奇幻' })
      const chapter = store.appendOutline(project.id, oneChapterOutline).chapters[0]!
      const v1 = store.createRevision(chapter.id, '第一版', 'draft')
      const v2 = store.createRevision(chapter.id, '第二版', 'rewrite')
      const v3 = store.createRevision(chapter.id, store.getRevision(v1.id).content, 'rollback')
      expect([v1.revisionNo, v2.revisionNo, v3.revisionNo]).toEqual([1, 2, 3])
      expect(store.getRevision(v1.id).content).toBe('第一版')
      expect(store.getRevision(v3.id).content).toBe('第一版')
    } finally {
      store.close()
    }
  })

  it('资料变更必须批准，并检查预期版本', () => {
    const store = new NovelStore(':memory:')
    try {
      const project = store.createProject({ title: '审批书', genre: '奇幻' })
      const entity = store.createEntity({ projectId: project.id, kind: 'character', name: '沈宁', summary: '普通人' })
      const proposal = store.proposeChange({
        projectId: project.id, targetType: 'entity', targetId: entity.id, operation: 'update',
        payload: { summary: '觉醒者' }, expectedVersion: 1,
      })
      expect(() => store.applyChange(proposal.id, false)).toThrow(/批准/)
      expect(store.getEntity(entity.id).summary).toBe('普通人')
      store.applyChange(proposal.id, true)
      expect(store.getEntity(entity.id).summary).toBe('觉醒者')

      const stale = store.proposeChange({
        projectId: project.id, targetType: 'entity', targetId: entity.id, operation: 'update',
        payload: { summary: '过期修改' }, expectedVersion: 1,
      })
      expect(() => store.applyChange(stale.id, true)).toThrow(/版本已变化/)
      expect(store.getEntity(entity.id).summary).toBe('觉醒者')
    } finally {
      store.close()
    }
  })
})
