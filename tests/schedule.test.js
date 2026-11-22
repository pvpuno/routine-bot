import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedFlow, setup, EMAIL_PEDIDO } from './helpers.js';
import { ScheduleLoop } from '../src/schedule.js';

function fakePoller() {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text) { sent.push([chatId, text]); }
  };
}

function fakeNow(y, m, d, hh, mm) {
  return () => new Date(y, m - 1, d, hh, mm);
}

test('schedule: /schedule <HH:MM> setea, normaliza y /schedule off quita el trigger temporal', async () => {
  const { repo, machine } = setup();
  await approvedFlow(machine, 'user-sched');

  const noArg = await machine.handle('user-sched', '/schedule');
  assert.match(noArg.reply, /Usá "\/schedule HH:MM"/);

  const bad = await machine.handle('user-sched', '/schedule 25:00');
  assert.match(bad.reply, /no es una hora válida/);
  const bad2 = await machine.handle('user-sched', '/schedule mañana');
  assert.match(bad2.reply, /no es una hora válida/);

  const set = await machine.handle('user-sched', '/schedule 9:05');
  assert.match(set.reply, /todos los días a las 09:05/);
  assert.match(set.reply, /nada se confirma ni ejecuta solo/, 'el aviso deja claro que no ejecuta');
  assert.equal(repo.activeRoutine('user-sched').schedule, '09:05');

  const list = await machine.handle('user-sched', '/routines');
  assert.match(list.reply, /diaria 09:05/);

  const off = await machine.handle('user-sched', '/schedule off');
  assert.match(off.reply, /Trigger temporal quitado/);
  assert.equal(repo.activeRoutine('user-sched').schedule, null);
  repo.db.close();
});

test('schedule: /schedule exige rutina activa del usuario', async () => {
  const { repo, machine } = setup();
  const noRoutine = await machine.handle('user-x', '/schedule 08:30');
  assert.match(noRoutine.reply, /No hay rutina activa/);
  assert.equal(repo.scheduledRoutines().length, 0);

  const offNoRoutine = await machine.handle('user-x', '/schedule off');
  assert.match(offNoRoutine.reply, /No hay rutina activa/);
  repo.db.close();
});

test('schedule: dispara en la hora programada, una vez por día, y con el count correcto', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, 'user-daily');
  const routine = repo.activeRoutine('user-daily');
  repo.setRoutineSchedule(routine.id, '08:30');
  runner.ingestEmail('user-daily', { ...EMAIL_PEDIDO, messageId: '<D1@mail.com>' });
  runner.ingestEmail('user-daily', { ...EMAIL_PEDIDO, messageId: '<D2@mail.com>' });
  runner.confirmJob('user-daily', runner.list('user-daily')[0].idempotency_key, 'confirmado, la orden está en la base');
  const poller = fakePoller();
  const loop = new ScheduleLoop({ repo, poller, tickMs: 60000, now: fakeNow(2026, 1, 1, 8, 30) });

  let fired = await loop.runOnce();
  assert.deepEqual(fired, [routine.id]);
  assert.equal(poller.sent.length, 1);
  assert.equal(poller.sent[0][0], 'user-daily');
  assert.match(poller.sent[0][1], /Aviso diario 08:30/);
  assert.match(poller.sent[0][1], /1 job\(s\) en waiting/, 'cuenta solo waiting (uno quedó confirmado)');
  assert.match(poller.sent[0][1], /\/confirm/);

  fired = await loop.runOnce();
  assert.deepEqual(fired, [], 'mismo día, mismo minuto: no re-dispara');
  assert.equal(poller.sent.length, 1);

  const notTime = new ScheduleLoop({ repo, poller, tickMs: 60000, now: fakeNow(2026, 1, 1, 8, 31) });
  fired = await notTime.runOnce();
  assert.deepEqual(fired, [], 'a las 08:31 no dispara');

  const nextDay = new ScheduleLoop({ repo, poller, tickMs: 60000, now: fakeNow(2026, 1, 2, 8, 30) });
  fired = await nextDay.runOnce();
  assert.deepEqual(fired, [routine.id], 'al día siguiente vuelve a avisar');
  assert.equal(poller.sent.length, 2);
  repo.db.close();
});

