import net from 'node:net';
import tls from 'node:tls';
import { IngestConnector } from './connectors.js';

export const DEFAULT_IMAP_PORT = 993;
export const DEFAULT_MAILBOX = 'INBOX';

export class ImapError extends Error {
  constructor(message, code = 'imap_error') {
    super(message);
    this.code = code;
  }
}

function imapQuoted(value) {
  const s = String(value ?? '').replace(/([\\"])/g, '\\$1');
  return `"${s}"`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function decodeCharset(bytes, charset) {
  const cs = String(charset || 'utf-8').toLowerCase();
  if (cs.includes('8859') || cs.includes('latin')) return bytes.toString('latin1');
  return bytes.toString('utf8');
}

export function decodeRfc2047(value = '') {
  const s = String(value ?? '');
  if (!s.includes('=?')) return s;
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, enc, data) => {
    let bytes;
    if (enc.toLowerCase() === 'b') {
      bytes = Buffer.from(data, 'base64');
    } else {
      const unescaped = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      );
      bytes = Buffer.from(unescaped, 'binary');
    }
    return decodeCharset(bytes, charset);
  });
}

export function extractAddress(header = '') {
  const s = String(header ?? '').replace(/\s+/g, ' ').trim();
  const angle = /<([^>]+)>/.exec(s);
  const address = (angle ? angle[1] : s.split(',')[0] || '').trim();
  return address.toLowerCase();
}

export function decodeQuotedPrintable(text, charset = 'utf-8') {
  const cleaned = String(text ?? '').replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
      bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(c.charCodeAt(0) & 0xff);
    }
  }
  return decodeCharset(Buffer.from(bytes), charset);
}

export function decodeBody(text, cte = '', charset = 'utf-8') {
  const enc = String(cte || '').toLowerCase().trim();
  if (enc === 'base64') return decodeCharset(Buffer.from(String(text ?? '').replace(/\s+/g, ''), 'base64'), charset);
  if (enc === 'quoted-printable') return decodeQuotedPrintable(text, charset);
  return String(text ?? '').replace(/=\r?\n/g, '');
}

export function htmlToText(html = '') {
  return String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/(p|div|tr|h[1-6]|li|table|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

export function parseHeaders(raw = '') {
  const headers = {};
  let lastKey = null;
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^\s/.test(line)) {
      if (lastKey) headers[lastKey] += ` ${line.trim()}`;
      continue;
    }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    lastKey = line.slice(0, idx).trim().toLowerCase();
    headers[lastKey] = line.slice(idx + 1).trim();
  }
  return headers;
}

function bodyCharset(contentType = '') {
  const m = /charset="?([^";\s]+)"?/i.exec(String(contentType ?? ''));
  return m ? m[1] : 'utf-8';
}

function partBodyOrEmpty(part) {
  const splitIdx = part.search(/\r?\n\r?\n/);
  const headers = parseHeaders(splitIdx === -1 ? part : part.slice(0, splitIdx));
  const content = splitIdx === -1 ? '' : part.slice(splitIdx).replace(/^\r?\n\r?\n/, '');
  return { headers, content };
}

function multipartText(body, boundary) {
  const parts = body.split(new RegExp(`--${escapeRegExp(boundary)}`));
  let html = null;
  let fallback = null;
  for (const part of parts) {
    const trimmed = part.trimStart().replace(/^\n/, '');
    if (!trimmed || trimmed.startsWith('--')) continue;
    const { headers, content } = partBodyOrEmpty(trimmed);
    const ctype = headers['content-type'] || '';
    if (ctype.toLowerCase().includes('text/plain')) {
      return decodeBody(content, headers['content-transfer-encoding'], bodyCharset(ctype));
    }
    if (ctype.toLowerCase().includes('text/html') && !html) {
      html = { content, headers, ctype };
    } else if (!fallback && content) {
      fallback = { content, headers, ctype };
    }
  }
  if (html) return htmlToText(decodeBody(html.content, html.headers['content-transfer-encoding'], bodyCharset(html.ctype)));
  if (fallback) return decodeBody(fallback.content, fallback.headers['content-transfer-encoding'], bodyCharset(fallback.ctype));
  return '';
}

