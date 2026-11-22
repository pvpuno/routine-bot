import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { IngestLoop } from '../src/connectors.js';
import {
  ImapClient,
  ImapError,
  ImapIngest,
  decodeRfc2047,
  decodeQuotedPrintable,
  decodeBody,
  extractAddress,
  extractTextBody,
  parseHeaders,
  parseMessage,
  parseImapAccounts
} from '../src/imap.js';
import { DuplicateJobError } from '../src/routines/runner.js';
import { approvedFlow, setup } from './helpers.js';

class FakeImapSocket extends Duplex {
  #handlers;

  constructor(handlers) {
    super();
    this.#handlers = handlers;
    this.push('* OK Fake IMAP listo\r\n');
    process.nextTick(() => this.emit('connect'));
  }

  _write(chunk, _enc, cb) {
    for (const line of chunk.toString('utf8').split('\r\n')) {
      if (!line) continue;
      const tag = line.split(' ')[0];
      for (const response of this.#handlers(line, tag) || []) {
        this.push(typeof response === 'string' ? `${response}\r\n` : response);
      }
    }
    cb();
  }

  _read() {}
}

function literalFrame(text) {
  const buf = Buffer.from(text, 'utf8');
  return [
    `* 1 FETCH (BODY[ITEM] {${buf.length}}`,
    buf,
    ')'
  ];
}

function fetchHandlers(messages) {
  return (line, tag) => {
    if (/\bLOGIN\b/.test(line)) return [`${tag} OK login`];
    if (/\bSELECT\b/.test(line)) return ['* 3 EXISTS', '* OK [UIDVALIDITY 1] UIDs valid', `${tag} OK SELECT complete`];
    if (/UID SEARCH UNSEEN/.test(line)) {
      return [`* SEARCH ${messages.map((m) => m.uid).join(' ')}`.trim(), `${tag} OK search done`];
    }
    if (/UID FETCH/.test(line) && /HEADER/.test(line)) {
      const uid = Number(/UID FETCH (\d+)/.exec(line)[1]);
      const msg = messages.find((m) => m.uid === uid);
      return [...literalFrame(msg.headerRaw), `${tag} OK done`];
    }
    if (/UID FETCH/.test(line) && /TEXT/.test(line)) {
      const uid = Number(/UID FETCH (\d+)/.exec(line)[1]);
      const msg = messages.find((m) => m.uid === uid);
      return [...literalFrame(msg.bodyRaw), `${tag} OK done`];
    }
    if (/UID STORE/.test(line)) return [`${tag} OK stored`];
    if (/LOGOUT/.test(line)) return ['* BYE gracias', `${tag} OK logout`];
    return [`${tag} NO comando no simulado`];
  };
}

test('imap: cliente completo contra socket fake — login, select, search, fetch con literal y store', async () => {
  const subject64 = Buffer.from('Confirmación de pedido #77', 'utf8').toString('base64');
  const headerRaw = [
    'From: Tienda Shop <pedidos@tienda.com>',
    `Subject: =?UTF-8?B?${subject64}?=`,
    'Date: Sat, 21 Nov 2026 10:04:00 +0000',
    'Message-ID: <CAFEBABE-77@mail.tienda.com>',
    'Content-Type: multipart/mixed; boundary="BOUND42"',
    ''
  ].join('\r\n');
  const bodyRaw = [
    '--BOUND42',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Pedido n=C2=BA 77 confirmado con dos items.',
    '--BOUND42--'
  ].join('\r\n');

  const socket = new FakeImapSocket(
    fetchHandlers([{ uid: 5, headerRaw, bodyRaw }, { uid: 9, headerRaw: 'From: otro@x.com\r\n', bodyRaw: '' }])
  );

  const client = new ImapClient({
    host: 'fake.local',
    tls: false,
    createConnection: () => socket
  });

  await client.connect();
  await client.login('user@fake.local', 'app-pass');
  await client.select('INBOX');
  assert.deepEqual(await client.searchUids(), [5, 9]);

  const msg = parseMessage(await client.fetchMessage(5));
  assert.equal(msg.from, 'pedidos@tienda.com');
  assert.equal(msg.messageId, '<CAFEBABE-77@mail.tienda.com>');
  assert.equal(msg.subject, 'Confirmación de pedido #77');
  assert.match(msg.body, /Pedido nº 77 confirmado con dos items\./);

  await client.storeSeen(5);
  await client.logout();
});

