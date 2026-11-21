import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedFlow, setup, EMAIL_PEDIDO } from './helpers.js';
import { keyFor, DuplicateJobError } from '../src/routines/runner.js';

test('e2e waiting: confirmación fallida deja el job en waiting; reintento no duplica; condición espejo de confirmación explícita', async () => {
  const { repo, machine, runner } = setup();
  const userId = 'user-waiting';

  await approvedFlow(machine, userId);
  assert.equal(repo.latestRoutine(userId).active, 1);

  const email2 = { ...EMAIL_PEDIDO, messageId: '<CAFEBABE-002@mail.tienda.com>', orderNumber: 'ORD-2024-0043' };
  const ingest = runner.ingestEmail(userId, email2);
  assert.equal(ingest.job.status, 'waiting');
  assert.ok(ingest.job.saved_at);
  assert.equal(ingest.job.confirmed_at, null);

  const attempt1 = runner.confirmJob(userId, ingest.idempotencyKey, 'te lo envié');
  assert.equal(attempt1.confirmed, false);
  assert.equal(attempt1.reason, 'sent_does_not_confirm');
  assert.equal(attempt1.job.status, 'waiting');
  assert.equal(attempt1.job.confirmed_at, null);

  const attempt2 = runner.confirmJob(userId, ingest.idempotencyKey, 'enviado');
  assert.equal(attempt2.confirmed, false);
  assert.equal(attempt2.job.status, 'waiting');

  assert.throws(() => runner.ingestEmail(userId, email2), DuplicateJobError);
  let reingestCount = 0;
  try {
    runner.ingestEmail(userId, email2);
  } catch (e) {
    if (e instanceof DuplicateJobError) reingestCount += 1;
  }
  assert.equal(reingestCount, 1, 'cada re-intento del mismo email debe chocar con la clave');
  assert.equal(runner.list(userId).length, 1, 'nunca se re-crea un job para el mismo email');


  const attempts = JSON.parse(attempt2.job.attempts);
  assert.equal(attempts.length, 2);
  assert.ok(attempts.every((a) => a.result === 'rejected'));

  let list = runner.list(userId);
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'waiting');
  assert.ok(list[0].saved_at && !list[0].confirmed_at);

  const ltr = runner.list(userId);
  assert.equal(ltr[0].orderNumber, 'ORD-2024-0043');

  assert.equal(keyFor({ from: 'PEDIDOS@tienda.com', messageId: '<CAFEBABE-002@mail.tienda.com>' }), ingest.idempotencyKey);

  const email3 = { ...EMAIL_PEDIDO, messageId: '<CAFEBABE-003@mail.tienda.com>', orderNumber: 'ORD-2024-0044' };
  runner.ingestEmail(userId, email3);
  assert.equal(runner.list(userId).length, 2, 'un email distinto sí genera su propio job');

  const late = runner.confirmJob(userId, keyFor({ from: email2.from, messageId: email2.messageId }), 'confirmado, revisado yo');
  assert.equal(late.confirmed, true);
  assert.equal(late.job.status, 'confirmed');
  assert.ok(late.job.saved_at && late.job.confirmed_at);
  repo.db.close();
});