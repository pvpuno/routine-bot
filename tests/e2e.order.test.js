import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedFlow, setup, EMAIL_PEDIDO } from './helpers.js';
import { DuplicateJobError, RoutineError } from '../src/routines/runner.js';

test('e2e flujo feliz: goal → process → clarify → improve(skip) → routines → review → aprobación → job saved+confirmed', async () => {
  const { repo, machine, runner } = setup();
  const userId = 'user-feliz';

  const goal = await machine.handle(userId, 'quiero que cuando llegue un email de pedido con número de orden se guarde en una base y me avises');
  assert.equal(goal.phase, 'goal');
  assert.match(goal.reply, /¿Es correcto\?/);
  assert.equal(machine.status(userId).goal.confirmed, undefined);


  const goal2 = await machine.handle(userId, 'sí, eso es');
  assert.equal(goal2.phase, 'process');
  assert.match(goal2.reply, /brain dump/i);

  const dump = await machine.handle(userId, 'reviso gmail, extraigo el número de orden, lo comparo con el sistema, lo anoto y aviso en el canal');
  assert.equal(dump.phase, 'process');
  assert.match(dump.reply, /\/restate/);
  assert.match(dump.reply, /Pasos:/);
  assert.equal(machine.status(userId).phase, 'process');

  const restateCmd = await machine.handle(userId, '/restate');
  assert.match(restateCmd.reply, /\*\*Meta:\*\*/);

  const toClarify = await machine.handle(userId, 'sí');
  assert.equal(toClarify.phase, 'clarify');
  assert.match(toClarify.reply, /Pregunta 1\/4/);

  const q2 = await machine.handle(userId, 'gana el número del sistema de órdenes; el email a veces está mal');
  assert.match(q2.reply, /Regla guardada/);
  assert.match(q2.reply, /Pregunta 2\/4/);

  const q3 = await machine.handle(userId, 'la fila existe con número de orden único y monto correcto');
  assert.match(q3.reply, /Pregunta 3\/4/);

  const q4 = await machine.handle(userId, 'yo reviso personalmente la orden contra la base antes de darla por confirmada');
  assert.match(q4.reply, /Pregunta 4\/4/);

  const examplesAsk = await machine.handle(userId, 'lo anoto como pendiente y lo re-consulto con la misma clave sin duplicar');
  assert.match(examplesAsk.reply, /3 ejemplos reales/);

  const review = await machine.handle(userId, 'el 0031 salió bien; el 0038 también; una vez falló: se reenvió el mismo correo y casi dupliqué el registro, aprendí a usar clave única');
  assert.equal(review.phase, 'review');
  assert.match(review.reply, /improve: skipped/);
  assert.match(review.reply, /trigger/);
  assert.match(review.reply, /idempotency_key/);
  assert.match(review.reply, /next_step/);


  const status = machine.status(userId);
  assert.ok(status.routine && status.routine.id > 0);
  const kinds = status.rules.map((r) => r.kind);
  for (const k of ['conflict', 'saved', 'confirmed', 'waiting']) assert.ok(kinds.includes(k), `falta regla ${k}`);
  assert.equal(kinds.filter((k) => k === 'example').length, 2);
  assert.equal(kinds.filter((k) => k === 'example_failed').length, 1);

  const storedRoutine = repo.latestRoutine(userId);
  assert.equal(storedRoutine.active, 0);

  assert.throws(() => runner.ingestEmail(userId, EMAIL_PEDIDO), RoutineError);

  const approved = await machine.handle(userId, 'sí');
  assert.equal(approved.phase, 'done');
  assert.equal(repo.latestRoutine(userId).active, 1);

  const ingest = runner.ingestEmail(userId, EMAIL_PEDIDO);
  assert.ok(ingest.job.id > 0);
  assert.equal(ingest.job.status, 'waiting');
  assert.ok(ingest.job.saved_at);
  assert.equal(ingest.job.confirmed_at, null);

  assert.throws(() => runner.ingestEmail(userId, EMAIL_PEDIDO), DuplicateJobError);
  assert.equal(runner.list(userId).length, 1);

  const conf = runner.confirmJob(userId, ingest.idempotencyKey, 'confirmado, la orden está en la base');
  assert.equal(conf.confirmed, true);
  assert.equal(conf.job.status, 'confirmed');
  assert.ok(conf.job.confirmed_at);
  assert.ok(new Date(conf.job.confirmed_at) >= new Date(conf.job.saved_at));

  const listed = runner.list(userId)[0];
  assert.ok(listed.saved_at && listed.confirmed_at);
  assert.ok(new Date(listed.confirmed_at) >= new Date(listed.saved_at), 'confirmed_at no puede ser anterior a saved_at');
  repo.db.close();
});