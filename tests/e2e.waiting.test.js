import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedFlow, setup, EMAIL_PEDIDO } from './helpers.js';
import { keyFor, DuplicateJobError } from '../src/routines/runner.js';

test('e2e waiting: "enviado" no confirma en el diálogo; "sí" explícito confirma; re-ingest no duplica', async () => {
  const { repo, machine, runner } = setup();
  const userId = 'user-waiting';

  await approvedFlow(machine, userId);
  assert.equal(repo.latestRoutine(userId).active, 1);


  const email2 = { ...EMAIL_PEDIDO, messageId: '<CAFEBABE-002@mail.tienda.com>', orderNumber: 'ORD-2024-0043' };
  const email3 = { ...EMAIL_PEDIDO, messageId: '<CAFEBABE-003@mail.tienda.com>', orderNumber: 'ORD-2024-0044' };
  runner.ingestEmail(userId, email2);
  runner.ingestEmail(userId, email3);
  assert.equal(runner.list(userId).length, 2);
  assert.ok(runner.list(userId).every((j) => j.status === 'waiting' && j.saved_at && !j.confirmed_at));

  const ask = await machine.handle(userId, '/confirm');
  assert.match(ask.reply, /ORD-2024-0043/, 'arranca por el job más viejo');
  assert.match(ask.reply, /saved_at/);
  assert.equal(machine.status(userId).confirming?.idempotency_key, keyFor(email2));

  const attempt1 = await machine.handle(userId, 'te lo envié');
  assert.match(attempt1.reply, /no cuenta/i);
  assert.equal(runner.list(userId)[0].status, 'waiting');
  assert.equal(runner.list(userId)[0].confirmed_at, null);

  const attempt2 = await machine.handle(userId, 'enviado');
  assert.match(attempt2.reply, /no cuenta/i);
  const attempts = JSON.parse(repo.findJob(keyFor(email2), userId).attempts);
  assert.equal(attempts.length, 2, 'cada respuesta "enviado" queda registrada como intento rechazado');
  assert.ok(attempts.every((a) => a.result === 'rejected'));

  assert.throws(() => runner.ingestEmail(userId, email2), DuplicateJobError);
  assert.equal(runner.list(userId).length, 2, 'nunca se re-crea un job para el mismo email');
  assert.equal(keyFor({ from: 'PEDIDOS@tienda.com', messageId: '<CAFEBABE-002@mail.tienda.com>' }), keyFor(email2));


  const conf1 = await machine.handle(userId, 'sí');
  assert.match(conf1.reply, /confirmada/i);
  assert.match(conf1.reply, /ORD-2024-0044/, 'con más jobs en waiting, pregunta el siguiente sin pedir /confirm');
  const job2 = repo.findJob(keyFor(email2), userId);
  assert.equal(job2.status, 'confirmed');
  assert.ok(job2.saved_at && job2.confirmed_at);
  assert.ok(new Date(job2.confirmed_at) >= new Date(job2.saved_at), 'confirmed_at no puede ser anterior a saved_at');

  const rej2 = await machine.handle(userId, 'no');
  assert.match(rej2.reply, /waiting/);
  assert.equal(runner.list(userId, 'waiting').length, 1, 'el "no" deja la orden 0044 en waiting');
  assert.equal(machine.status(userId).confirming, null);

  const retake = await machine.handle(userId, '/confirm');
  assert.match(retake.reply, /ORD-2024-0044/);
  const conf2 = await machine.handle(userId, 'sí');
  assert.match(conf2.reply, /Confirmada/);
  assert.equal(runner.list(userId, 'waiting').length, 0);
  assert.equal(machine.status(userId).confirming, null, 'cerrado el diálogo, no queda flujo de confirmación abierto');
  const job3 = repo.findJob(keyFor(email3), userId);
  assert.equal(job3.status, 'confirmed');
  repo.db.close();
});