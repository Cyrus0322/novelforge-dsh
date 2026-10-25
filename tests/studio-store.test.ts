import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NovelStore } from '../src/database/store.js'
import type {
  Chapter, ChapterRevision, Foreshadowing, Outline, Project, StoryEvent,
} from '../src/database/store.js'
import type { ReviewIssueInput, ReviewResult } from '../src/domain/schemas.js'
import { NovelForgeError } from '../src/shared/errors.js'
import type { NovelForgeErrorCode } from '../src/shared/errors.js'

/**
 * 这些用例覆盖「人工工作台」新增的 store 能力：作者直接编辑资料、追加人工正文、
 * 跳过模型审查的人工定稿，以及工作台总览/详情/审查/审计聚合。
 * 与 tests/store.test.ts 一样，每个用例独立临时 SQLite 文件，不 mock 任何被测逻辑。
 */

let directory = ''
let databasePath = ''
let store: NovelStore

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'novelforge-studio-store-'))
  databasePath = join(directory, 'novel.db')
  store = new NovelStore(databasePath)
})

afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

const twoChapterOutline = {
  volumes: [{
    title: '第一卷',
    summary: '开端',
    chapters: [
      { title: '第一章', summary: '主角进城', goal: '建立目标', conflict: '身份受阻', hook: '发现追踪者' },
      { title: '第二章', summary: '追踪者现身', goal: '反制', conflict: '被误导', hook: '旧友背叛' },
    ],
  }],
}

function seedProject(): { project: Project; chapters: Chapter[]; outlines: Outline[] } {
  const project = store.createProject({ title: '工作台测试书', genre: '奇幻', premise: '雨夜进城', styleGuide: '冷静克制' })
  const planned = store.appendOutline(project.id, twoChapterOutline)
  return { project, chapters: planned.chapters, outlines: planned.outlines }
}

/** 断言抛出 NovelForgeError 且错误码符合预期，返回该错误方便继续检查 details。 */
function captureNovelForgeError(fn: () => unknown): NovelForgeError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(NovelForgeError)
    return error as NovelForgeError
  }
  throw new Error('期望抛出 NovelForgeError，但调用成功返回了。')
}

function expectErrorCode(fn: () => unknown, code: NovelForgeErrorCode): NovelForgeError {
  const error = captureNovelForgeError(fn)
  expect(error.code).toBe(code)
  return error
}

/** 事件与伏笔没有独立的 create 方法，正式资料只能经「提议 + 批准」写入。 */
function createEventViaProposal(projectId: string, summary: string, eventTime = '第一日'): StoryEvent {
  const proposal = store.proposeChange({ projectId, targetType: 'event', operation: 'create', payload: { summary, eventTime } })
  store.applyChange(proposal.id, true)
  const created = store.listEvents(projectId).find(row => row.summary === summary)
  expect(created).toBeDefined()
  return created as StoryEvent
}

function createForeshadowingViaProposal(projectId: string, name: string, description = '旧宅门锁'): Foreshadowing {
  const proposal = store.proposeChange({ projectId, targetType: 'foreshadowing', operation: 'create', payload: { name, description } })
  store.applyChange(proposal.id, true)
  const created = store.listForeshadowing(projectId).find(row => row.name === name)
  expect(created).toBeDefined()
  return created as Foreshadowing
}

function reviewIssue(severity: ReviewIssueInput['severity'], issue: string): ReviewIssueInput {
  return { category: 'continuity', severity, start: 0, end: 1, issue, evidence: [], suggestedFix: '修改后重审' }
}

function reviewWith(issues: ReviewIssueInput[]): ReviewResult {
  return { summary: issues.length ? '发现问题' : '未发现阻断问题。', issues }
}

function auditActions(projectId: string): string[] {
  return store.listAuditEntries(projectId, 500).map(entry => entry.action)
}

