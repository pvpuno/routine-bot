import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedFlow, setup } from './helpers.js';
import { config } from '../src/config.js';
import { GmailOAuthChat } from '../src/gmail-oauth.js';
import { OAUTH_TOKEN_URL } from '../src/gmail.js';

function mockedExchange(t, { status = 200, body }) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts = {}) => {
    calls.push({ url: String(url), body: String(opts.body || '') });
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
}

function oauthSetup({ repo, runner }) {
  const ingesters = [];
  const poller = { sent: [], async sendMessage(chatId, text) { this.sent.push({ chatId, text }); } };
  const chat = new GmailOAuthChat({
    repo,
    runner,
    poller,
    ingesters,
    logger: { error() {} }
  });
  return { chat, ingesters, poller, repo, runner };
}

test('gmail oauth: flujo completo por chat termina con refresh_token en DB e ingester activo', async (t) => {
  config.ADMIN_TELEGRAM_ID = '42';
  t.after(() => { config.ADMIN_TELEGRAM_ID = ''; });

  const { repo, runner, machine } = setup();
  await approvedFlow(machine, '42');
  const { chat, ingesters } = oauthSetup({ repo, runner });
  const phaseBefore = repo.conversation('42').phase;

  const paso1 = await chat.handle('42', '/gmail');
  assert.match(paso1, /clientId.*clientSecret/s);
  assert.equal(chat.sessions(), 1);

  const paso2 = await chat.handle('42', '{"clientId":"CLI","clientSecret":"SEC","name":"pedidos"}');
  assert.match(paso2, /accounts\.google\.com/);
  assert.match(paso2, /access_type=offline/);
  assert.match(paso2, /localhost:1/);

  const calls = mockedExchange(t, { body: { access_token: 'AT', expires_in: 3600, refresh_token: 'RRR' } });
  const paso3 = await chat.handle('42', 'http://localhost:1/?state=x&code=el-code-123&scope=x');
  assert.match(paso3, /conectada como "pedidos"/);
  assert.match(paso3, /Nada se confirma solo/);
  const exchangeCall = calls.find((c) => c.url === OAUTH_TOKEN_URL);
  const body = new URLSearchParams(exchangeCall.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'el-code-123');

  const [guardada] = repo.oauthAccounts();
  assert.equal(guardada.name, 'pedidos');
  assert.equal(guardada.refresh_token, 'RRR');
  assert.equal(guardada.client_id, 'CLI');
  assert.equal(chat.sessions(), 0, 'la sesión se cerró al éxito');

  assert.equal(ingesters.length, 1);
  assert.equal(ingesters[0].name, 'pedidos');
  assert.equal(ingesters[0].account.credentials.refreshToken, 'RRR');
  assert.equal(ingesters[0].account.telegramId, '42');

  assert.equal(repo.conversation('42').phase, phaseBefore, 'la conversación de rutinas no se tocó');
  repo.db.close();
});

test('gmail oauth: JSON inválido reintenta, canje fallido avisa, "cancelar" libera y no toca la DB', async (t) => {
  config.ADMIN_TELEGRAM_ID = '42';
  t.after(() => { config.ADMIN_TELEGRAM_ID = ''; });

  const { repo, runner, machine } = setup();
  await approvedFlow(machine, '99'); // el admin tiene conversación propia; no es requisito
  const { chat } = oauthSetup({ repo, runner });

  await chat.handle('42', '/gmail');
  const noJson = await chat.handle('42', 'no sé, probemos');
  assert.match(noJson, /no es JSON válido/);
  assert.equal(chat.sessions(), 1, 'sigue esperando credenciales');

  await chat.handle('42', '{"clientId":"CLI","clientSecret":"SEC"}');
  mockedExchange(t, { status: 400, body: { error: 'invalid_grant' } });
  const fallo = await chat.handle('42', 'el-code-malo');
  assert.match(fallo, /El canje falló.*invalid_grant/s);
  assert.equal(chat.sessions(), 1, 'la sesión sigue viva para reintentar');
  assert.equal(repo.oauthAccounts().length, 0, 'nada persistido con un canje fallido');

  const cancel = await chat.handle('42', 'cancelar');
  assert.match(cancel, /Cancelado/);
  assert.equal(chat.sessions(), 0);
  assert.equal(await chat.handle('42', 'hola, esto va para la máquina'), null, 'sin sesión, el texto pasa a la máquina');

  repo.db.close();
});

test('gmail oauth: permisos — sin ADMIN configurado o con otro user, se niega', async () => {
  const { repo, runner } = setup();
  const { chat } = oauthSetup({ repo, runner });

  const sinAdmin = await chat.handle('42', '/gmail');
  assert.match(sinAdmin, /ADMIN_TELEGRAM_ID/);

  config.ADMIN_TELEGRAM_ID = '42';
  const otro = await chat.handle('99', '/gmail');
  assert.match(otro, /solo para el admin/);
  const otroOff = await chat.handle('99', '/gmail off pedidos');
  assert.match(otroOff, /solo para el admin/);
  config.ADMIN_TELEGRAM_ID = '';

  repo.db.close();
});

test('gmail oauth: /gmail off desconecta (DB + ingester en vivo) y /gmail status muestra estado', async (t) => {
  config.ADMIN_TELEGRAM_ID = '42';
  t.after(() => { config.ADMIN_TELEGRAM_ID = ''; });

  const { repo, runner } = setup();
  const { chat, ingesters } = oauthSetup({ repo, runner });
  mockedExchange(t, { body: { access_token: 'AT', refresh_token: 'RRR' } });

  await chat.handle('42', '/gmail');
  await chat.handle('42', '{"clientId":"CLI","clientSecret":"SEC","name":"casilla1"}');
  await chat.handle('42', 'http://localhost:1/?code=c1');
  assert.equal(repo.oauthAccounts().length, 1);

  const estado = await chat.handle('42', '/gmail status');
  assert.match(estado, /casilla1/);
  assert.match(estado, /no hay sesión en curso/i);

  const off = await chat.handle('42', '/gmail off casilla1');
  assert.match(off, /desconectada/);
  assert.equal(repo.oauthAccounts().length, 0);
  assert.equal(ingesters.length, 0, 'el ingester se sacó del loop en vivo');

  const offNada = await chat.handle('42', '/gmail off fantasma');
  assert.match(offNada, /No conozco la casilla/);
  repo.db.close();
});
