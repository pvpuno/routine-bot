import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, approvedFlow } from './helpers.js';
import { extractGmailText, GmailIngest, gmailHeader, oauthConsentUrl, parseGmailAccounts } from '../src/gmail.js';
import { OAUTH_TOKEN_URL } from '../src/gmail.js';

test('gmail: parseGmailAccounts valida y normaliza cuentas', () => {
  const accounts = parseGmailAccounts(JSON.stringify([
    { clientId: 'a', clientSecret: 'b', refreshToken: 'c', telegramId: 42 },
    { name: 'otra', credentials: { clientId: 'a2', clientSecret: 'b2', refreshToken: 'c2' }, telegramId: '7', maxResultsPerPoll: 3 }
  ]));
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].name, 'gmail-1');
  assert.deepEqual(accounts[0].credentials, { clientId: 'a', clientSecret: 'b', refreshToken: 'c' });
  assert.equal(accounts[0].telegramId, '42');
  assert.equal(accounts[1].name, 'otra');
  assert.equal(accounts[1].maxResultsPerPoll, 3);

  assert.deepEqual(parseGmailAccounts(''), [], 'vacío = sin cuentas');
  assert.throws(() => parseGmailAccounts('{nojson'), /no es JSON válido/);
  assert.throws(
    () => parseGmailAccounts('[{"clientId":"a","clientSecret":"b","refreshToken":"c"}]'),
    /incompleta.*telegramId/
  );
  assert.throws(
    () => parseGmailAccounts('[{"clientId":"a","clientSecret":"b","telegramId":1}]'),
    /incompleta.*refreshToken/
  );
});

test('gmail: extractGmailText prefiere text/plain y cae a text/html; gmailHeader lee headers', () => {
  const payload = {
    headers: [{ name: 'From', value: 'Pedidos <pedidos@tienda.com>' }, { name: 'Subject', value: 'Confirmación' }],
    mimeType: 'multipart/alternative',
    parts: [
      { mimeType: 'text/html', body: { data: Buffer.from('<p>hola <b>mundo</b></p>').toString('base64url') } },
      { mimeType: 'text/plain', body: { data: Buffer.from('Pedido ORD-1 listo').toString('base64url') } }
    ]
  };
  assert.equal(gmailHeader(payload, 'FROM'), 'Pedidos <pedidos@tienda.com>');
  assert.equal(gmailHeader(payload, 'Subject'), 'Confirmación');
  assert.equal(gmailHeader(payload, 'In-Reply-To'), '');
  assert.equal(extractGmailText(payload), 'Pedido ORD-1 listo');

  const soloHtml = {
    mimeType: 'multipart/alternative',
    parts: [{ mimeType: 'text/html', body: { data: Buffer.from('<p>Pedido <b>ORD-2</b></p>').toString('base64url') } }]
  };
  assert.equal(extractGmailText(soloHtml), 'Pedido ORD-2');

  assert.equal(extractGmailText(null), null);
  assert.equal(extractGmailText({ mimeType: 'text/plain' }), null);
  assert.match(oauthConsentUrl({ clientId: 'ABC' }), /^https:\/\/accounts\.google\.com\/.*client_id=ABC.*access_type=offline/);
});

function gmailMessage({ id, from, msgId, subject, body, mimeType = 'text/plain' }) {
  const msg = {
    id,
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'Message-ID', value: msgId },
        { name: 'Subject', value: subject }
      ],
      mimeType,
      body: {},
      parts: []
    }
  };
  if (mimeType === 'text/plain') msg.payload.body = { data: Buffer.from(body).toString('base64url') };
  return msg;
}

