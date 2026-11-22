import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';

test('migraciones: base nueva registra schema_version y la columna schedule', () => {
  const repo = openDb(':memory:');
  const versions = repo.db.prepare('SELECT version FROM schema_version ORDER BY version').all().map((r) => r.version);
  assert.deepEqual(versions, [1], 'la migración 1 queda registrada una sola vez');
  assert.ok(
    repo.db.prepare('PRAGMA table_info(routines)').all().some((c) => c.name === 'schedule'),
    'la columna schedule existe'
  );
  repo.db.close();
});

test('migraciones: base vieja sin schedule (pre-trigger temporal) se migra sola', () => {
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
  assert.ok(
    repo.db.prepare('PRAGMA table_info(routines)').all().some((c) => c.name === 'schedule'),
    'la migración agregó schedule'
  );
  assert.equal(
    repo.db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v,
    1,
    'versión registrada'
  );

  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM schema_version').get().n, 1, 'sin duplicados de versión');
  repo.setRoutineSchedule(1, null);
  repo.db.close();

  const raw2 = new DatabaseSync(dbPath);
  const cols = raw2.prepare('PRAGMA table_info(routines)').all().map((c) => c.name);
  raw2.close();
  assert.ok(cols.includes('schedule'), 'la columna persiste en el archivo');

  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
});
