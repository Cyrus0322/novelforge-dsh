import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  genre: text('genre').notNull(),
  premise: text('premise').notNull().default(''),
  styleGuide: text('style_guide').notNull().default(''),
  status: text('status').notNull().default('active'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const entities = sqliteTable('entities', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  summary: text('summary').notNull().default(''),
  attributesJson: text('attributes_json').notNull().default('{}'),
  status: text('status').notNull().default('confirmed'),
  sourceChapterId: text('source_chapter_id'),
  sourceRevisionId: text('source_revision_id'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  index('entities_project_kind_idx').on(table.projectId, table.kind),
  uniqueIndex('entities_project_kind_name_idx').on(table.projectId, table.kind, table.name),
])

export const outlines = sqliteTable('outlines', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  parentId: text('parent_id'),
  level: text('level').notNull(),
  chapterNo: integer('chapter_no'),
  title: text('title').notNull(),
  content: text('content').notNull(),
  status: text('status').notNull().default('planned'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  index('outlines_project_idx').on(table.projectId, table.level),
  uniqueIndex('outlines_project_chapter_idx').on(table.projectId, table.chapterNo),
])

export const chapters = sqliteTable('chapters', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  outlineId: text('outline_id').references(() => outlines.id),
  chapterNo: integer('chapter_no').notNull(),
  title: text('title').notNull(),
  status: text('status').notNull().default('planned'),
  currentRevisionId: text('current_revision_id'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  uniqueIndex('chapters_project_no_idx').on(table.projectId, table.chapterNo),
])

export const chapterRevisions = sqliteTable('chapter_revisions', {
  id: text('id').primaryKey(),
  chapterId: text('chapter_id').notNull().references(() => chapters.id, { onDelete: 'cascade' }),
  revisionNo: integer('revision_no').notNull(),
  content: text('content').notNull(),
  kind: text('kind').notNull(),
  status: text('status').notNull().default('draft'),
  summary: text('summary').notNull().default(''),
  createdAt: text('created_at').notNull(),
}, table => [
  uniqueIndex('revisions_chapter_no_idx').on(table.chapterId, table.revisionNo),
])

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  chapterId: text('chapter_id').references(() => chapters.id),
  eventTime: text('event_time').notNull().default(''),
  summary: text('summary').notNull(),
  status: text('status').notNull().default('planned'),
  sourceRevisionId: text('source_revision_id'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [index('events_project_time_idx').on(table.projectId, table.eventTime)])

export const foreshadowing = sqliteTable('foreshadowing', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  plantChapterId: text('plant_chapter_id').references(() => chapters.id),
  payoffChapterId: text('payoff_chapter_id').references(() => chapters.id),
  status: text('status').notNull().default('open'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [index('foreshadowing_project_status_idx').on(table.projectId, table.status)])

export const reviewRuns = sqliteTable('review_runs', {
  id: text('id').primaryKey(),
  chapterId: text('chapter_id').notNull().references(() => chapters.id, { onDelete: 'cascade' }),
  revisionId: text('revision_id').notNull().references(() => chapterRevisions.id, { onDelete: 'cascade' }),
  status: text('status').notNull(),
  summary: text('summary').notNull().default(''),
  createdAt: text('created_at').notNull(),
})

export const reviewIssues = sqliteTable('review_issues', {
  id: text('id').primaryKey(),
  reviewRunId: text('review_run_id').notNull().references(() => reviewRuns.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  severity: text('severity').notNull(),
  locationStart: integer('location_start'),
  locationEnd: integer('location_end'),
  issue: text('issue').notNull(),
  evidenceJson: text('evidence_json').notNull().default('[]'),
  suggestedFix: text('suggested_fix').notNull(),
  resolutionStatus: text('resolution_status').notNull().default('open'),
})

export const workflowRuns = sqliteTable('workflow_runs', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  chapterId: text('chapter_id'),
  taskType: text('task_type').notNull(),
  state: text('state').notNull(),
  checkpointJson: text('checkpoint_json').notNull().default('{}'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [index('workflow_project_state_idx').on(table.projectId, table.state)])

export const changeProposals = sqliteTable('change_proposals', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  chapterId: text('chapter_id'),
  sourceRevisionId: text('source_revision_id'),
  targetType: text('target_type').notNull(),
  targetId: text('target_id'),
  operation: text('operation').notNull(),
  payloadJson: text('payload_json').notNull(),
  expectedVersion: integer('expected_version'),
  status: text('status').notNull().default('pending'),
  createdAt: text('created_at').notNull(),
  appliedAt: text('applied_at'),
})

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  action: text('action').notNull(),
  entityId: text('entity_id').notNull(),
  beforeJson: text('before_json'),
  afterJson: text('after_json'),
  createdAt: text('created_at').notNull(),
})
