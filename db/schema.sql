CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'goal',
  context TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  user_id TEXT NOT NULL,
  original_text TEXT NOT NULL,
  restated TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);


CREATE TABLE IF NOT EXISTS processes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  user_id TEXT NOT NULL,
  brain_dump TEXT NOT NULL,
  steps TEXT NOT NULL,
  watch_outs TEXT NOT NULL,
  tools TEXT NOT NULL,
  check_work TEXT NOT NULL,
  info_from TEXT NOT NULL,
  feedback_from TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  user_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  action TEXT NOT NULL,
  idempotency_key_rule TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id INTEGER NOT NULL REFERENCES routines(id),
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'waiting',
  payload TEXT NOT NULL,
  attempts TEXT NOT NULL DEFAULT '[]',
  saved_at TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, active);
CREATE INDEX IF NOT EXISTS idx_rules_conversation ON rules(conversation_id);
CREATE INDEX IF NOT EXISTS idx_routines_user ON routines(user_id);
CREATE INDEX IF NOT EXISTS idx_jobs_key ON jobs(idempotency_key);
