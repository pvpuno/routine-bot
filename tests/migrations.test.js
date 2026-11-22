import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';

test('migraciones: base nueva registra schema_version y las columnas/tablas vigentes', () => {
  const repo = openDb(':memory:');
  const versions = repo.db.prepare('SELECT version FROM schema_version ORDER BY version').all().map((r) => r.version);
  assert.deepEqual(versions, [1, 2], 'las migraciones quedan registradas una vez cada una');
  const columns = repo.db.prepare('PRAGMA table_info(routines)').all().map((c) => c.name);
  assert.ok(columns.includes('schedule'), 'la columna schedule existe');
  assert.ok(columns.includes('action_config'), 'la columna action_config existe');
  assert.ok(
    repo.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'action_runs'").get(),
    'la tabla action_runs existe en una base nueva'
  );
  repo.db.close();
});

test('migraciones: base vieja sin schedule (pre-trigger temporal) se migra sola hasta la versión actual', () => {
  const dbPath = new URL('../data/test-migraciones.db', import.meta.url).pathname;
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });

  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE routines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      user_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      action TEXT NOT NULL,
      idempotency_key_rule TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  raw.close();

  const repo = openDb(dbPath);
  const columns = repo.db.prepare('PRAGMA table_info(routines)').all().map((c) => c.name);
  assert.ok(columns.includes('schedule'), 'la migración agregó schedule');
  assert.ok(columns.includes('action_config'), 'la migración agregó action_config');
  assert.ok(
    repo.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'action_runs'").get(),
    'la migración creó action_runs'
  );
  assert.equal(
    repo.db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v,
    2,
    'versión máxima registrada'
  );

  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM schema_version').get().n, 2, 'sin duplicados de versión');
  repo.setRoutineSchedule(1, null);
  repo.setRoutineActionConfig(1, null);
  repo.db.close();

  const raw2 = new DatabaseSync(dbPath);
  const cols = raw2.prepare('PRAGMA table_info(routines)').all().map((c) => c.name);
  raw2.close();
  assert.ok(cols.includes('schedule') && cols.includes('action_config'), 'las columnas persisten en el archivo');

  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
});
