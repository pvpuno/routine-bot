import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const SCHEMA_SQL = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

function columnExists(db, table, name) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name);
}

// Migraciones para bases creadas antes del schema vigente. Idempotentes:
// saltan si la columna ya existe (bases sin schema_version) y registran su versión.
const MIGRATIONS = [
  {
    version: 1,
    description: 'routines.schedule para el trigger temporal',
    run(db) {
      if (!columnExists(db, 'routines', 'schedule')) {
        db.exec('ALTER TABLE routines ADD COLUMN schedule TEXT');
      }
    }
  },
  {
    version: 2,
    description: 'routines.action_config y tabla action_runs para acciones post-confirmación',
    run(db) {
      if (!columnExists(db, 'routines', 'action_config')) {
        db.exec('ALTER TABLE routines ADD COLUMN action_config TEXT');
      }
      db.exec(
        `CREATE TABLE IF NOT EXISTS action_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL REFERENCES jobs(id),
          routine_id INTEGER,
          user_id TEXT NOT NULL,
          adapter TEXT NOT NULL,
          target TEXT NOT NULL,
          status TEXT NOT NULL,
          http_status INTEGER,
          response TEXT,
          error TEXT,
          started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          finished_at TEXT
        )`
      );
      db.exec('CREATE INDEX IF NOT EXISTS idx_action_runs_user ON action_runs(user_id, id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_action_runs_job ON action_runs(job_id)');
    }
  }
];

export function openDb(file = config.DB_PATH) {
  fs.mkdirSync(file === ':memory:' ? '.' : path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA_SQL);
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))"
  );
  let current = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v || 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    migration.run(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
    current = migration.version;
  }
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return new Repo(db);
}