test('imap: una respuesta NO del servidor se traduce en ImapError', async () => {
  const socket = new FakeImapSocket((line, tag) => {
    if (/\bLOGIN\b/.test(line)) return [`${tag} NO [AUTHENTICATIONFAILED] credenciales inválidas`];
    return [`${tag} OK x`];
  });
  const client = new ImapClient({ host: 'fake.local', tls: false, createConnection: () => socket });
  await client.connect();
  await assert.rejects(() => client.login('u', 'p'), (err) => {
    assert.ok(err instanceof ImapError);
    assert.match(err.message, /AUTHENTICATIONFAILED/);
    return true;
  });
});

test('imap: parsing de headers y cuerpos (RFC2047, quoted-printable, base64, html)', () => {
  assert.equal(decodeRfc2047('=?ISO-8859-1?Q?Pedido=20=BAnico?='), 'Pedido ºnico');
  assert.equal(decodeRfc2047('=?ISO-8859-1?Q?Pedido=20=FAnico?='), 'Pedido único');
  assert.equal(decodeRfc2047('=?utf-8?Q?Listo_=E2=9C=85?='), 'Listo ✅');
  assert.equal(decodeRfc2047('sin encoding'), 'sin encoding');

  assert.equal(extractAddress('"Juan Pérez" <juan.perez@x.com>'), 'juan.perez@x.com');
  assert.equal(extractAddress('plano@x.com'), 'plano@x.com');
  assert.equal(extractAddress(decodeRfc2047('=?UTF-8?B?8J+agE9UQg==?= <ventas@y.com>')), 'ventas@y.com');

  assert.equal(decodeQuotedPrintable('l=C3=ADnea=\r\ncontinuada n=C3=BAmero 1'), 'líneacontinuada número 1');
  assert.equal(decodeBody('UGVkaWRvIGVxdWlzdHJvIDQ0', 'base64', 'utf-8'), 'Pedido equistro 44');

  const html = '<div>Hola <b>cliente</b>, &amp; gracias.</div>';
  assert.equal(extractTextBody(html, 'text/html; charset="utf-8"'), 'Hola cliente, & gracias.');

  const multipart = [
    '--BB1',
    'Content-Type: text/html; charset="utf-8"',
    '',
    '<p>versión html</p>',
    '--BB1',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('versión texto plano', 'utf8').toString('base64'),
    '--BB1--'
  ].join('\r\n');
  assert.equal(
    extractTextBody(multipart, 'multipart/mixed; boundary="BB1"'),
    'versión texto plano'
  );

  const headers = parseHeaders('From: a@b.c\r\nSubject: asunto\r\n largo\r\n\r\n');
  assert.equal(headers.subject, 'asunto largo');
});

test('imap: parseImapAccounts valida y completa las cuentas', () => {
  assert.deepEqual(parseImapAccounts(''), []);
  assert.deepEqual(parseImapAccounts('   '), []);
  assert.throws(() => parseImapAccounts('no-json'), ImapError);
  assert.throws(
    () => parseImapAccounts('[{"host":"h","user":"u","pass":"p"}]'),
    /telegramId/
  );

  const [acct] = parseImapAccounts(
    '[{"name":"pedidos","host":"imap.gmail.com","user":"a@b.com","pass":"secret","telegramId":42}]'
  );
  assert.equal(acct.port, 993);
  assert.equal(acct.tls, true);
  assert.equal(acct.mailbox, 'INBOX');
  assert.equal(acct.telegramId, '42');
});