describe('NovelStore 人工工作台能力', () => {
  it('updateEntity 用错误的 expectedVersion 抛 CONFLICT，正确版本递增且写 entity.update 审计', () => {
    const { project } = seedProject()
    const entity = store.createEntity({ projectId: project.id, kind: 'character', name: '林澈', summary: '调查员' })

    expectErrorCode(() => store.updateEntity(entity.id, { summary: '不该生效' }, 99), 'CONFLICT')
    expect(store.getEntity(entity.id).summary).toBe('调查员')
    expect(store.getEntity(entity.id).version).toBe(1)

    const updated = store.updateEntity(entity.id, { summary: '档案员', attributes: { age: 30 } }, 1)
    expect(updated.version).toBe(2)
    expect(updated.summary).toBe('档案员')
    expect(JSON.parse(updated.attributesJson)).toEqual({ age: 30 })

    const entry = store.listAuditEntries(project.id, 100).find(row => row.action === 'entity.update')
    expect(entry).toBeDefined()
    expect(entry?.entityId).toBe(entity.id)
    expect(entry?.beforeJson).toContain('调查员')
    expect(entry?.afterJson).toContain('档案员')
  })

  it('updateProject / updateOutline 正常更新、版本递增并写审计', () => {
    const { project, outlines } = seedProject()
    const chapterOutline = outlines.find(row => row.level === 'chapter')
    expect(chapterOutline).toBeDefined()

    const projectAfter = store.updateProject(project.id, { title: '改名后的书', premise: '新的前提' }, 1)
    expect(projectAfter.title).toBe('改名后的书')
    expect(projectAfter.premise).toBe('新的前提')
    expect(projectAfter.version).toBe(2)
    // 过期版本再次写入必须拒绝，而不是静默覆盖。
    expectErrorCode(() => store.updateProject(project.id, { title: '又来一次' }, 1), 'CONFLICT')
    expect(store.getProject(project.id).title).toBe('改名后的书')

    const outlineAfter = store.updateOutline(chapterOutline!.id, {
      title: '第一章：雨夜进城',
      content: JSON.stringify({ summary: '改写后的章纲', goal: '目标', conflict: '冲突', hook: '钩子' }),
      status: 'planned',
    }, chapterOutline!.version)
    expect(outlineAfter.title).toBe('第一章：雨夜进城')
    expect(outlineAfter.version).toBe(chapterOutline!.version + 1)
    expect(store.getOutline(chapterOutline!.id).content).toContain('改写后的章纲')
    expectErrorCode(() => store.updateOutline(chapterOutline!.id, { title: '过期标题' }, chapterOutline!.version), 'CONFLICT')

    expect(auditActions(project.id)).toContain('project.update')
    expect(auditActions(project.id)).toContain('outline.update')
  })

  it('updateEvent 正常更新、版本递增，并且新摘要能被搜索索引命中', () => {
    const { project } = seedProject()
    const event = createEventViaProposal(project.id, '雨夜进城')

    const updated = store.updateEvent(event.id, { summary: '星门开启序列', status: 'confirmed' }, event.version)
    expect(updated.version).toBe(2)
    expect(updated.summary).toBe('星门开启序列')
    expect(updated.status).toBe('confirmed')
    expectErrorCode(() => store.updateEvent(event.id, { summary: '过期修改' }, 1), 'CONFLICT')

    const hits = store.search(project.id, '星门开启')
    expect(hits.some(hit => hit.recordType === 'event' && hit.recordId === event.id)).toBe(true)
    expect(auditActions(project.id)).toContain('event.update')
  })

  it('updateForeshadowing 正常更新、版本递增，并且新名字能被搜索索引命中', () => {
    const { project } = seedProject()
    const foreshadowing = createForeshadowingViaProposal(project.id, '青铜钥匙')

    const updated = store.updateForeshadowing(foreshadowing.id, { name: '青铜钥匙串', status: 'reinforced' }, foreshadowing.version)
    expect(updated.version).toBe(2)
    expect(updated.name).toBe('青铜钥匙串')
    expect(updated.status).toBe('reinforced')
    expectErrorCode(() => store.updateForeshadowing(foreshadowing.id, { name: '过期名字' }, 1), 'CONFLICT')

    const hits = store.search(project.id, '青铜钥匙')
    expect(hits.some(hit => hit.recordType === 'foreshadowing' && hit.sourceId === foreshadowing.id)).toBe(true)
    expect(store.getProjectOverview(project.id).openForeshadowing.map(row => row.id)).toContain(foreshadowing.id)
    expect(auditActions(project.id)).toContain('foreshadowing.update')
  })

  it('createRevision(kind=manual) 只追加版本，章节进入 manual_draft 且旧正文不被覆盖', () => {
    const { project, chapters } = seedProject()
    const chapter = chapters[0]!

    const first = store.createRevision(chapter.id, '人工第一版正文', 'manual')
    expect(first.kind).toBe('manual')
    expect(first.revisionNo).toBe(1)
    expect(store.getChapter(chapter.id).status).toBe('manual_draft')

    const second = store.createRevision(chapter.id, '人工第二版正文，更长一些', 'manual')
    expect(second.revisionNo).toBe(2)
    expect(store.getChapter(chapter.id).status).toBe('manual_draft')
    expect(store.getChapter(chapter.id).version).toBe(chapter.version + 2)

    // 旧版本内容保持原样，历史不可覆盖。
    expect(store.getRevision(first.id).content).toBe('人工第一版正文')
    expect(store.listRevisions(chapter.id).map(row => row.revisionNo)).toEqual([2, 1])
    expect(auditActions(project.id).filter(action => action === 'revision.manual')).toHaveLength(2)
  })

  it('未审查版本默认不能定稿；allowUnreviewed 定稿成功并写 chapter.finalize_manual 审计', () => {
    const { project, chapters } = seedProject()
    const chapter = chapters[0]!
    const revision = store.createRevision(chapter.id, '人工定稿正文', 'manual')

    expectErrorCode(() => store.finalizeChapter(revision.id, true, [], false), 'WORKFLOW_ERROR')
    expectErrorCode(() => store.finalizeChapter(revision.id, false, [], true), 'APPROVAL_REQUIRED')
    expect(store.getChapter(chapter.id).currentRevisionId).toBeNull()

    const finalized = store.finalizeChapter(revision.id, true, [], true)
    expect(finalized.status).toBe('finalized')
    expect(finalized.currentRevisionId).toBe(revision.id)
    expect(store.getRevision(revision.id).status).toBe('finalized')

    const entries = store.listAuditEntries(project.id, 100)
    expect(entries.filter(entry => entry.action === 'chapter.finalize_manual')).toHaveLength(1)
    expect(entries.some(entry => entry.action === 'chapter.finalize')).toBe(false)
  })

  it('已审查版本：有未解决 major 问题不能定稿，解决后定稿审计为 chapter.finalize', () => {
    const { project, chapters } = seedProject()
    const chapter = chapters[0]!
    const revision = store.createRevision(chapter.id, '待审查的正文', 'manual')
    const review = store.createReview(revision.id, reviewWith([reviewIssue('major', '时间线矛盾')]))

    const error = expectErrorCode(() => store.finalizeChapter(revision.id, true, [], false), 'WORKFLOW_ERROR')
    expect((error.details as { issueIds: string[] }).issueIds).toEqual([review.issues[0]!.id])

    store.updateIssueStatus(review.issues[0]!.id, 'resolved')
    const finalized = store.finalizeChapter(revision.id, true, [], false)
    expect(finalized.status).toBe('finalized')

    const actions = auditActions(project.id)
    expect(actions.filter(action => action === 'chapter.finalize')).toHaveLength(1)
    expect(actions.some(action => action === 'chapter.finalize_manual')).toBe(false)
  })

  it('rejectProposal：pending 才能驳回，重复驳回 CONFLICT；applyChange 后状态 applied', () => {
    const { project } = seedProject()
    const rejectedProposal = store.proposeChange({
      projectId: project.id, targetType: 'foreshadowing', operation: 'create', payload: { name: '会被驳回的伏笔' },
    })
    const rejected = store.rejectProposal(rejectedProposal.id)
    expect(rejected.status).toBe('rejected')
    expectErrorCode(() => store.rejectProposal(rejectedProposal.id), 'CONFLICT')

    const appliedProposal = store.proposeChange({
      projectId: project.id, targetType: 'event', operation: 'create', payload: { summary: '会被批准的事件' },
    })
    const applied = store.applyChange(appliedProposal.id, true)
    expect(applied.status).toBe('applied')
    expect(applied.appliedAt).not.toBeNull()
    expectErrorCode(() => store.applyChange(appliedProposal.id, true), 'CONFLICT')
    expect(store.listProposals(project.id, 'pending')).toHaveLength(0)
    expect(auditActions(project.id)).toContain('proposal.reject')
  })

  it('updateIssueStatus(resolved) 让 overview.counts.openIssues 与 openIssues 列表同步减少', () => {
    const { project, chapters } = seedProject()
    const revision = store.createRevision(chapters[0]!.id, '有问题的正文', 'manual')
    const review = store.createReview(revision.id, reviewWith([
      reviewIssue('major', '因果断裂'),
      reviewIssue('minor', '措辞重复'),
    ]))
    const major = review.issues.find(issue => issue.severity === 'major')!

    // minor 问题不计入阻断项。
    expect(store.getProjectOverview(project.id).counts.openIssues).toBe(1)
    expect(store.getProjectOverview(project.id).openIssues.map(issue => issue.id)).toEqual([major.id])

    const resolved = store.updateIssueStatus(major.id, 'resolved')
    expect(resolved.resolutionStatus).toBe('resolved')
    const overview = store.getProjectOverview(project.id)
    expect(overview.counts.openIssues).toBe(0)
    expect(overview.openIssues).toHaveLength(0)
    expect(auditActions(project.id)).toContain('issue.update')
  })

  it('getProjectOverview 的 counts / currentChapter / openForeshadowing / pendingProposals 与真实数据一致', () => {
    const { project, chapters } = seedProject()
    store.createEntity({ projectId: project.id, kind: 'character', name: '沈宁', summary: '主角' })
    createEventViaProposal(project.id, '雨夜相遇')
    createForeshadowingViaProposal(project.id, '未寄出的信')
    const pending = store.proposeChange({
      projectId: project.id, targetType: 'foreshadowing', operation: 'create', payload: { name: '待确认的伏笔' },
    })

    const firstRevision = store.createRevision(chapters[0]!.id, '第一章正文', 'manual')
    store.createReview(firstRevision.id, reviewWith([reviewIssue('critical', '主角身份矛盾')]))
    const secondRevision = store.createRevision(chapters[1]!.id, '第二章正文', 'manual')
    store.finalizeChapter(secondRevision.id, true, [], true)

    const overview = store.getProjectOverview(project.id)
    expect(overview.project.id).toBe(project.id)
    expect(overview.counts).toEqual({
      chapters: 2,
      finalizedChapters: 1,
      entities: 1,
      events: 1,
      foreshadowingOpen: 1,
      pendingProposals: 1,
      openIssues: 1,
      revisions: 2,
      relations: 0,
      threads: 0,
      scenes: 0,
      ingestBatches: 0,
    })
    expect(overview.currentChapter?.id).toBe(chapters[0]!.id)
    expect(overview.openIssues.map(issue => issue.chapterId)).toEqual([chapters[0]!.id])
    expect(overview.openForeshadowing.map(row => row.name)).toEqual(['未寄出的信'])
    expect(overview.pendingProposals.map(row => row.id)).toEqual([pending.id])
    expect(overview.recentWorkflows).toEqual([])
    expect(overview.recentRevisions).toHaveLength(2)
    expect(overview.recentRevisions.map(row => row.id)).toContain(firstRevision.id)
    expect(overview.lastFinalized?.chapter.id).toBe(chapters[1]!.id)
    expect(overview.lastFinalized?.revision.id).toBe(secondRevision.id)

    // 再次读取应与底层真实数据一致，而不是缓存的旧快照。
    expect(overview.counts.entities).toBe(store.listEntities(project.id).length)
    expect(overview.counts.events).toBe(store.listEvents(project.id).length)
    expect(overview.counts.chapters).toBe(store.listChapters(project.id).length)
  })

  it('getChapterDetail 返回章纲、全部版本、最新版本与最新审查', () => {
    const { chapters } = seedProject()
    const chapter = chapters[0]!
    const withoutReview = store.getChapterDetail(chapter.id)
    expect(withoutReview.chapter.id).toBe(chapter.id)
    expect(withoutReview.outline?.title).toBe(chapter.title)
    expect(withoutReview.revisions).toEqual([])
    expect(withoutReview.latestRevision).toBeNull()
    expect(withoutReview.latestReview).toBeNull()

    const first: ChapterRevision = store.createRevision(chapter.id, '第一版', 'manual')
    const second: ChapterRevision = store.createRevision(chapter.id, '第二版', 'manual')
    const review = store.createReview(second.id, reviewWith([reviewIssue('major', '节奏拖沓')]))

    const detail = store.getChapterDetail(chapter.id)
    expect(detail.revisions.map(row => row.id)).toEqual([second.id, first.id])
    expect(detail.latestRevision?.id).toBe(second.id)
    expect(detail.latestRevision?.content).toBe('第二版')
    expect(detail.latestReview?.run.id).toBe(review.run.id)
    expect(detail.latestReview?.issues.map(issue => issue.id)).toEqual([review.issues[0]!.id])
  })

  it('listReviewRuns 的 issueCount / openCount 正确，解决后 openCount 下降', async () => {
    const { project, chapters } = seedProject()
    const revision = store.createRevision(chapters[0]!.id, '审查用正文', 'manual')
    const review = store.createReview(revision.id, reviewWith([
      reviewIssue('major', '情节漏洞'),
      reviewIssue('minor', '错别字'),
    ]))

    const runs = store.listReviewRuns(project.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.run.id).toBe(review.run.id)
    expect(runs[0]!.chapter).toEqual({ id: chapters[0]!.id, chapterNo: chapters[0]!.chapterNo, title: chapters[0]!.title })
    expect(runs[0]!.issueCount).toBe(2)
    expect(runs[0]!.openCount).toBe(2)

    store.updateIssueStatus(review.issues[0]!.id, 'wontfix')
    expect(store.listReviewRuns(project.id)[0]!.openCount).toBe(1)

    // 同一章节出现第二次审查时，列表按 createdAt 倒序，最新一条在最前。
    // 拉开 5ms 避免同一毫秒内 createdAt 相同导致排序不稳定。
    await new Promise(resolve => setTimeout(resolve, 5))
    const secondRevision = store.createRevision(chapters[0]!.id, '审查用正文第二版', 'manual')
    const secondReview = store.createReview(secondRevision.id, reviewWith([]))
    const updatedRuns = store.listReviewRuns(project.id)
    expect(updatedRuns).toHaveLength(2)
    expect(updatedRuns[0]!.run.id).toBe(secondReview.run.id)
    expect(updatedRuns[0]!.issueCount).toBe(0)
    expect(updatedRuns[0]!.openCount).toBe(0)
  })

  it('listAuditEntries 按时间倒序返回，并遵守 limit（含非法 limit 的夹取）', async () => {
    const { project } = seedProject()
    await new Promise(resolve => setTimeout(resolve, 5))
    store.updateProject(project.id, { title: '第二次标题' }, 1)
    await new Promise(resolve => setTimeout(resolve, 5))
    const entity = store.createEntity({ projectId: project.id, kind: 'item', name: '旧钥匙' })
    await new Promise(resolve => setTimeout(resolve, 5))
    store.updateEntity(entity.id, { summary: '锈蚀' }, 1)

    const entries = store.listAuditEntries(project.id, 100)
    // appendOutline 会为每个规划出的章节各写一条 chapter.plan 审计。
    expect(entries.map(entry => entry.action)).toEqual([
      'entity.update', 'entity.create', 'project.update', 'chapter.plan', 'chapter.plan', 'project.create',
    ])
    for (let index = 1; index < entries.length; index += 1) {
      expect(entries[index - 1]!.createdAt >= entries[index]!.createdAt).toBe(true)
    }

    expect(store.listAuditEntries(project.id, 2).map(entry => entry.action)).toEqual(['entity.update', 'entity.create'])
    expect(store.listAuditEntries(project.id, 0)).toHaveLength(1)
    expect(store.listAuditEntries(project.id, 10_000).length).toBe(entries.length)
  })

  /** 回归用例：counts.revisions 必须是真实版本总数，而不是 recentRevisions 的 12 条截断值。 */
  it('getProjectOverview().counts.revisions 等于真实版本总数（不受预览列表 12 条上限影响）', () => {
    const { project, chapters } = seedProject()
    for (let version = 1; version <= 13; version += 1) {
      store.createRevision(chapters[0]!.id, `第 ${version} 版正文`, 'manual')
    }
    const overview = store.getProjectOverview(project.id)
    expect(store.listRevisions(chapters[0]!.id)).toHaveLength(13)
    expect(overview.counts.revisions).toBe(13)
    expect(overview.recentRevisions).toHaveLength(12)
  })
})
