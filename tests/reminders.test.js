import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedFlow, setup, EMAIL_PEDIDO, StubFormatter } from './helpers.js';
import { openDb } from '../src/db.js';
import { StateMachine } from '../src/machine.js';
import { Runner } from '../src/routines/runner.js';
import { ReminderLoop } from '../src/reminders.js';

function fakePoller() {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text) { sent.push([chatId, text]); }
  };
}

function setSavedAt(repo, userId, hoursAgo, nowTs) {
  repo.db.prepare('UPDATE jobs SET saved_at = ? WHERE user_id = ?').run(
    new Date(nowTs - hoursAgo * 3600000).toISOString(),
    userId
  );
}

test('reminders: waitingJobsByUser agrupa por usuario y excluye confirmados', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, 'user-a');
  await approvedFlow(machine, 'user-b');
  const a = runner.ingestEmail('user-a', { ...EMAIL_PEDIDO, messageId: '<A1@mail.com>' });
  runner.ingestEmail('user-a', { ...EMAIL_PEDIDO, messageId: '<A2@mail.com>' });
  runner.ingestEmail('user-b', { ...EMAIL_PEDIDO, messageId: '<B1@mail.com>' });
  runner.confirmJob('user-a', a.idempotencyKey, 'confirmado, la orden está en la base');

  const rows = repo.waitingJobsByUser();
  assert.deepEqual(rows.map((r) => r.user_id), ['user-a', 'user-b']);
  assert.equal(rows.find((r) => r.user_id === 'user-a').count, 1, 'el confirmado no entra');
  assert.equal(rows.find((r) => r.user_id === 'user-b').count, 1);
  assert.ok(rows.every((r) => r.oldest && !Number.isNaN(Date.parse(r.oldest))));
  repo.db.close();
});

test('reminders: avisa solo por jobs lo bastante viejos, con anti-spam por usuario', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, 'user-old');
  await approvedFlow(machine, 'user-new');
  runner.ingestEmail('user-old', { ...EMAIL_PEDIDO, messageId: '<OLD@mail.com>' });
  runner.ingestEmail('user-old', { ...EMAIL_PEDIDO, messageId: '<OLD2@mail.com>' });
  runner.ingestEmail('user-new', { ...EMAIL_PEDIDO, messageId: '<NEW@mail.com>' });

  const base = Date.parse('2026-01-01T12:00:00Z');
  setSavedAt(repo, 'user-old', 10, base);
  let fakeNow = base;
  const poller = fakePoller();
  const loop = new ReminderLoop({
    repo,
    poller,
    everyMs: 3600000,
    afterHours: 6,
    now: () => new Date(fakeNow).toISOString()
  });

  let sent = await loop.runOnce();
  assert.deepEqual(sent, ['user-old'], 'user-new (job fresco) no recibe aviso');
  assert.equal(poller.sent.length, 1);
  const [chatId, text] = poller.sent[0];
  assert.equal(chatId, 'user-old');
  assert.match(text, /2 job\(s\) en waiting/);
  assert.match(text, /10h/);
  assert.match(text, /\/confirm/);
  assert.match(text, /"enviado" no cuenta como done/);
  assert.ok(repo.cursor('reminder:user-old'), 'el aviso queda marcado en cursors');

  sent = await loop.runOnce();
  assert.deepEqual(sent, [], 'sin paso del intervalo, no reavisa (anti-spam)');

  fakeNow = base + 3599999;
  sent = await loop.runOnce();
  assert.deepEqual(sent, [], 'a un ms del intervalo tampoco');

  fakeNow = base + 3600000;
  sent = await loop.runOnce();
  assert.deepEqual(sent, ['user-old'], 'pasado el intervalo vuelve a avisar');
  assert.equal(poller.sent.length, 2);
  repo.db.close();
});

test('reminders: confirmar corta los avisos y everyMs=0 desactiva todo', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, 'user-gone');
  runner.ingestEmail('user-gone', { ...EMAIL_PEDIDO, messageId: '<G1@mail.com>' });
  const base = Date.parse('2026-01-01T12:00:00Z');
  setSavedAt(repo, 'user-gone', 20, base);
  let fakeNow = base;
  const poller = fakePoller();
  const loop = new ReminderLoop({
    repo, poller, everyMs: 1000, afterHours: 6, now: () => new Date(fakeNow).toISOString()
  });
  await loop.runOnce();
  assert.equal(poller.sent.length, 1);

  const jobs = runner.list('user-gone');
  runner.confirmJob('user-gone', jobs[0].idempotency_key, 'confirmado, la orden está en la base');
  fakeNow = base + 7200000;
  assert.deepEqual(await loop.runOnce(), [], 'sin waiting no hay avisos');

  const log = [];
  const off = new ReminderLoop({
    repo, poller: { sendMessage: async (c, t) => log.push([c, t]) }, everyMs: 0, afterHours: 6, now: () => new Date(fakeNow).toISOString()
  });
  assert.equal(off.enabled, false);
  assert.deepEqual(await off.runOnce(), []);
  off.start();
  assert.equal(off.running, false, 'start() deshabilitado no arma timer');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(log.length, 0);
  repo.db.close();
});

test('reminders: el timer real corre runOnce y un fallo de envío no crashea el proceso', async () => {
  const repo = openDb(':memory:');
  const machine = new StateMachine(repo, StubFormatter(), new Runner(repo));
  const runner = new Runner(repo);
  await approvedFlow(machine, 'user-timer');
  runner.ingestEmail('user-timer', { ...EMAIL_PEDIDO, messageId: '<T1@mail.com>' });
  const base = Date.parse('2026-01-01T12:00:00Z');
  setSavedAt(repo, 'user-timer', 8, base);
  let fakeNow = base;

  let failing = true;
  const poller = { async sendMessage() { if (failing) throw new Error('telegram caído'); } };
  const errors = [];
  const loop = new ReminderLoop({
    repo, poller, everyMs: 50, afterHours: 6, now: () => new Date(fakeNow).toISOString(),
    logger: { log: () => {}, error: (m) => errors.push(m) }
  });
  loop.start();
  assert.equal(loop.running, true);
  await new Promise((r) => setTimeout(r, 120));
  loop.stop();
  assert.equal(loop.running, false);
  assert.ok(errors.length >= 1, 'el fallo de sendMessage queda logueado, no mata el proceso');

  fakeNow = base + 3600000;
  failing = false;
  const sent = [];
  poller.sendMessage = async (c, txt) => sent.push([c, txt]);
  loop.start();
  await new Promise((r) => setTimeout(r, 120));
  loop.stop();
  assert.equal(sent.length, 1, 'recuperado: el siguiente tick avisa');
  repo.db.close();
});
