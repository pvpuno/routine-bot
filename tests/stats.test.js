import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedFlow, setup, EMAIL_PEDIDO } from './helpers.js';
import { weeklyStats, statsMessage, StatsLoop } from '../src/stats.js';

const DAY = 24 * 3600000;

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

function nudgeTimestamps(repo, jobId, savedH, confirmedH, nowMs) {
  repo.db.prepare('UPDATE jobs SET saved_at = ?, confirmed_at = ? WHERE id = ?').run(
    new Date(nowMs - savedH * 3600000).toISOString(),
    confirmedH == null ? null : new Date(nowMs - confirmedH * 3600000).toISOString(),
    jobId
  );
}

test('stats: weeklyStats cuenta la ventana de 7 días, waiting, failed y el tiempo medio', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, 'user-stats');
  const base = Date.parse('2026-01-20T12:00:00Z');

  const jobs = [];
  for (const id of ['S1', 'S2', 'S3', 'S4', 'VIEJO']) {
    jobs.push(runner.ingestEmail('user-stats', { ...EMAIL_PEDIDO, messageId: `<${id}@mail.com>` }).job.id);
  }

  runner.confirmJob('user-stats', runner.list('user-stats').find((j) => j.id === jobs[0]).idempotency_key, 'confirmado, la orden está en la base');
  nudgeTimestamps(repo, jobs[0], 7 * 24 + 3, 7 * 24 + 1, base);
  nudgeTimestamps(repo, jobs[1], 50, 48, base);
  nudgeTimestamps(repo, jobs[2], 24, 23, base);
  repo.db.prepare("UPDATE jobs SET status = 'confirmed' WHERE id IN (?, ?)").run(jobs[1], jobs[2]);
  runner.failJob('user-stats', runner.list('user-stats').find((j) => j.id === jobs[3]).idempotency_key, 'prueba');
  nudgeTimestamps(repo, jobs[4], 10 * 24, null, base);

  const s = weeklyStats(repo, 'user-stats', base);
  assert.equal(s.created, 3, 'solo dentro de la ventana de 7 días');
  assert.equal(s.confirmed, 2);
  assert.ok(Math.abs(s.avgConfirmH - 1.5) < 0.01, `avg 1.5h (got ${s.avgConfirmH})`);
  assert.equal(s.failed, 1);
  assert.equal(s.waiting, 1, 'el viejo sigue waiting');

  repo.db.close();
});

test('stats: statsMessage arma el texto y calma cuando no hay nada', () => {
  const busy = statsMessage({ created: 5, confirmed: 4, avgConfirmH: 3.25, waiting: 1, failed: 0 });
  assert.match(busy, /jobs guardados: 5/);
  assert.match(busy, /confirmados por vos: 4/);
  assert.match(busy, /tiempo medio hasta confirmar: 3h 15m/);
  assert.match(busy, /waiting ahora: 1/);
  assert.match(busy, /\/confirm/);
  assert.match(busy, /"enviado" no cuenta como done/);
  assert.doesNotMatch(busy, /semana tranquila/);

  const empty = statsMessage({ created: 0, confirmed: 0, avgConfirmH: null, waiting: 0, failed: 0 });
  assert.match(empty, /semana tranquila/);
  assert.doesNotMatch(empty, /\/confirm/);

  const mid = statsMessage({ created: 2, confirmed: 0, avgConfirmH: null, waiting: 0, failed: 1 });
  assert.doesNotMatch(mid, /tiempo medio/, 'sin confirmados no promedia');
  assert.match(mid, /failed: 1/);
});

test('stats: /stats en el chat responde con el resumen', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, 'user-chat');
  runner.ingestEmail('user-chat', { ...EMAIL_PEDIDO });

  const out = await machine.handle('user-chat', '/stats');
  assert.match(out.reply, /Resumen semanal/);
  assert.match(out.reply, /jobs guardados: 1/);
  assert.match(out.reply, /waiting ahora: 1/);

  const empty = await machine.handle('user-fresh', '/stats');
  assert.match(empty.reply, /semana tranquila/);
  repo.db.close();
});

test('stats: el resumen semanal dispara al día/hora configurado, una vez, solo para usuarios con jobs', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, 'user-monday');
  await approvedFlow(machine, 'user-idle-conv');
  runner.ingestEmail('user-monday', { ...EMAIL_PEDIDO, messageId: '<M1@mail.com>' });

  const poller = fakePoller();
  const loop = new StatsLoop({ repo, poller, tickMs: 60000, day: 1, hhmm: '09:00', now: fakeNow(2026, 2, 2, 9, 0) });
  assert.equal(loop.enabled, true);

  let fired = await loop.runOnce();
  assert.deepEqual(fired, ['user-monday'], 'solo el usuario con jobs (idle no tiene ninguno)');
  assert.equal(poller.sent.length, 1);
  assert.equal(poller.sent[0][0], 'user-monday');
  assert.match(poller.sent[0][1], /Resumen semanal/);

  fired = await loop.runOnce();
  assert.deepEqual(fired, [], 'mismo día/hora: no re-dispara');

  const nextWeek = new StatsLoop({ repo, poller, tickMs: 60000, day: 1, hhmm: '09:00', now: fakeNow(2026, 2, 9, 9, 0) });
  fired = await nextWeek.runOnce();
  assert.deepEqual(fired, ['user-monday'], 'lunes siguiente vuelve a avisar');
  assert.equal(poller.sent.length, 2);

  const wrongDay = new StatsLoop({ repo, poller, tickMs: 60000, day: 1, hhmm: '09:00', now: fakeNow(2026, 2, 10, 9, 0) });
  assert.deepEqual(await wrongDay.runOnce(), [], 'martes no dispara');
  repo.db.close();
});

test('stats: disable vía config y fallo de envío se loguea sin crashear', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, 'user-off');
  runner.ingestEmail('user-off', { ...EMAIL_PEDIDO });

  const off = new StatsLoop({ repo, poller: fakePoller(), day: 1, hhmm: '', now: fakeNow(2026, 2, 2, 9, 0) });
  assert.equal(off.enabled, false);
  assert.deepEqual(await off.runOnce(), []);
  off.start();
  assert.equal(off.running, false, 'start deshabilitado no arma timer');

  const errors = [];
  let failing = true;
  const poller = { async sendMessage() { if (failing) throw new Error('telegram caído'); } };
  const loop = new StatsLoop({ repo, poller, day: 1, hhmm: '09:00', tickMs: 40, now: fakeNow(2026, 2, 2, 9, 0), logger: { log: () => {}, error: (m) => errors.push(m) } });
  loop.start();
  await new Promise((r) => setTimeout(r, 120));
  loop.stop();
  assert.ok(errors.length >= 1, 'fallo logueado');

  failing = false;
  const sent = [];
  poller.sendMessage = async (c, txt) => sent.push([c, txt]);
  repo.saveCursor('stats:user-off', '2020-01-01T00:00:00.000Z');
  loop.start();
  await new Promise((r) => setTimeout(r, 120));
  loop.stop();
  assert.equal(sent.length, 1, 'recuperado en el próximo tick');
  repo.db.close();
});
