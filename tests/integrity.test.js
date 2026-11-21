import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { approvedFlow, setup, EMAIL_PEDIDO } from './helpers.js';
import { DuplicateJobError } from '../src/routines/runner.js';
import { openDb } from '../src/db.js';

test('integridad: el mismo email para dos usuarios crea dos jobs; la clave es única por usuario', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, 'user-a');
  await approvedFlow(machine, 'user-b');

  const intakeA = runner.ingestEmail('user-a', EMAIL_PEDIDO);
  const intakeB = runner.ingestEmail('user-b', EMAIL_PEDIDO);
  assert.equal(intakeA.idempotencyKey, intakeB.idempotencyKey, 'misma clave de email, distinto dueño');
  assert.notEqual(intakeA.job.id, intakeB.job.id);
  assert.equal(runner.list('user-a').length, 1);
  assert.equal(runner.list('user-b').length, 1);

  assert.throws(() => runner.ingestEmail('user-a', EMAIL_PEDIDO), DuplicateJobError);
  assert.throws(() => runner.ingestEmail('user-b', EMAIL_PEDIDO), DuplicateJobError);
  assert.equal(runner.list('user-a').length, 1, 'el duplicado de user-a no afecta a user-b');
  assert.equal(runner.list('user-b').length, 1, 'el duplicado de user-b no afecta a user-a');
  repo.db.close();
});

test('integridad: confirmar dos veces es idempotente y no agrega intentos extra', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, 'user-c');


  const intake = runner.ingestEmail('user-c', EMAIL_PEDIDO);
  const first = runner.confirmJob('user-c', intake.idempotencyKey, 'confirmado, revisé yo la orden');
  const second = runner.confirmJob('user-c', intake.idempotencyKey, 'confirmado, revisé yo la orden');
  assert.equal(first.confirmed, true);
  assert.equal(second.confirmed, true);
  assert.equal(second.reason, 'already_confirmed');
  assert.equal(JSON.parse(second.job.attempts).length, 1, 'la re-confirmación no registra otro intento');
  assert.ok(second.job.confirmed_at && second.job.saved_at);
  repo.db.close();
});

test('integridad: pragmas activos (foreign_keys ON y busy_timeout; WAL en DB de archivo)', () => {
  const { repo } = setup();
  assert.equal(repo.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.ok(Number(repo.db.prepare('PRAGMA busy_timeout').get().timeout) >= 5000);
  repo.db.close();

  const dbPath = new URL('../data/test-integrity.db', import.meta.url).pathname;
  const repoFile = openDb(dbPath);
  assert.equal(repoFile.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  repoFile.db.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
});