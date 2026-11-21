import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { config, isAllowedTelegramId } from '../src/config.js';
import { TelegramPoller } from '../src/telegram.js';

const POLLER_CFG = { TELEGRAM_TOKEN: 'test-token', POLL_SECONDS: 0 };
const fetchOk = (data) => ({ ok: true, status: 200, json: async () => data });
const ACCESS_DENIED = 'Acceso restringido. Este bot no puede atenderte.';

test('config: carga sin excepción y resuelve las rutas con fileURLToPath', async () => {
  const mod = await import('../src/config.js');
  assert.equal(typeof mod.config.DB_PATH, 'string');
  assert.ok(mod.config.DB_PATH.length > 0);
  assert.equal(typeof mod.config.ALLOWED_TELEGRAM_IDS, 'string');
  assert.equal(typeof mod.config.TELEGRAM_TOKEN, 'string');
  assert.ok(mod.isAllowedTelegramId('999', ''), 'sin allowlist no filtra');
});

test('allowlist: definida y no vacía, el usuario de fuera no llega a la máquina', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url: String(url), body: opts?.body ?? null });
    return fetchOk({ ok: true, result: {} });
  });

  const machineCalls = [];
  const machine = {
    handle: async (...args) => {
      machineCalls.push(args);
      return { reply: 'ok de la máquina' };
    }
  };
  const poller = new TelegramPoller(POLLER_CFG, console);

  async function onUpdate(update) {
    const message = update.message;
    if (!message) return;
    const userId = String(message.from?.id ?? 'unknown');
    const chatId = String(message.chat?.id ?? userId);
    if (!isAllowedTelegramId(userId, '111, 222')) {
      await poller.sendMessage(chatId, ACCESS_DENIED);
      return;
    }
    const { reply } = await machine.handle(userId, message.text);
    await poller.sendMessage(chatId, reply);
  }

  await onUpdate({ message: { from: { id: 999 }, chat: { id: 999 }, text: 'hola' } });
  await onUpdate({ message: { from: { id: 111 }, chat: { id: 111 }, text: 'hola de nuevo' } });

  assert.deepEqual(machineCalls, [['111', 'hola de nuevo']], 'el usuario 999 jamás tocó la máquina');
  const denied = calls.filter((c) => JSON.parse(c.body).text === ACCESS_DENIED);
  assert.equal(denied.length, 1, 'un único mensaje genérico, sin filtrar detalles');
  const allowedReplies = calls.filter((c) => JSON.parse(c.body).text === 'ok de la máquina');
  assert.equal(allowedReplies.length, 1);
  assert.ok(allowedReplies[0].url.includes('/bottest-token/sendMessage'));
});

test('allowlist: sin definir o vacía, entra todo (compatibilidad con v1)', () => {
  assert.equal(isAllowedTelegramId('999', ''), true);
  assert.equal(isAllowedTelegramId('999', undefined), true);
  assert.equal(isAllowedTelegramId('999', null), true);
  assert.equal(isAllowedTelegramId('999', '  '), true);
  assert.equal(isAllowedTelegramId(' 111 ', '111,222'), true, 'tolera espacios alrededor');
  assert.equal(isAllowedTelegramId(String(111), '111,222'), true);
});

test('cursors: Repo guarda y lee el offset; el poller lo restaura al construirse', () => {
  const repo = openDb(':memory:');
  assert.equal(repo.cursor('telegram_offset'), null);
  repo.saveCursor('telegram_offset', '49');
  assert.equal(repo.cursor('telegram_offset'), '49');
  repo.saveCursor('telegram_offset', '50');
  assert.equal(repo.cursor('telegram_offset'), '50', 'upsert sobre la misma clave');

  const poller = new TelegramPoller(POLLER_CFG, console, {
    loadOffset: () => repo.cursor('telegram_offset')
  });
  assert.equal(poller.offset, 50, 'el poller arranca con el offset persistido');
  repo.db.close();
});

test('cursors: el offset se guarda tras procesar cada batch', async (t) => {
  let getUpdatesCalls = 0;
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/getUpdates')) {
      getUpdatesCalls++;
      if (getUpdatesCalls === 1) {
        return fetchOk({
          ok: true,
          result: [
            { update_id: 41, message: { text: 'uno' } },
            { update_id: 42, message: { text: 'dos' } }
          ]
        });
      }
      return fetchOk({ ok: true, result: [] });
    }
    return fetchOk({ ok: true, result: {} });
  });

  const repo = openDb(':memory:');
  const saved = [];
  const poller = new TelegramPoller(POLLER_CFG, console, {
    saveOffset: (value) => {
      saved.push(value);
      repo.saveCursor('telegram_offset', value);
    }
  });
  const seen = [];
  await poller.start(async (u) => {
    seen.push(u.update_id);
    if (u.update_id === 42) poller.stop();
  });

  assert.deepEqual(seen, [41, 42]);
  assert.equal(fetchMock.mock.calls[0].arguments[0].includes('offset=0'), true);
  assert.equal(poller.offset, 43);
  assert.equal(saved[saved.length - 1], '43', 'un saveOffset por batch');
  assert.equal(repo.cursor('telegram_offset'), '43');
  repo.db.close();
});

test('telegram: sendMessage respeta 429 (retry_after) y reintenta UNA vez', async (t) => {
  const bodies = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url, opts) => {
    bodies.push(opts?.body ?? null);
    if (bodies.length === 1) {
      return {
        ok: false,
        status: 429,
        json: async () => ({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 1',
          parameters: { retry_after: 1 }
        })
      };
    }
    return fetchOk({ ok: true, result: { message_id: 7 } });
  });

  const poller = new TelegramPoller(POLLER_CFG, console);
  await poller.sendMessage('7', '*hola* mundo');

  assert.equal(fetchMock.mock.callCount(), 2, '429 → un único reintento, sin fallback');
  assert.equal(JSON.parse(bodies[0]).parse_mode, 'Markdown');
  assert.equal(bodies[0], bodies[1], 'el reintento reusa el mismo payload');
  const signal = fetchMock.mock.calls[0].arguments[1]?.signal;
  assert.ok(signal instanceof AbortSignal, 'los fetch llevan AbortSignal.timeout');
});

test('telegram: el fallo final de sendMessage se loguea y conserva el fallback sin Markdown', async (t) => {
  const errors = [];
  const logger = { log: () => {}, warn: () => {}, error: (msg) => errors.push(msg) };
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    bodies.push(opts?.body ?? null);
    return {
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error_code: 400, description: 'chat no encontrado' })
    };
  });

  const poller = new TelegramPoller(POLLER_CFG, logger);
  await poller.sendMessage('7', '**negrita** con `código`');

  assert.equal(bodies.length, 2, 'intento con Markdown + fallback sin Markdown');
  assert.equal(JSON.parse(bodies[1]).parse_mode, undefined);
  assert.equal(JSON.parse(bodies[1]).text, 'negrita con código');
  assert.equal(errors.length, 1, 'el fallo final queda logueado');
  assert.ok(errors[0].includes('chat no encontrado'));
});

test('telegram: offset nulo o inválido arranca en 0', () => {
  const repo = openDb(':memory:');
  const poller = new TelegramPoller(POLLER_CFG, console, {
    loadOffset: () => repo.cursor('no_existe')
  });
  assert.equal(poller.offset, 0);
  repo.db.close();
});