test('imap: ImapIngest guarda jobs en waiting contra el runner real y marca como leído', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, '42');
  const poller = {
    sent: [],
    async sendMessage(chatId, text) {
      this.sent.push({ chatId, text });
    }
  };

  const headerRaw = 'From: pedidos@tienda.com\r\nMessage-ID: <IMAP-001@x.com>\r\nSubject: Pedido del día\r\n';
  const bodyRaw = 'Pedido ORD-2024-0099 con dos items.';
  let madeSeen = false;
  const fake = {
    async connect() {},
    async login() {},
    async select() {},
    async searchUids() {
      return [5];
    },
    async fetchMessage() {
      return { uid: 5, headerRaw, bodyRaw };
    },
    async storeSeen() {
      madeSeen = true;
    },
    async logout() {}
  };

  const ingest = new ImapIngest(parseImapAccounts(
    '[{"name":"pedidos","host":"imap.x.com","user":"a@b.com","pass":"secret","telegramId":"42"}]'
  )[0], { createClient: () => fake });
  ingest.init({ repo, runner, poller });
  assert.equal(ingest.name, 'pedidos');

  const out1 = await ingest.poll();
  assert.equal(out1.saved, 1);
  assert.equal(madeSeen, true);
  const jobs = runner.list('42');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'waiting');
  assert.equal(jobs[0].data.from, 'pedidos@tienda.com');
  assert.equal(poller.sent.length, 1);
  assert.match(poller.sent[0].text, /Guardé 1 job/);
  assert.match(poller.sent[0].text, /revisalos VOS con \/confirm/);

  const out2 = await ingest.poll();
  assert.equal(out2.saved, 0);
  assert.equal(out2.duplicates, 1);
  assert.equal(runner.list('42').length, 1);
});

test('imap: sin rutina activa el email NO se marca leído y queda reportado como error', async () => {
  const { repo, runner } = setup();
  const poller = {
    sent: [],
    async sendMessage(chatId, text) {
      this.sent.push({ chatId, text });
    }
  };
  const fake = {
    async connect() {},
    async login() {},
    async select() {},
    async searchUids() {
      return [7];
    },
    async fetchMessage() {
      return {
        uid: 7,
        headerRaw: 'From: pedidos@tienda.com\r\nMessage-ID: <IMAP-002@x.com>\r\n',
        bodyRaw: 'body'
      };
    },
    async storeSeen() {
      throw new Error('no debió marcar como leído');
    },
    async logout() {}
  };

  const ingest = new ImapIngest({
    name: 'pedidos',
    host: 'imap.x.com',
    user: 'a',
    pass: 'p',
    telegramId: '77'
  }, { createClient: () => fake });
  ingest.init({ repo, runner, poller });

  const out = await ingest.poll();
  assert.equal(out.saved, 0);
  assert.equal(out.duplicates, 0);
  assert.equal(out.errors, 1);
  assert.equal(poller.sent.length, 0);
});

test('imap: init sin cuenta o sin ctx lanza errores claros', async () => {
  const ingest = new ImapIngest(null, {});
  assert.throws(() => ingest.init(undefined), /host, user, pass y telegramId/);

  const okIngest = new ImapIngest({ name: 'x', host: 'h', user: 'u', pass: 'p', telegramId: '1' }, {});
  okIngest.init({});
  await assert.rejects(() => okIngest.poll(), /init\(\{ runner, poller \}\)/);
});

test('IngestLoop: corre cada conector, aísla errores y sigue con los demás', async () => {
  const errors = [];
  const ok = {
    name: 'ok',
    async poll() {
      return { saved: 2 };
    }
  };
  const roto = {
    name: 'roto',
    async poll() {
      throw new Error('boom de red');
    }
  };
  const loop = new IngestLoop({ ingesters: [roto, ok], logger: { error: (m) => errors.push(m) } });
  const results = await loop.runOnce();
  assert.deepEqual(results, [{ saved: 2 }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\[roto\] boom de red/);
  assert.match(errors[0], /^ingest falló/);
});

test('imap: el key único (from, messageId) sobrevive el viaje por IMAP sin duplicar', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, '42');
  const poller = { sent: [], async sendMessage() {} };
  const headerRaw = 'From: pedidos@tienda.com\r\nMessage-ID: <DUP-1@x.com>\r\nContent-Type: text/plain\r\n';
  const fake = {
    async connect() {},
    async login() {},
    async select() {},
    async searchUids() {
      return [1];
    },
    async fetchMessage() {
      return { uid: 1, headerRaw, bodyRaw: 'cuerpo' };
    },
    async storeSeen() {},
    async logout() {}
  };
  const ingest = new ImapIngest({ name: 'dup', host: 'h', user: 'u', pass: 'p', telegramId: '42' }, {
    createClient: () => fake
  });
  ingest.init({ repo, runner, poller });

  await ingest.poll();
  await assert.rejects(
    async () => runner.ingestEmail('42', { from: 'pedidos@tienda.com', messageId: '<DUP-1@x.com>' }),
    DuplicateJobError
  );
});
