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
