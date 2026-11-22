import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedFlow, setup, StubFormatter } from './helpers.js';
import { StateMachine } from '../src/machine.js';
import { TaskLoop } from '../src/task-loop.js';
import { TelegramPoller } from '../src/telegram.js';

test('health: /health con proveedor responde el reporte; sin proveedor avisa y sigue', async (t) => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, '42');

  const sinHealth = await machine.handle('42', '/health');
  assert.match(sinHealth.reply, /no está disponible/, 'máquina sin proveedor de salud');

  let called = 0;
  const health = () => {
    called++;
    return `Salud de routine-bot: jobs=${repo.jobsFor('42').length}, uptime OK`;
  };
  const machine2 = new StateMachine(repo, StubFormatter(), runner, null, health);
  const r = await machine2.handle('42', '/health');
  assert.equal(called, 1);
  assert.match(r.reply, /Salud de routine-bot/);
  assert.equal(r.phase, 'done', 'la conversación no se toca');

  const sigue = await machine2.handle('42', '/status');
  assert.ok(sigue.reply.includes('```json'), 'la máquina sigue funcionando normalmente');
  repo.db.close();
});

test('health: TaskLoop registra lastRunAt/lastError de cada tick', async (t) => {
  const mal = new TaskLoop({ tickMs: 10 });
  mal.runOnce = async () => {
    throw new Error('boom');
  };
  mal.start();
  await new Promise((r) => setTimeout(r, 60));
  mal.stop();
  assert.equal(mal.lastError, 'boom');
  assert.ok(mal.lastRunAt, 'el tick fallido igual queda registrado');

  const bien = new TaskLoop({ tickMs: 10 });
  bien.runOnce = async () => ['ok'];
  bien.start();
  await new Promise((r) => setTimeout(r, 60));
  bien.stop();
  assert.equal(bien.lastError, null);
  assert.ok(bien.lastRunAt);

  const parado = new TaskLoop({ tickMs: 10 });
  parado.stop();
  assert.equal(parado.lastRunAt, null, 'si nunca corrió, no hay tick');
});

test('health: el poller expone lastPollAt y lastPollError', async (t) => {
  const poller = new TelegramPoller({ TELEGRAM_TOKEN: 'T', POLL_SECONDS: 1 }, console, { retryMs: 10 });
  assert.equal(poller.lastPollAt, null);
  assert.equal(poller.lastPollError, null);

  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('red caída');
  });
  poller.running = true;
  const updates = poller.updates();
  await Promise.race([updates.next(), new Promise((r) => setTimeout(r, 500))]);
  assert.match(poller.lastPollError || '', /red caída/);
  assert.ok(poller.lastPollAt, 'el intento fallido igual dejó marca de tiempo');
  poller.stop();
});
