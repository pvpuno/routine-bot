import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedFlow, EMAIL_PEDIDO, setup } from './helpers.js';

test('prune: borra confirmados/fallidos viejos de tu user con sus action_runs; los waiting jamás', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, '42');

  const a = runner.ingestEmail('42', { ...EMAIL_PEDIDO, messageId: '<P1@x.com>' });
  const b = runner.ingestEmail('42', { ...EMAIL_PEDIDO, messageId: '<P2@x.com>' });
  runner.ingestEmail('42', { ...EMAIL_PEDIDO, messageId: '<P3@x.com>' });

  runner.confirmJob('42', a.idempotencyKey, 'confirmado, quedó en la base');
  runner.failJob('42', b.idempotencyKey, 'algo falló');
  repo.insertActionRun({ jobId: a.job.id, routineId: a.routine_id, userId: '42', adapter: 'webhook', target: 'https://ejemplo.com/hook' });

  const backdate = '2020-01-01T00:00:00.000Z';
  repo.db.prepare('UPDATE jobs SET saved_at = ?, confirmed_at = ? WHERE id = ?').run(backdate, backdate, a.job.id);
  repo.db.prepare('UPDATE jobs SET saved_at = ? WHERE id = ?').run(backdate, b.job.id);

  const reply = await machine.handle('42', '/prune 30');
  assert.match(reply.reply, /Purga lista: 2 job/);
  assert.match(reply.reply, /1 run/);
  assert.match(reply.reply, /Los waiting no se tocan/);

  const jobs = repo.jobsFor('42');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'waiting', 'el waiting sobrevive a la purga');
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS c FROM action_runs').get().c, 0, 'las runs del job purgado se van con él');

  repo.db.close();
});

test('prune: sin días usa 30; arg inválido avisa; sin candidatos no rompe', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, '42');
  runner.ingestEmail('42', { ...EMAIL_PEDIDO, messageId: '<P4@x.com>' });

  const vacio = await machine.handle('42', '/prune');
  assert.match(vacio.reply, /Nada para purgar/, 'el job es waiting de hoy: nada purgable');

  const invalido = await machine.handle('42', '/prune ayer');
  assert.match(invalido.reply, /debe ser un entero/);

  const cap = await machine.handle('42', '/prune 9999');
  assert.ok(cap.reply.includes('365'), 'el tope es 365 días');

  repo.db.close();
});