export function extractTextBody(raw = '', contentType = '', cte = '') {
  const text = String(raw ?? '').replace(/^\r?\n/, '');
  if (/^content-[-a-z]/i.test(text)) {
    const splitIdx = text.search(/\r?\n\r?\n/);
    const partHeaders = parseHeaders(splitIdx === -1 ? text : text.slice(0, splitIdx));
    const partBody = splitIdx === -1 ? '' : text.slice(splitIdx).replace(/^\r?\n\r?\n/, '');
    const ctype = partHeaders['content-type'] || contentType || '';
    if (ctype.toLowerCase().includes('multipart')) {
      const boundary = /boundary="?([^";\r\n]+)"?/i.exec(ctype)?.[1];
      if (boundary) return multipartText(partBody, boundary);
    }
    return decodeBody(partBody, partHeaders['content-transfer-encoding'], bodyCharset(ctype));
  }
  if (String(contentType ?? '').toLowerCase().includes('multipart')) {
    const boundary = /boundary="?([^";\r\n]+)"?/i.exec(String(contentType))?.[1];
    if (boundary) return multipartText(text, boundary);
  }
  const decoded = decodeBody(text, cte, bodyCharset(contentType));
  if (String(contentType ?? '').toLowerCase().includes('text/html')) return htmlToText(decoded);
  return decoded;
}

export function parseMessage({ headerRaw = '', bodyRaw = '' } = {}) {
  const h = parseHeaders(headerRaw);
  return {
    from: extractAddress(decodeRfc2047(h.from || '')),
    messageId: String(h['message-id'] || h.messageid || '').trim(),
    subject: decodeRfc2047(h.subject || ''),
    date: String(h.date || '').trim(),
    body: extractTextBody(bodyRaw, h['content-type'] || '', h['content-transfer-encoding'] || '')
  };
}

function firstLiteral(lines) {
  for (const entry of lines) {
    if (entry && typeof entry === 'object') return entry.literal;
  }
  return null;
}

export class ImapClient {
  #socket = null;
  #pending = null;
  #buf = Buffer.alloc(0);
  #lines = [];
  #litRemaining = 0;
  #litChunks = [];
  #nextTag = 0;
  #greeted = false;
  #greetingWaiters = [];
  #createConnection;

  constructor({ host, port = DEFAULT_IMAP_PORT, tls: useTls = true, logger = console, createConnection } = {}) {
    if (!host) throw new ImapError('ImapClient requiere host');
    this.host = String(host);
    this.port = Number(port) || DEFAULT_IMAP_PORT;
    this.useTls = useTls !== false;
    this.logger = logger;
    this.#createConnection =
      createConnection || ((opts) => (this.useTls ? tls.connect(opts) : net.connect(opts)));
  }

