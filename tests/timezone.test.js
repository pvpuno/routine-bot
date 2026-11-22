import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedFlow, EMAIL_PEDIDO, setup } from './helpers.js';
import { tzDateString, tzParts } from '../src/time.js';
import { ScheduleLoop } from '../src/schedule.js';
import { StatsLoop } from '../src/stats.js';

test('time: tzParts convierte UTC a zona horaria IANA', () => {
  const utc = tzParts(new Date('2026-11-22T02:00:00Z'), '');
  assert.equal(utc.weekday, 0, '22/11/2026 es domingo en UTC');
  assert.equal(utc.hour, 2);
  assert.equal(utc.minute, 0);
  assert.equal(tzDateString(utc), '2026-11-22');

  const ba = tzParts(new Date('2026-11-22T02:00:00Z'), 'America/Argentina/Buenos_Aires');
  assert.equal(ba.weekday, 6, 'en Buenos Aires sigue siendo sábado 21');
  assert.equal(ba.hour, 23);
  assert.equal(tzDateString(ba), '2026-11-21');
});

test('schedule: dispara según la zona horaria configurada, no según el reloj del server', async () => {
  const { repo, poller } = await approvedSetup();

  const routine = repo.activeRoutine('42');
  repo.setRoutineSchedule(routine.id, '23:00');
  const loopBA = new ScheduleLoop({
    repo,
    poller,
    now: () => new Date('2026-11-22T02:00:00Z'),
    timeZone: 'America/Argentina/Buenos_Aires'
  });
  const firedBA = await loopBA.runOnce();
  assert.deepEqual(firedBA, [routine.id]);
  const sentToBa = poller.sent.at(-1);
  assert.equal(sentToBa.chatId, '42');
  assert.match(sentToBa.text, /Aviso diario 23:00/);
  assert.equal(repo.cursor(`schedule:${routine.id}`), '2026-11-21', 'el cursor usa el día de la zona horaria');

  const loopUTC = new ScheduleLoop({
    repo,
    poller,
    now: () => new Date('2026-11-22T02:00:00Z')
  });
  assert.deepEqual(await loopUTC.runOnce(), [], 'en UTC no fue 23:00');
  assert.equal(poller.sent.length, 1, 'no hay doble disparo del mismo día');
});

test('stats: el resumen sale el día y la hora de la zona horaria configurada', async () => {
  const { repo, runner, poller } = await approvedSetup();
  runner.ingestEmail('42', { ...EMAIL_PEDIDO, messageId: '<TZ-STATS-1@x.com>' });

  const loop = new StatsLoop({
    repo,
    poller,
    day: 6,
    hhmm: '23:00',
    now: () => new Date('2026-11-22T02:00:00Z'),
    timeZone: 'America/Argentina/Buenos_Aires'
  });
  const fired = await loop.runOnce();
  assert.deepEqual(fired, ['42'], 'dispara sábado 23:00 Buenos Aires');
  assert.ok(poller.sent.at(-1).text.length > 0);
  assert.ok(repo.cursor('stats:42'));

  const loopUTC = new StatsLoop({
    repo,
    poller,
    day: 6,
    hhmm: '23:00',
    now: () => new Date('2026-11-22T02:00:00Z')
  });
  assert.deepEqual(await loopUTC.runOnce(), [], 'en UTC ese día/hora no corresponden');
});

async function approvedSetup() {
  const { repo, machine, runner } = setup();
  const poller = {
    sent: [],
    async sendMessage(chatId, text) {
      this.sent.push({ chatId, text });
    }
  };
  await approvedFlow(machine, '42');
  return { repo, machine, runner, poller };
}