test('schedule: sin waiting dice todo al día; rutina inactiva no dispara', async () => {
  const { repo, machine } = setup();
  await approvedFlow(machine, 'user-clean');
  const routine = repo.activeRoutine('user-clean');
  repo.setRoutineSchedule(routine.id, '22:00');
  const poller = fakePoller();

  const loop = new ScheduleLoop({ repo, poller, tickMs: 60000, now: fakeNow(2026, 3, 5, 22, 0) });
  let fired = await loop.runOnce();
  assert.deepEqual(fired, [routine.id]);
  assert.match(poller.sent[0][1], /Nada en waiting: todo al día/);

  await machine.handle('user-clean', '/routine off');
  const afterOff = new ScheduleLoop({ repo, poller, tickMs: 60000, now: fakeNow(2026, 3, 6, 22, 0) });
  fired = await afterOff.runOnce();
  assert.deepEqual(fired, [], 'desactivada la rutina, no avisa');
  assert.equal(poller.sent.length, 1);

  await machine.handle('user-clean', `/routine ${routine.id}`);
  const reactivated = new ScheduleLoop({ repo, poller, tickMs: 60000, now: fakeNow(2026, 3, 7, 22, 0) });
  fired = await reactivated.runOnce();
  assert.deepEqual(fired, [routine.id], 'reactivada: avisos otra vez');
  repo.db.close();
});

test('schedule: dos rutinas con horarios distintos solo disparan la que corresponde', async () => {
  const { repo, machine } = setup();
  await approvedFlow(machine, 'user-morning');
  await approvedFlow(machine, 'user-evening');
  repo.setRoutineSchedule(repo.activeRoutine('user-morning').id, '09:00');
  repo.setRoutineSchedule(repo.activeRoutine('user-evening').id, '18:00');

  const poller = fakePoller();
  const morning = new ScheduleLoop({ repo, poller, tickMs: 60000, now: fakeNow(2026, 5, 1, 9, 0) });
  const fired = await morning.runOnce();
  assert.equal(fired.length, 1, 'solo una rutina dispara a las 09:00');
  assert.equal(poller.sent.length, 1);
  assert.equal(poller.sent[0][0], 'user-morning');

  const evening = new ScheduleLoop({ repo, poller, tickMs: 60000, now: fakeNow(2026, 5, 1, 18, 0) });
  const firedEvening = await evening.runOnce();
  assert.equal(firedEvening.length, 1);
  assert.equal(poller.sent.length, 2);
  assert.equal(poller.sent[1][0], 'user-evening');

  const otherTime = new ScheduleLoop({ repo, poller, tickMs: 60000, now: fakeNow(2026, 5, 1, 12, 0) });
  assert.deepEqual(await otherTime.runOnce(), [], 'a las 12:00 no avisa nadie');
  assert.equal(poller.sent.length, 2);
  repo.db.close();
});

test('schedule: el timer real corre y un fallo de envío se loguea sin crashear', async () => {
  const { repo, machine } = setup();
  await approvedFlow(machine, 'user-timer');
  const routine = repo.activeRoutine('user-timer');
  repo.setRoutineSchedule(routine.id, '08:30');
  let failing = true;
  const poller = { async sendMessage() { if (failing) throw new Error('telegram caído'); } };
  const errors = [];
  const loop = new ScheduleLoop({
    repo, poller, tickMs: 40, now: fakeNow(2026, 1, 1, 8, 30),
    logger: { log: () => {}, error: (m) => errors.push(m) }
  });
  loop.start();
  assert.equal(loop.running, true);
  await new Promise((r) => setTimeout(r, 120));
  loop.stop();
  assert.ok(errors.length >= 1, 'fallo logueado, proceso vive');

  failing = false;
  const sent = [];
  poller.sendMessage = async (c, txt) => sent.push([c, txt]);
  repo.saveCursor(`schedule:${routine.id}`, '1999-01-01');
  loop.start();
  await new Promise((r) => setTimeout(r, 120));
  loop.stop();
  assert.equal(sent.length, 1, 'recuperado: el siguiente tick avisa');
  repo.db.close();
});
