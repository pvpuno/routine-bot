import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskLoop } from '../src/task-loop.js';

class FakeLoop extends TaskLoop {
  runs = 0;

  constructor(opts = {}) {
    super(opts);
    this.enabled = opts.enabled ?? true;
    if (opts.syncError) {
      this.runOnce = () => { throw new Error('sync boom'); };
    } else if (opts.asyncError) {
      this.runOnce = async () => { throw new Error('async boom'); };
    }
  }

  get loopName() {
    return 'fake';
  }

  async runOnce() {
    this.runs++;
    return ['ok'];
  }
}

test('task-loop: corre runOnce periódicamente y stop lo corta', async () => {
  const loop = new FakeLoop({ tickMs: 20 });
  loop.start();
  assert.equal(loop.running, true);
  await new Promise((r) => setTimeout(r, 70));
  loop.stop();
  assert.equal(loop.running, false);
  assert.ok(loop.runs >= 2, `corrió varias veces (${loop.runs})`);
  const afterStop = loop.runs;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(loop.runs, afterStop, 'stop corta los ticks');
});

test('task-loop: start respeta enabled y no duplica timers', async () => {
  const loop = new FakeLoop({ tickMs: 20, enabled: false });
  loop.start();
  assert.equal(loop.running, false, 'disabled no arranca');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(loop.runs, 0);

  const live = new FakeLoop({ tickMs: 20 });
  live.start();
  live.start();
  live.stop();
  assert.equal(live.running, false, 'doble start no rompe el stop');
});

test('task-loop: errores sync y async del runOnce quedan logueados y el loop vive', async () => {
  const errors = [];
  const logger = { log: () => {}, error: (m) => errors.push(m) };

  const syncLoop = new FakeLoop({ tickMs: 20, syncError: true, logger });
  syncLoop.start();
  await new Promise((r) => setTimeout(r, 60));
  syncLoop.stop();
  assert.ok(errors.some((m) => m.includes('fake falló: sync boom')), 'error síncrono logueado');
  assert.equal(syncLoop.running, false);

  const asyncLoop = new FakeLoop({ tickMs: 20, asyncError: true, logger });
  asyncLoop.start();
  await new Promise((r) => setTimeout(r, 60));
  asyncLoop.stop();
  assert.ok(errors.some((m) => m.includes('fake falló: async boom')), 'error async logueado vía .catch');
  assert.ok(errors.every((m) => m.startsWith('fake falló')), 'usa loopName');
});

test('task-loop: runOnce heredado por defecto no explota', async () => {
  const base = new TaskLoop({ tickMs: 20 });
  assert.deepEqual(await base.runOnce(), []);
  base.start();
  base.stop();
  assert.equal(base.running, false);
});
