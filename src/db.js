import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const SCHEMA_SQL = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

export function openDb(file = config.DB_PATH) {
  fs.mkdirSync(file === ':memory:' ? '.' : path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA_SQL);
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
      'INSERT INTO routines (conversation_id, user_id, trigger, action, idempotency_key_rule, active) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(conv.id, userId, routine.trigger, action, routine.idempotency_key_rule, routine.active ? 1 : 0);
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

  waitingJobsByUser() {
    return this.db.prepare(
      "SELECT user_id, COUNT(*) AS count, MIN(saved_at) AS oldest FROM jobs WHERE status = 'waiting' AND saved_at IS NOT NULL GROUP BY user_id ORDER BY oldest"
    ).all();
  }

  jobsFor(userId, status = null) {
    if (status) {
      return this.db.prepare('SELECT * FROM jobs WHERE user_id = ? AND status = ? ORDER BY id').all(userId, status);
    }
    return this.db.prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY id').all(userId);
  }
}