  async connect() {
    const socket = await new Promise((resolve, reject) => {
      const s = this.#createConnection({ host: this.host, port: this.port });
      const onError = (err) => reject(new ImapError(`conexión a ${this.host}:${this.port} falló: ${err.message}`));
      s.once('error', onError);
      s.once(this.useTls ? 'secureConnect' : 'connect', () => {
        s.removeListener('error', onError);
        resolve(s);
      });
    });
    this.#socket = socket;
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', (err) => this.#failPending(new ImapError(`socket ${this.host}: ${err.message}`)));
    socket.on('close', () => this.#failPending(new ImapError(`socket ${this.host}: cerrado`)));
    await this.#greeting();
  }

  async login(user, pass) {
    await this.#command(`LOGIN ${imapQuoted(user)} ${imapQuoted(pass)}`, 'LOGIN');
  }

  async select(mailbox = DEFAULT_MAILBOX) {
    await this.#command(`SELECT ${imapQuoted(mailbox)}`, 'SELECT');
  }

  async searchUids() {
    const lines = await this.#command('UID SEARCH UNSEEN', 'UID SEARCH');
    const uids = [];
    for (const line of lines) {
      const m = /^\* SEARCH\b(.*)$/i.exec(line);
      if (m) for (const token of m[1].trim().split(/\s+/).filter(Boolean)) uids.push(Number(token));
    }
    return uids;
  }

  async fetchMessage(uid, { maxTextBytes = 8192 } = {}) {
    const headerLines = await this.#command(
      `UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID CONTENT-TYPE CONTENT-TRANSFER-ENCODING)])`,
      'FETCH header'
    );
    const bodyLines = await this.#command(
      `UID FETCH ${uid} (BODY.PEEK[TEXT]<0.${Math.max(256, maxTextBytes)}>)`,
      'FETCH text'
    );
    const headerRaw = firstLiteral(headerLines)?.toString('utf8') ?? '';
    const bodyRaw = firstLiteral(bodyLines)?.toString('utf8') ?? '';
    return { uid, headerRaw, bodyRaw };
  }

  async storeSeen(uid) {
    await this.#command(`UID STORE ${uid} +FLAGS.SILENT (\\Seen)`, 'STORE');
  }

  async logout() {
    try {
      await this.#command('LOGOUT', 'LOGOUT');
    } catch {}
    this.#socket?.end?.();
    this.#socket = null;
  }

  #greeting() {
    if (this.#greeted) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#greetingWaiters.push({ resolve, reject });
      this.#tryGreeting();
    });
  }

  #tryGreeting() {
    if (this.#greeted || !this.#greetingWaiters.length) return;
    while (this.#lines.length) {
      const line = this.#lines[0];
      if (typeof line !== 'string') return;
      if (/^\*\s+(OK|PREAUTH)\b/i.test(line)) {
        this.#lines.shift();
        this.#greeted = true;
        for (const w of this.#greetingWaiters.splice(0)) w.resolve(line);
        return;
      }
      if (/^\*\s+BYE\b/i.test(line)) {
        this.#lines.shift();
        const err = new ImapError(`el servidor nos despidió al conectar: ${line}`, 'imap_bye');
        for (const w of this.#greetingWaiters.splice(0)) w.reject(err);
        return;
      }
      return;
    }
  }

  #onData(chunk) {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    this.#drain();
  }

  #drain() {
    while (true) {
      if (this.#litRemaining > 0) {
        if (!this.#buf.length) return;
        const take = Math.min(this.#litRemaining, this.#buf.length);
        this.#litChunks.push(Buffer.from(this.#buf.subarray(0, take)));
        this.#buf = this.#buf.subarray(take);
        this.#litRemaining -= take;
        if (this.#litRemaining === 0) {
          const entry = { literal: Buffer.concat(this.#litChunks) };
          if (this.#pending) this.#pending.lines.push(entry);
          else this.#lines.push(entry);
          this.#litChunks = [];
        }
        continue;
      }
      const idx = this.#buf.indexOf('\r\n');
      if (idx === -1) return;
      const line = this.#buf.subarray(0, idx).toString('utf8');
      this.#buf = this.#buf.subarray(idx + 2);
      const literalMarker = /\{(\d+)\}$/.exec(line);
      if (literalMarker) {
        this.#litRemaining = Number(literalMarker[1]);
        this.#litChunks = [];
        continue;
      }
      this.#lines.push(line);
      this.#tryGreeting();
      this.#dispatchLine(line);
    }
  }

  #dispatchLine(line) {
    if (!this.#greeted) return;
    const pending = this.#pending;
    if (pending && line.startsWith(`${pending.tag} `)) {
      this.#pending = null;
      clearTimeout(pending.timer);
      const rest = line.slice(pending.tag.length + 1).trim();
      if (rest.startsWith('OK')) pending.resolve(pending.lines);
      else pending.reject(new ImapError(`"${pending.cmd}" falló: ${rest}`, 'imap_no'));
      return;
    }
    if (pending) {
      pending.lines.push(line);
      return;
    }
    if (/^\*\s+BYE\b/i.test(line)) this.logger.error?.(`IMAP ${this.host}: ${line}`);
  }

  #failPending(err) {
    const pending = this.#pending;
    if (pending) {
      this.#pending = null;
      clearTimeout(pending.timer);
      pending.reject(err);
    }
  }

  #command(text, cmdName) {
    if (!this.#socket) return Promise.reject(new ImapError('ImapClient no está conectado'));
    if (this.#pending) return Promise.reject(new ImapError('hay un comando en vuelo (cliente secuencial)'));
    const tag = `a${++this.#nextTag}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#failPending(new ImapError(`"${cmdName}" sin respuesta (timeout)`)), 20000);
      timer.unref?.();
      this.#pending = { tag, lines: [], resolve, reject, cmd: cmdName, timer };
      this.#socket.write(`${tag} ${text}\r\n`);
    });
  }
}

export function parseImapAccounts(raw = '') {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImapError('IMAP_ACCOUNTS no es JSON válido (espero un array de cuentas).', 'invalid_config');
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((acct, i) => {
    const name = String(acct?.name || `imap-${i + 1}`);
    if (!acct?.host || !acct?.user || acct?.pass === undefined || !acct?.telegramId) {
      throw new ImapError(
        `Cuenta IMAP "${name}" incompleta: necesita host, user, pass y telegramId.`,
        'invalid_config'
      );
    }
    return {
      name,
      host: String(acct.host),
      port: Number(acct.port) || DEFAULT_IMAP_PORT,
      tls: acct.tls !== false,
      user: String(acct.user),
      pass: String(acct.pass),
      mailbox: String(acct.mailbox || DEFAULT_MAILBOX),
      telegramId: String(acct.telegramId),
      maxUidsPerPoll: Math.max(1, Number(acct.maxUidsPerPoll) || 10),
      maxTextBytes: Math.max(2048, Number(acct.maxTextBytes) || 8192)
    };
  });
}

export class ImapIngest extends IngestConnector {
  #account;
  #ctx = {};
  #logger;
  #createClient;

  constructor(account, { logger = console, createClient } = {}) {
    super(account?.name || 'imap');
    this.#account = account;
    this.#logger = logger;
    this.#createClient = createClient ?? ((a) => new ImapClient(a));
  }

  get account() {
    return this.#account;
  }

  init(ctx = {}) {
    this.#ctx = ctx;
    if (typeof this.#account !== 'object' || !this.#account?.host) {
      throw new ImapError('ImapIngest necesita una cuenta con host, user, pass y telegramId.');
    }
  }

  async poll() {
    const { runner, poller, logger } = this.#ctx;
    if (!runner || !poller) throw new ImapError('ImapIngest.poll() necesita init({ runner, poller }).');
    const out = { saved: 0, duplicates: 0, errors: 0 };
    const client = this.#createClient(this.#account);
    await client.connect();
    await client.login(this.#account.user, this.#account.pass);
    await client.select(this.#account.mailbox);
    const savedLines = [];
    try {
      const uids = (await client.searchUids()).slice(0, this.#account.maxUidsPerPoll);
      for (const uid of uids) {
        const raw = await client.fetchMessage(uid, { maxTextBytes: this.#account.maxTextBytes });
        const msg = parseMessage(raw);
        if (!msg.from || !msg.messageId) {
          out.errors++;
          logger?.error?.(`[${this.name}] email uid=${uid} sin From o Message-ID; lo dejo sin marcar como leído.`);
          continue;
        }
        try {
          runner.ingestEmail(this.#account.telegramId, {
            from: msg.from,
            messageId: msg.messageId,
            orderNumber: '',
            subject: msg.subject,
            body: msg.body
          });
          await client.storeSeen(uid);
          out.saved++;
          savedLines.push(`— ${msg.from}: "${(msg.subject || '(sin asunto)').slice(0, 80)}"`);
        } catch (err) {
          if (err.name === 'DuplicateJobError' || err.code === 'duplicate_job' || /duplicado/i.test(err.message)) {
            await client.storeSeen(uid);
            out.duplicates++;
          } else {
            out.errors++;
            logger?.error?.(`[${this.name}] uid=${uid} no se ingirió: ${err.message}`);
          }
        }
      }
    } finally {
      try {
        await client.logout();
      } catch {}
    }
    if (savedLines.length) {
      await poller
        .sendMessage(
          this.#account.telegramId,
          `📥 Guardé ${out.saved} job(s) nuevo(s) en waiting desde ${this.#account.mailbox}:\n${savedLines.join(
            '\n'
          )}\n\nNada se confirma solo: revisalos VOS con /confirm.`
        )
        .catch((e) => logger?.error?.(`[${this.name}] notificación falló: ${e.message}`));
    }
    return out;
  }
}