const J = (v) => JSON.stringify(v ?? null);
const P = (v, fallback = null) => {
  try { return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
};
const now = () => new Date().toISOString();

export class Repo {
  constructor(db) {
    this.db = db;
  }

  #withTransaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ya no hay transacción activa */ }
      throw err;
    }
  }

  conversation(user_id) {
    let row = this.db.prepare(
      'SELECT * FROM conversations WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1'
    ).get(user_id);
    if (!row) {
      this.db.prepare("INSERT INTO conversations (user_id, phase, context, active) VALUES (?, 'goal', '{}', 1)").run(user_id);
      row = this.db.prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(user_id);
    }
    return { ...row, ctx: P(row.context, {}) };
  }


  saveContext(conv, ctx, phase = conv.phase) {
    this.db.prepare(
      'UPDATE conversations SET context = ?, phase = ?, updated_at = ? WHERE id = ?'
    ).run(J(ctx), phase, now(), conv.id);
    return { ...conv, ctx, phase };
  }

  closeConversation(conv) {
    this.db.prepare('UPDATE conversations SET active = 0, updated_at = ? WHERE id = ?').run(now(), conv.id);
  }

  saveGoal(conv, userId, original, restated, confirmed) {
    this.db.prepare(
      'INSERT INTO goals (conversation_id, user_id, original_text, restated, confirmed) VALUES (?, ?, ?, ?, ?)'
    ).run(conv.id, userId, original, restated ?? null, confirmed ? 1 : 0);
  }

  latestGoal(convId) {
    return this.db.prepare('SELECT * FROM goals WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(convId) || null;
  }

  latestProcess(convId) {
    return this.db.prepare('SELECT * FROM processes WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(convId) || null;
  }

  saveProcess(conv, userId, brainDump, structured, confirmed) {
    this.db.prepare(
      `INSERT INTO processes (conversation_id, user_id, brain_dump, steps, watch_outs, tools, check_work, info_from, feedback_from, confirmed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      conv.id, userId, brainDump,
      J(structured.steps), J(structured.watch_outs), J(structured.tools),
      J(structured.check_work), J(structured.info_from), J(structured.feedback_from),
      confirmed ? 1 : 0
    );
  }

  addRule(conv, userId, kind, text) {
    this.db.prepare('INSERT INTO rules (conversation_id, user_id, kind, text) VALUES (?, ?, ?, ?)')
      .run(conv.id, userId, kind, text);
  }

  rules(convId) {
    return this.db.prepare('SELECT * FROM rules WHERE conversation_id = ? ORDER BY id').all(convId);
  }


  saveRoutine(conv, userId, routine) {
    const action = Array.isArray(routine.action) ? JSON.stringify(routine.action) : String(routine.action);
    const res = this.db.prepare(
      'INSERT INTO routines (conversation_id, user_id, trigger, action, idempotency_key_rule, active, schedule) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(conv.id, userId, routine.trigger, action, routine.idempotency_key_rule, routine.active ? 1 : 0, routine.schedule ?? null);
    return this.db.prepare('SELECT * FROM routines WHERE id = ?').get(res.lastInsertRowid);
  }

  latestRoutine(userId) {
    return this.db.prepare('SELECT * FROM routines WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId) || null;
  }

  routinesFor(userId) {
    return this.db.prepare('SELECT * FROM routines WHERE user_id = ? ORDER BY id DESC').all(userId);
  }

  routine(id) {
    return this.db.prepare('SELECT * FROM routines WHERE id = ?').get(id) || null;
  }

  activeRoutine(userId) {
    return this.db.prepare('SELECT * FROM routines WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(userId) || null;
  }

  setRoutineActive(routineId, active) {
    this.db.prepare('UPDATE routines SET active = ? WHERE id = ?').run(active ? 1 : 0, routineId);
  }

  // Una sola rutina activa por usuario: apagar las demás y encender esta.
  activateRoutine(routineId, userId) {
    return this.#withTransaction(() => {
      this.db.prepare('UPDATE routines SET active = 0 WHERE user_id = ? AND active = 1').run(userId);
      this.db.prepare('UPDATE routines SET active = 1 WHERE id = ? AND user_id = ?').run(routineId, userId);
      return this.db.prepare('SELECT * FROM routines WHERE id = ? AND user_id = ?').get(routineId, userId) || null;
    });
  }

  findJob(idempotency_key, userId = null) {
    if (userId != null) {
      return this.db.prepare('SELECT * FROM jobs WHERE idempotency_key = ? AND user_id = ?').get(idempotency_key, userId) || null;
    }
    return this.db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(idempotency_key) || null;
  }

  insertJob(routine, userId, idempotency_key, payload) {
    const res = this.db.prepare(
      "INSERT INTO jobs (routine_id, user_id, idempotency_key, status, payload, saved_at, confirmed_at) VALUES (?, ?, ?, 'waiting', ?, ?, NULL) ON CONFLICT(user_id, idempotency_key) DO NOTHING"
    ).run(routine.id, userId, idempotency_key, J(payload), now());
    return res.changes === 0 ? null : this.findJob(idempotency_key, userId);
  }


  confirmJob(jobId, note) {
    return this.#withTransaction(() => {
      const job = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      const attempts = P(job.attempts, []);
      attempts.push({ at: now(), result: 'confirmed', note });
      this.db.prepare(
        "UPDATE jobs SET status = 'confirmed', confirmed_at = ?, attempts = ? WHERE id = ?"
      ).run(now(), J(attempts), jobId);
      return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    });
  }

  logAttempt(jobId, note) {
    return this.#withTransaction(() => {
      const job = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      const attempts = P(job.attempts, []);
      attempts.push({ at: now(), result: 'rejected', note });
      this.db.prepare('UPDATE jobs SET attempts = ? WHERE id = ?').run(J(attempts), jobId);
      return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    });
  }

  failJob(jobId, note) {
    return this.#withTransaction(() => {
      const job = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
      const attempts = P(job.attempts, []);
      attempts.push({ at: now(), result: 'failed', note });
      this.db.prepare("UPDATE jobs SET status = 'failed', attempts = ? WHERE id = ?").run(J(attempts), jobId);
      return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    });
  }

  job(id) {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  }

  cursor(name) {
    const row = this.db.prepare('SELECT value FROM cursors WHERE name = ?').get(name);
    return row ? row.value : null;
  }

  saveCursor(name, value) {
    this.db.prepare(
      'INSERT INTO cursors (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value'
    ).run(name, String(value));
  }

  usersWithJobs() {
    return this.db.prepare('SELECT DISTINCT user_id FROM jobs ORDER BY user_id').all();
  }

  waitingJobsByUser() {
    return this.db.prepare(
      "SELECT user_id, COUNT(*) AS count, MIN(saved_at) AS oldest FROM jobs WHERE status = 'waiting' AND saved_at IS NOT NULL GROUP BY user_id ORDER BY oldest"
    ).all();
  }

  scheduledRoutines() {
    return this.db.prepare(
      "SELECT id, user_id, schedule, trigger FROM routines WHERE active = 1 AND schedule IS NOT NULL AND schedule != '' ORDER BY schedule"
    ).all();
  }

  setRoutineSchedule(routineId, schedule) {
    this.db.prepare('UPDATE routines SET schedule = ? WHERE id = ?').run(schedule == null || schedule === '' ? null : String(schedule), routineId);
  }

  jobsFor(userId, status = null) {
    if (status) {
      return this.db.prepare('SELECT * FROM jobs WHERE user_id = ? AND status = ? ORDER BY id').all(userId, status);
    }
    return this.db.prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY id').all(userId);
  }

  // Backup online: escribe una copia consistente sin frenar al bot.
  vacuumInto(file) {
    const safe = String(file).replace(/'/g, "''");
    this.db.exec(`VACUUM INTO '${safe}'`);
  }

  // Purga los jobs TERMINADOS (confirmados/fallidos) más viejos que `days` días;
  // los waiting jamás se tocan. Borra primero sus action_runs para no dejar huérfanos.
  pruneJobs(userId, days) {
    if (!(Number(days) >= 0)) throw new Error('pruneJobs: days debe ser un número >= 0');
    const cutoff = new Date(Date.now() - Number(days) * 86400000).toISOString();
    const marks = this.db.prepare(
      "SELECT id FROM jobs WHERE user_id = ? AND status IN ('confirmed', 'failed') AND COALESCE(confirmed_at, saved_at) IS NOT NULL AND COALESCE(confirmed_at, saved_at) <= ?"
    ).all(userId, cutoff);
    if (!marks.length) return { deletedJobs: 0, deletedRuns: 0 };
    const ids = marks.map((r) => r.id);
    const ph = ids.map(() => '?').join(',');
    const runs = this.db.prepare(`DELETE FROM action_runs WHERE job_id IN (${ph})`).run(...ids);
    const jobs = this.db.prepare(`DELETE FROM jobs WHERE id IN (${ph})`).run(...ids);
    return { deletedJobs: Number(jobs.changes), deletedRuns: Number(runs.changes) };
  }

  health() {
    const jobs = {};
    for (const row of this.db.prepare('SELECT status, COUNT(*) AS c FROM jobs GROUP BY status').all()) {
      jobs[row.status] = Number(row.c);
    }
    const routines = Number(this.db.prepare('SELECT COUNT(*) AS c FROM routines').get().c);
    const activeRoutines = Number(this.db.prepare('SELECT COUNT(*) AS c FROM routines WHERE active = 1').get().c);
    const schemaVersion = Number(this.db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v || 0);
    const cursors = Number(this.db.prepare('SELECT COUNT(*) AS c FROM cursors').get().c);
    return { jobs, routines, activeRoutines, schemaVersion, cursors };
  }

  setRoutineActionConfig(routineId, cfg) {
    this.db.prepare('UPDATE routines SET action_config = ? WHERE id = ?').run(cfg == null ? null : J(cfg), routineId);
  }

  insertActionRun({ jobId, routineId, userId, adapter, target }) {
    const res = this.db.prepare(
      "INSERT INTO action_runs (job_id, routine_id, user_id, adapter, target, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)"
    ).run(jobId, routineId ?? null, userId, adapter, target, now());
    return Number(res.lastInsertRowid);
  }

  finishActionRun(id, { status, httpStatus = null, response = null, error = null }) {
    this.db.prepare(
      'UPDATE action_runs SET status = ?, http_status = ?, response = ?, error = ?, finished_at = ? WHERE id = ?'
    ).run(status, httpStatus, response == null ? null : String(response).slice(0, 2000), error, now(), id);
  }

  actionRunsFor(userId, limit = 10) {
    return this.db.prepare('SELECT * FROM action_runs WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(userId, Math.min(50, Math.max(1, Number(limit) || 10)));
  }

  successfulActionRun(jobId, target) {
    return this.db.prepare(
      "SELECT id FROM action_runs WHERE job_id = ? AND target = ? AND status = 'ok' LIMIT 1"
    ).get(jobId, target) || null;
  }
}