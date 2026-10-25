export const MIGRATION_1 = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  genre TEXT NOT NULL,
  premise TEXT NOT NULL DEFAULT '',
  style_guide TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  attributes_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'confirmed',
  source_chapter_id TEXT,
  source_revision_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX entities_project_kind_idx ON entities(project_id, kind);
CREATE UNIQUE INDEX entities_project_kind_name_idx ON entities(project_id, kind, name);
CREATE TABLE outlines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id TEXT,
  level TEXT NOT NULL,
  chapter_no INTEGER,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX outlines_project_idx ON outlines(project_id, level);
CREATE UNIQUE INDEX outlines_project_chapter_idx ON outlines(project_id, chapter_no);
CREATE TABLE chapters (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  outline_id TEXT REFERENCES outlines(id),
  chapter_no INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  current_revision_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX chapters_project_no_idx ON chapters(project_id, chapter_no);
CREATE TABLE chapter_revisions (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  revision_no INTEGER NOT NULL,
  content TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX revisions_chapter_no_idx ON chapter_revisions(chapter_id, revision_no);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT REFERENCES chapters(id),
  event_time TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  source_revision_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX events_project_time_idx ON events(project_id, event_time);
CREATE TABLE foreshadowing (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  plant_chapter_id TEXT REFERENCES chapters(id),
  payoff_chapter_id TEXT REFERENCES chapters(id),
  status TEXT NOT NULL DEFAULT 'open',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX foreshadowing_project_status_idx ON foreshadowing(project_id, status);
CREATE TABLE review_runs (
  id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES chapter_revisions(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE review_issues (
  id TEXT PRIMARY KEY,
  review_run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  location_start INTEGER,
  location_end INTEGER,
  issue TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  suggested_fix TEXT NOT NULL,
  resolution_status TEXT NOT NULL DEFAULT 'open'
);
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT,
  task_type TEXT NOT NULL,
  state TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX workflow_project_state_idx ON workflow_runs(project_id, state);
CREATE TABLE change_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT,
  source_revision_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT,
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  expected_version INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  content,
  record_id UNINDEXED,
  project_id UNINDEXED,
  record_type UNINDEXED,
  source_id UNINDEXED,
  status UNINDEXED,
  tokenize='trigram'
);
`

/**
 * 迁移 2：把资料库从「名字+简介」升级成能支撑长篇写作的小说资料库。
 * - 人物：角色定位、目标、动机、缺陷、秘密、说话方式、弧光、别名、首次登场
 * - 关系：人物/势力之间的关系、张力与变化节点
 * - 剧情线：主线/支线、目标、当前进度
 * - 场景/节拍：章节内部的场景拆解（目标-冲突-结果），这是写顺一章的关键
 * - 人物状态：按章节记录人物状态快照（能力、立场、伤病、已知信息）
 * - 事件：参与者、地点、重要度
 * - 伏笔：类型、重要度、备注
 * - 素材导入：原文、抽取结果、批处理状态
 */
export const MIGRATION_2 = `
ALTER TABLE projects ADD COLUMN pov TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN tense TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN chapter_words_min INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN chapter_words_max INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN target_chapters INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN themes_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE entities ADD COLUMN role TEXT NOT NULL DEFAULT '';
ALTER TABLE entities ADD COLUMN goal TEXT NOT NULL DEFAULT '';
ALTER TABLE entities ADD COLUMN motivation TEXT NOT NULL DEFAULT '';
ALTER TABLE entities ADD COLUMN flaw TEXT NOT NULL DEFAULT '';
ALTER TABLE entities ADD COLUMN secret TEXT NOT NULL DEFAULT '';
ALTER TABLE entities ADD COLUMN voice TEXT NOT NULL DEFAULT '';
ALTER TABLE entities ADD COLUMN arc TEXT NOT NULL DEFAULT '';
ALTER TABLE entities ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE entities ADD COLUMN first_appearance_chapter_id TEXT;
ALTER TABLE entities ADD COLUMN importance INTEGER NOT NULL DEFAULT 3;

ALTER TABLE chapters ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE chapters ADD COLUMN pov_entity_id TEXT;
ALTER TABLE chapters ADD COLUMN target_words INTEGER NOT NULL DEFAULT 0;

ALTER TABLE events ADD COLUMN participants_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE events ADD COLUMN location_entity_id TEXT;
ALTER TABLE events ADD COLUMN importance INTEGER NOT NULL DEFAULT 3;

ALTER TABLE foreshadowing ADD COLUMN kind TEXT NOT NULL DEFAULT '';
ALTER TABLE foreshadowing ADD COLUMN importance INTEGER NOT NULL DEFAULT 3;
ALTER TABLE foreshadowing ADD COLUMN notes TEXT NOT NULL DEFAULT '';

ALTER TABLE change_proposals ADD COLUMN batch_id TEXT;
ALTER TABLE change_proposals ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE change_proposals ADD COLUMN confidence REAL;

CREATE TABLE relations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  tension TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  since_chapter_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX relations_project_idx ON relations(project_id);
CREATE UNIQUE INDEX relations_unique_idx ON relations(project_id, source_id, target_id, kind);

CREATE TABLE plot_threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'main',
  goal TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  current_chapter_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX plot_threads_project_idx ON plot_threads(project_id, status);
CREATE UNIQUE INDEX plot_threads_unique_idx ON plot_threads(project_id, name);

CREATE TABLE plot_thread_events (
  thread_id TEXT NOT NULL REFERENCES plot_threads(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, event_id)
);

CREATE TABLE scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  scene_no INTEGER NOT NULL,
  beat TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  conflict TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  location_entity_id TEXT,
  cast_json TEXT NOT NULL DEFAULT '[]',
  pov_entity_id TEXT,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX scenes_chapter_no_idx ON scenes(chapter_id, scene_no);

CREATE TABLE character_states (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL,
  chapter_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  state_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX character_states_character_idx ON character_states(character_id, chapter_id);

CREATE TABLE ingest_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  source_text TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'propose',
  status TEXT NOT NULL DEFAULT 'analyzing',
  focus TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  stats_json TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX ingest_batches_project_idx ON ingest_batches(project_id, status);

CREATE INDEX proposals_batch_idx ON change_proposals(batch_id);
CREATE INDEX entities_project_status_idx ON entities(project_id, status);
`

/**
 * 迁移 3：知情矩阵 + 伏笔截止章。
 * - knowledge_facts：一条「事实/秘密」+ 谁知道、知道到什么程度（knows/suspects/misbelieves/unaware）
 *   这是误会、装傻、信息差的地基，也是防「角色开天眼」的审查依据。
 * - foreshadowing.deadline_chapter_id：伏笔最晚要在第几章回收，用来做逾期提醒。
 */
export const MIGRATION_3 = `
ALTER TABLE foreshadowing ADD COLUMN deadline_chapter_id INTEGER;

CREATE TABLE knowledge_facts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  proposition TEXT NOT NULL,
  truth TEXT NOT NULL DEFAULT 'true',
  public_level TEXT NOT NULL DEFAULT 'secret',
  chapter_id TEXT,
  knowers_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX knowledge_project_idx ON knowledge_facts(project_id);
`
