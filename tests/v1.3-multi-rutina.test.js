import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedFlow, setup, EMAIL_PEDIDO } from './helpers.js';
import { DuplicateJobError, RoutineError } from '../src/routines/runner.js';

test('multi-rutina: dos rutinas aprobadas conviven; el job va contra la activa', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, 'user-multi');
  await machine.handle('user-multi', '/reset');
  await approvedFlow(machine, 'user-multi');

  const routines = repo.routinesFor('user-multi');
  assert.equal(routines.length, 2, 'la segunda aprobación no mata a la primera');
  const active = repo.activeRoutine('user-multi');
  assert.equal(active.id, routines[0].id, 'queda activa la última aprobada');

  const intake = runner.ingestEmail('user-multi', { ...EMAIL_PEDIDO });
  assert.equal(intake.routine_id, active.id, 'el job se ingiere contra la rutina activa');

  const listed = await machine.handle('user-multi', '/routines');
  assert.match(listed.reply, /\[id 1\]/);
  assert.match(listed.reply, /\[id 2\]/);
  assert.match(listed.reply, /\*\*ACTIVA\*\*/);
  assert.match(listed.reply, /inactiva/);

  repo.db.close();
});

test('multi-rutina: /routine <id> cambia la activa y los eventos nuevos van a esa rutina', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, 'user-switch');
  await machine.handle('user-switch', '/reset');
  await approvedFlow(machine, 'user-switch');
  const routines = repo.routinesFor('user-switch');
  const oldRoutine = routines[routines.length - 1];

  const switched = await machine.handle('user-switch', `/routine ${oldRoutine.id}`);
  assert.equal(repo.activeRoutine('user-switch').id, oldRoutine.id);
  assert.match(switched.reply, new RegExp(`\\[id ${oldRoutine.id}\\] activada`));
  assert.equal(repo.routinesFor('user-switch').filter((r) => r.active).length, 1, 'una sola activa por usuario');

  const intake = runner.ingestEmail('user-switch', { ...EMAIL_PEDIDO, messageId: '<CAFEBABE-002@mail.tienda.com>' });
  assert.equal(intake.routine_id, oldRoutine.id);

  const back = await machine.handle('user-switch', `/routine ${routines[0].id}`);
  assert.equal(repo.activeRoutine('user-switch').id, routines[0].id);
  assert.match(back.reply, /activada/);

  const intake2 = runner.ingestEmail('user-switch', { ...EMAIL_PEDIDO, messageId: '<CAFEBABE-003@mail.tienda.com>' });
  assert.equal(intake2.routine_id, routines[0].id);
  assert.notEqual(intake.job.id, intake2.job.id, 'claves distintas, usuarios iguales, ambos jobs existen');

  assert.throws(
    () => runner.ingestEmail('user-switch', { ...EMAIL_PEDIDO, messageId: '<CAFEBABE-002@mail.tienda.com>' }),
    DuplicateJobError,
    'la clave sigue siendo única por usuario, más allá de cuál rutina esté activa'
  );
  repo.db.close();
});

test('multi-rutina: /routine off deja todo en waiting y aparece el DuplicateJob aunque cambie de rutina', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, 'user-off');
  const intake = runner.ingestEmail('user-off', { ...EMAIL_PEDIDO });

  const out = await machine.handle('user-off', '/routine off');
  assert.match(out.reply, /Sin rutina activa/);
  assert.equal(repo.activeRoutine('user-off'), null);
  assert.throws(
    () => runner.ingestEmail('user-off', { ...EMAIL_PEDIDO, messageId: '<OTRO@mail.com>' }),
    (e) => e instanceof RoutineError && e.code === 'no_active_routine'
  );

  assert.throws(
    () => runner.ingestEmail('user-off', { ...EMAIL_PEDIDO }),
    (e) => e instanceof RoutineError && e.code === 'no_active_routine'
  );

  assert.equal(runner.list('user-off').length, 1, 'el job waiting sigue intacto y confirmable');
  const confirmed = runner.confirmJob('user-off', intake.idempotencyKey, 'confirmado, la orden está en la base');
  assert.equal(confirmed.confirmed, true);
  assert.ok(confirmed.job.confirmed_at && confirmed.job.saved_at, 'saved_at y confirmed_at siguen siendo dos timestamps');

  const routines = repo.routinesFor('user-off');
  await machine.handle('user-off', `/routine ${routines[0].id}`);
  assert.throws(
    () => runner.ingestEmail('user-off', { ...EMAIL_PEDIDO }),
    DuplicateJobError,
    'la clave sigue siendo única por usuario aunque la rutina se desactive/reactive'
  );
  runner.failJob('user-off', intake.idempotencyKey, 'prueba');
  assert.equal(runner.list('user-off', 'failed').length, 1);

  repo.db.close();
});

test('multi-rutina: no se activan ids ajenos, inexistentes o basura', async () => {
  const { repo, machine } = setup();
  await approvedFlow(machine, 'user-owner');
  const foreignId = repo.routinesFor('user-owner')[0].id;

  const empty = await machine.handle('user-x', '/routine');
  assert.match(empty.reply, /Usá "\/routine <id>"/);

  const off = await machine.handle('user-x', '/routine off');
  assert.match(off.reply, /Sin rutina activa/, '/routine off sin rutina activa es válido y no rompe');
  assert.equal(repo.activeRoutine('user-x'), null);

  const bogus = await machine.handle('user-x', '/routine abc');
  assert.match(bogus.reply, /no es un id de rutina/);

  const missing = await machine.handle('user-x', '/routine 9999');
  assert.match(missing.reply, /No encuentro la rutina 9999 que sea tuya/);

  const foreign = await machine.handle('user-other', `/routine ${foreignId}`);
  assert.match(foreign.reply, /No encuentro la rutina/);
  assert.equal(repo.activeRoutine('user-other'), null, 'la rutina ajena no se activó');

  const owner = await machine.handle('user-owner', `/routine ${foreignId}`);
  assert.match(owner.reply, /activada/, 'el dueño sí puede reactivarla');

  repo.db.close();
});
