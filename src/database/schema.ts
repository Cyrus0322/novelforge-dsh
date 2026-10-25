import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  genre: text('genre').notNull(),
  premise: text('premise').notNull().default(''),
  styleGuide: text('style_guide').notNull().default(''),
  status: text('status').notNull().default('active'),
  pov: text('pov').notNull().default(''),
  tense: text('tense').notNull().default(''),
  chapterWordsMin: integer('chapter_words_min').notNull().default(0),
  chapterWordsMax: integer('chapter_words_max').notNull().default(0),
  targetChapters: integer('target_chapters').notNull().default(0),
  themesJson: text('themes_json').notNull().default('[]'),
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
  role: text('role').notNull().default(''),
  goal: text('goal').notNull().default(''),
  motivation: text('motivation').notNull().default(''),
  flaw: text('flaw').notNull().default(''),
  secret: text('secret').notNull().default(''),
  voice: text('voice').notNull().default(''),
  arc: text('arc').notNull().default(''),
  aliasesJson: text('aliases_json').notNull().default('[]'),
  firstAppearanceChapterId: text('first_appearance_chapter_id'),
  importance: integer('importance').notNull().default(3),
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
  summary: text('summary').notNull().default(''),
  povEntityId: text('pov_entity_id'),
  targetWords: integer('target_words').notNull().default(0),
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
  participantsJson: text('participants_json').notNull().default('[]'),
  locationEntityId: text('location_entity_id'),
  importance: integer('importance').notNull().default(3),
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
  kind: text('kind').notNull().default(''),
  importance: integer('importance').notNull().default(3),
  notes: text('notes').notNull().default(''),
  deadlineChapterId: integer('deadline_chapter_id'),
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
  batchId: text('batch_id'),
  source: text('source').notNull().default('manual'),
  confidence: integer('confidence'),
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

export const relations = sqliteTable('relations', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull(),
  targetId: text('target_id').notNull(),
  kind: text('kind').notNull(),
  tension: text('tension').notNull().default(''),
  notes: text('notes').notNull().default(''),
  sinceChapterId: text('since_chapter_id'),
  status: text('status').notNull().default('active'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  index('relations_project_idx').on(table.projectId),
  uniqueIndex('relations_unique_idx').on(table.projectId, table.sourceId, table.targetId, table.kind),
])

export const plotThreads = sqliteTable('plot_threads', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('main'),
  goal: text('goal').notNull().default(''),
  summary: text('summary').notNull().default(''),
  status: text('status').notNull().default('active'),
  currentChapterId: text('current_chapter_id'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  index('plot_threads_project_idx').on(table.projectId, table.status),
  uniqueIndex('plot_threads_unique_idx').on(table.projectId, table.name),
])

export const plotThreadEvents = sqliteTable('plot_thread_events', {
  threadId: text('thread_id').notNull().references(() => plotThreads.id, { onDelete: 'cascade' }),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  sequenceNo: integer('sequence_no').notNull().default(0),
}, table => [index('plot_thread_events_thread_idx').on(table.threadId)])

export const scenes = sqliteTable('scenes', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  chapterId: text('chapter_id').notNull().references(() => chapters.id, { onDelete: 'cascade' }),
  sceneNo: integer('scene_no').notNull(),
  beat: text('beat').notNull().default(''),
  goal: text('goal').notNull().default(''),
  conflict: text('conflict').notNull().default(''),
  outcome: text('outcome').notNull().default(''),
  locationEntityId: text('location_entity_id'),
  castJson: text('cast_json').notNull().default('[]'),
  povEntityId: text('pov_entity_id'),
  notes: text('notes').notNull().default(''),
  status: text('status').notNull().default('planned'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [uniqueIndex('scenes_chapter_no_idx').on(table.chapterId, table.sceneNo)])

export const characterStates = sqliteTable('character_states', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  characterId: text('character_id').notNull(),
  chapterId: text('chapter_id'),
  summary: text('summary').notNull().default(''),
  stateJson: text('state_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
}, table => [index('character_states_character_idx').on(table.characterId, table.chapterId)])

export const ingestBatches = sqliteTable('ingest_batches', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default(''),
  sourceText: text('source_text').notNull(),
  mode: text('mode').notNull().default('propose'),
  status: text('status').notNull().default('analyzing'),
  focus: text('focus').notNull().default(''),
  model: text('model').notNull().default(''),
  statsJson: text('stats_json').notNull().default('{}'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  appliedAt: text('applied_at'),
}, table => [index('ingest_batches_project_idx').on(table.projectId, table.status)])

export const knowledgeFacts = sqliteTable('knowledge_facts', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  proposition: text('proposition').notNull(),
  truth: text('truth').notNull().default('true'),
  publicLevel: text('public_level').notNull().default('secret'),
  chapterId: text('chapter_id'),
  knowersJson: text('knowers_json').notNull().default('[]'),
  notes: text('notes').notNull().default(''),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [index('knowledge_project_idx').on(table.projectId)])