function mockGmailFetch(t, { messageIds = ['a', 'b'], tokenCount } = {}) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    const u = String(url);
    calls.push(u);
    const json = (obj) => new Response(JSON.stringify(obj), { status: 200 });
    if (u === OAUTH_TOKEN_URL) {
      const body = new URLSearchParams(String(opts.body || ''));
      assert.equal(body.get('grant_type'), 'refresh_token');
      return json({ access_token: 'TOK', expires_in: 3600 });
    }
    if (u.includes('/messages?')) return json({ messages: messageIds.map((id) => ({ id })) });
    if (u.endsWith('/messages/a?format=full')) {
      return json(gmailMessage({ id: 'a', from: 'Pedidos <pedidos@tienda.com>', msgId: '<G1@x.com>', subject: 'Confirmación de pedido', body: 'Pedido ORD-2026-1, 2 items.' }));
    }
    if (u.endsWith('/messages/b?format=full')) {
      return json(gmailMessage({ id: 'b', from: 'otro@tienda.com', msgId: '<G2@x.com>', subject: 'Otro pedido', body: 'Pedido ORD-2026-2.' }));
    }
    if (u.endsWith('/modify')) return json({});
    throw new Error(`URL inesperada en mock: ${u}`);
  });
  return calls;
}

test('gmail: poll ingiere los no leídos como jobs waiting y los marca como leídos', async (t) => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, '42');
  const poller = { sent: [], async sendMessage(chatId, text) { this.sent.push({ chatId, text }); } };

  const ingester = new GmailIngest({ name: 'pedidos', credentials: { clientId: 'A', clientSecret: 'B', refreshToken: 'C' }, telegramId: '42' });
  ingester.init({ repo, runner, poller });

  const calls = mockGmailFetch(t);
  const out = await ingester.poll();
  assert.deepEqual(out, { saved: 2, duplicates: 0, errors: 0 });

  const jobs = repo.jobsFor('42');
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].status, 'waiting');
  assert.equal(calls.filter((u) => u.endsWith('/modify')).length, 2, 'ambos quedaron como leídos');
  assert.match(poller.sent.at(-1).text, /Guardé 2 job\(s\) nuevo\(s\) en waiting desde Gmail \(pedidos\)/);
  assert.match(poller.sent.at(-1).text, /Nada se confirma solo/);
  repo.db.close();
});

test('gmail: segundo poll con los mismos emails → duplicados; token se cachea', async (t) => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, '42');
  const poller = { sent: [], async sendMessage(chatId, text) { this.sent.push({ chatId, text }); } };

  const ingester = new GmailIngest({ credentials: { clientId: 'A', clientSecret: 'B', refreshToken: 'C' }, telegramId: '42' });
  ingester.init({ repo, runner, poller });

  mockGmailFetch(t);
  assert.deepEqual(await ingester.poll(), { saved: 2, duplicates: 0, errors: 0 });

  await ingester.poll();
  const calls = globalThis.fetch.mock.calls.filter((c) => String(c.arguments[0]) === OAUTH_TOKEN_URL);
  assert.equal(calls.length, 1, 'el access token se reutiliza dentro de su validez');
  const jobs = repo.jobsFor('42');
  assert.equal(jobs.length, 2, 'no se duplican jobs');
  assert.equal(globalThis.fetch.mock.calls.filter((c) => String(c.arguments[0]).endsWith('/modify')).length, 4, 'los duplicados también quedan leídos');
  repo.db.close();
});

test('gmail: sin rutina activa el email NO se marca como leído (queda para el próximo poll)', async (t) => {
  const { repo, runner } = setup();
  const poller = { sent: [], async sendMessage(chatId, text) { this.sent.push({ chatId, text }); } };

  const ingester = new GmailIngest({ credentials: { clientId: 'A', clientSecret: 'B', refreshToken: 'C' }, telegramId: '99' });
  ingester.init({ repo, runner, poller });

  mockGmailFetch(t);
  const out = await ingester.poll();
  assert.deepEqual(out, { saved: 0, duplicates: 0, errors: 2 });
  assert.equal(globalThis.fetch.mock.calls.filter((c) => String(c.arguments[0]).endsWith('/modify')).length, 0, 'un error de ingesta no consume el email');
  assert.equal(poller.sent.length, 0, 'sin guardados no hay notificación');
  assert.equal(globalThis.fetch.mock.calls.filter((c) => String(c.arguments[0]).includes('/messages/a?')).length, 1, 'se leyó el cuerpo igual para auditar');
  repo.db.close();
});
