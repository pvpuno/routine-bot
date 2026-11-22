import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { config } from '../src/config.js';
import { PUBSUB_BASE, GmailPushLoop, decodeNotification } from '../src/gmail-push.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function notification(emailAddress) {
  return Buffer.from(JSON.stringify({ emailAddress, historyId: '91' })).toString('base64');
}

function fakeGmail(name, address) {
  const state = { polled: 0, watched: 0, stopped: 0 };
  return {
    name,
    state,
    account: { credentials: { clientId: `CLI-${name}`, clientSecret: 'SEC', refreshToken: 'RT' } },
    async poll() { state.polled++; return { saved: 1, duplicates: 0, errors: 0 }; },
    async emailAddress() { return address; },
    async startWatch() { state.watched++; return { historyId: '10', expiration: '4102444800000' }; },
    async stopWatch() { state.stopped++; return true; }
  };
}

function mockPush(t, { pullStatus = 200, pullBody = {} } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    if (String(url) === TOKEN_URL) return new Response(JSON.stringify({ access_token: 'TOK', expires_in: 3600 }), { status: 200 });
    if (String(url).endsWith(':pull')) return new Response(JSON.stringify(pullBody), { status: pullStatus });
    if (String(url).endsWith(':acknowledge')) return new Response('{}', { status: 200 });
    throw new Error(`URL inesperada: ${url}`);
  });
  return calls;
}

test('gmail push: decodeNotification parsea la data base64 (y tolera basura)', () => {
  assert.deepEqual(decodeNotification(notification('a@x.com')), { emailAddress: 'a@x.com', historyId: '91' });
  assert.equal(decodeNotification(null), null);
  assert.equal(decodeNotification(Buffer.from('no-json').toString('base64')), null);
});

test('gmail push: pull recibe la notificación, poll de la casilla y ack', async (t) => {
  const { repo } = setup();
  const g1 = fakeGmail('pedidos', 'pedidos@tienda.com');
  const calls = mockPush(t, {
    pullBody: { receivedMessages: [{ ackId: 'k1', message: { data: notification('pedidos@tienda.com') } }] }
  });
  const loop = new GmailPushLoop({ repo, ingesters: [g1], subscription: 'projects/p/subscriptions/s1', tickMs: 3600000 });
  assert.ok(loop.enabled);

  assert.deepEqual(await loop.runOnce(), ['pedidos']);
  assert.equal(g1.state.polled, 1);
  assert.ok(calls.includes(`${PUBSUB_BASE}/v1/projects/p/subscriptions/s1:pull`));
  assert.equal(calls.filter((u) => u.endsWith(':acknowledge')).length, 1, 'el mensaje se ack\'ea una vez');

  const tokenCall = calls.find((u) => u === TOKEN_URL);
  assert.ok(tokenCall, 'un refresh de token sirvió para pull y ack');
  repo.db.close();
});

test("gmail push: con varias casillas matchea por emailAddress; desconocidas se ackean sin poll", async (t) => {
  const { repo } = setup();
  const g1 = fakeGmail('a', 'a@x.com');
  const g2 = fakeGmail('b', 'b@x.com');
  mockPush(t, {
    pullBody: { receivedMessages: [
      { ackId: 'k1', message: { data: notification('B@X.com') } },
      { ackId: 'k2', message: { data: notification('fantasma@x.com') } }
    ] }
  });
  const loop = new GmailPushLoop({ repo, ingesters: [g1, g2], subscription: 'projects/p/subscriptions/s1', tickMs: 3600000 });

  assert.deepEqual(await loop.runOnce(), ['b'], 'solo la casilla dueña del mailbox hace poll');
  assert.equal(g1.state.polled, 0);
  assert.equal(g2.state.polled, 1);
  repo.db.close();
});

test('gmail push: renueva users.watch cuando vence pronto y respeta "off" y expiraciones frescas', async (t) => {
  const { repo } = setup();
  const g1 = fakeGmail('pedidos', 'pedidos@tienda.com');

  config.GMAIL_WATCH_TOPIC = 'projects/p/topics/gmail-push';
  t.after(() => { config.GMAIL_WATCH_TOPIC = ''; });

  mockPush(t, { pullBody: {} });
  const loop = new GmailPushLoop({ repo, ingesters: [g1], subscription: 'projects/p/subscriptions/s1', tickMs: 3600000 });

  assert.equal(g1.state.watched, 0, 'antes del primer tick no hay watch');
  await loop.runOnce();
  assert.equal(g1.state.watched, 1, 'primer tick: watch inicial');
  assert.equal(repo.cursor('gmail_watch:pedidos'), '4102444800000');

  await loop.runOnce();
  assert.equal(g1.state.watched, 1, 'expiración lejana: no renueva');

  repo.saveCursor('gmail_watch:pedidos', String(Date.now() + 3600000));
  await loop.runOnce();
  assert.equal(g1.state.watched, 2, 'expiración en 1h: renueva');

  repo.saveCursor(`gmail_watch:pedidos`, 'off');
  await loop.runOnce();
  assert.equal(g1.state.watched, 2, 'marcada como off: no vuelve solo');
  repo.db.close();
});

test("gmail push: pull 403 (scope pubsub ausente) falla claro y no hace acknowledge", async (t) => {
  const { repo } = setup();
  const g1 = fakeGmail('pedidos', 'pedidos@tienda.com');
  const calls = mockPush(t, { pullStatus: 403 });

  const loop = new GmailPushLoop({ repo, ingesters: [g1], subscription: 'projects/p/subscriptions/s1', tickMs: 3600000 });
  await assert.rejects(() => loop.runOnce(), /HTTP 403/);
  assert.equal(g1.state.polled, 0);
  assert.equal(calls.filter((u) => u.endsWith(':acknowledge')).length, 0, 'sin procesar, sin ack');
  repo.db.close();
});
