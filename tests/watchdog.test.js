import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createPollWatchdog } from '../src/watchdog.js';
import { TelegramPoller } from '../src/telegram.js';

function fakePoller() {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, text) { sent.push([chatId, text]); }
  };
}

test('watchdog: avisa al admin tras 3 fallos consecutivos', async () => {
  const repo = openDb(':memory:');
  const poller = fakePoller();
  const alert = createPollWatchdog(repo, poller, '777');

  await alert(new Error('ETIMEDOUT'), 1);
  await alert(new Error('ETIMEDOUT'), 2);
  assert.equal(poller.sent.length, 0, 'antes de 3 fallos no avisa');

  await alert(new Error('ETIMEDOUT'), 3);
  assert.equal(poller.sent.length, 1);
  assert.equal(poller.sent[0][0], '777');
  assert.match(poller.sent[0][1], /getUpdates/);
  assert.match(poller.sent[0][1], /ETIMEDOUT/);
  assert.ok(repo.cursor('poll_alert'), 'queda registrado el aviso');

  await alert(new Error('ETIMEDOUT'), 4);
  assert.equal(poller.sent.length, 1, 'mismo outage: no spamea (ventana de 6h)');
  repo.db.close();
});

test('watchdog: ventana de cooldown, admin vacío o fallo de envío no rompen nada', async () => {
  const repo = openDb(':memory:');
  const poller = fakePoller();
  const alert = createPollWatchdog(repo, poller, '777');

  repo.saveCursor('poll_alert', new Date(Date.now() - 7 * 3600000).toISOString());
  await alert(new Error('boom'), 5);
  assert.equal(poller.sent.length, 1, 'pasadas las 6h vuelve a avisar');

  const silent = createPollWatchdog(repo, fakePoller(), '');
  await silent(new Error('x'), 10);
  assert.equal(poller.sent.length, 1, 'sin admin configurado no envía');

  const failing = {
    async sendMessage() { throw new Error('telegram abajo'); }
  };
  repo.saveCursor('poll_alert', new Date(Date.now() - 7 * 3600000).toISOString());
  const broken = createPollWatchdog(repo, failing, '777', { log: () => {}, error: () => {} });
  await broken(new Error('x'), 3);
  assert.ok(repo.cursor('poll_alert'), 'el intento de alerta igual se registra');
  repo.db.close();
});

test('watchdog: cableado del poller — failures suben, avisan y un éxito resetea', async (t) => {
  let failCount = 0;
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/getUpdates')) {
      if (failCount < 2) { failCount++; throw new Error('red rota'); }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  });

  const repo = openDb(':memory:');
  const poller = new TelegramPoller({ TELEGRAM_TOKEN: 'test-token', POLL_SECONDS: 0 }, console, {
    retryMs: 15,
    onPollFailure: (err, consecutive) => { seen.push(consecutive); }
  });
  const done = poller.start(async () => {});
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(seen, [1, 2], 'hook con el conteo de fallos consecutivos');
  assert.equal(poller.failures, 0, 'el éxitene resetea el contador');
  poller.stop();
  await Promise.race([done, new Promise((r) => setTimeout(r, 50))]);
  repo.db.close();
});
