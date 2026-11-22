import { IngestConnector } from './connectors.js';
import { decodeRfc2047, extractAddress, htmlToText } from './imap.js';

export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const G_REDIRECT_URI = 'http://localhost:1';

const FETCH_TIMEOUT_MS = 15000;
const TOKEN_SKEW_MS = 60000;

export class GmailError extends Error {
  constructor(message, code = 'gmail_error') {
    super(message);
    this.code = code;
  }
}

export function base64UrlDecode(input = '') {
  return Buffer.from(String(input ?? '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function gmailHeader(payload, name) {
  const wanted = String(name).toLowerCase();
  const hit = (payload?.headers || []).find((h) => String(h?.name || '').toLowerCase() === wanted);
  return hit ? String(hit.value) : '';
}

// Prefiere text/plain en cualquier parte del árbol MIME; si no hay, baja el primer text/html.
export function extractGmailText(payload) {
  const walk = (node, mime) => {
    if (!node) return null;
    if (node.body?.data && String(node.mimeType || '') === mime) {
      return base64UrlDecode(node.body.data).toString('utf8');
    }
    for (const part of node.parts || []) {
      const hit = walk(part, mime);
      if (hit) return hit;
    }
    return null;
  };
  const plain = walk(payload, 'text/plain');
  if (plain) return plain;
  const html = walk(payload, 'text/html');
  return html ? htmlToText(html) : null;
}

// El usuario ve esta URL en el browser, aprueba y copia el ?code= del redirect (a localhost, que falla por diseño).
export function oauthConsentUrl({ clientId, redirectUri = G_REDIRECT_URI } = {}) {
  if (!clientId) throw new GmailError('oauthConsentUrl necesita clientId.', 'invalid_config');
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    access_type: 'offline',
    prompt: 'consent'
  });
  return `${OAUTH_AUTH_URL}?${q}`;
}

export async function exchangeCode({ clientId, clientSecret, code, redirectUri = G_REDIRECT_URI } = {}) {
  if (!clientId || !clientSecret || !code) {
    throw new GmailError('exchangeCode necesita clientId, clientSecret y code.', 'invalid_config');
  }
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    throw new GmailError(`exchange de código falló: HTTP ${res.status}${data?.error ? ` (${data.error})` : ''}`);
  }
  if (!data.refresh_token) {
    throw new GmailError('Google no devolvió refresh_token: repetí el consentimiento con prompt=consent.');
  }
  return data;
}

export function parseGmailAccounts(raw = '') {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GmailError('GMAIL_ACCOUNTS no es JSON válido (espero un array de cuentas).', 'invalid_config');
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((acct, i) => {
    const name = String(acct?.name || `gmail-${i + 1}`);
    const creds = acct?.credentials || acct;
    if (!creds?.clientId || !creds?.clientSecret || !creds?.refreshToken || !acct?.telegramId) {
      throw new GmailError(
        `Cuenta Gmail "${name}" incompleta: necesita clientId, clientSecret, refreshToken y telegramId.`,
        'invalid_config'
      );
    }
    return {
      name,
      credentials: {
        clientId: String(creds.clientId),
        clientSecret: String(creds.clientSecret),
        refreshToken: String(creds.refreshToken)
      },
      telegramId: String(acct.telegramId),
      query: String(acct.query || 'in:inbox is:unread'),
      maxResultsPerPoll: Math.max(1, Number(acct.maxResultsPerPoll) || 10)
    };
  });
}

// Ingesta por Gmail API (REST cero deps): OAuth2 refresh-token grant, búsqueda con query
// (default: sin leer en inbox), ingesta por runner y marca UNREAD solo si guardó o era duplicado.
export class GmailIngest extends IngestConnector {
  #account;
  #ctx = {};
  #logger;
  #now;
  #token = null;

  constructor(account, { logger = console, now } = {}) {
    super(account?.name || 'gmail');
    this.#account = account;
    this.#logger = logger;
    this.#now = now ?? (() => new Date());
  }

  get account() {
    return this.#account;
  }

  init(ctx = {}) {
    this.#ctx = ctx;
    const creds = this.#account?.credentials;
    if (typeof this.#account !== 'object' || !creds?.clientId || !creds?.clientSecret || !creds?.refreshToken) {
      throw new GmailError('GmailIngest necesita una cuenta con clientId, clientSecret, refreshToken y telegramId.');
    }
  }

  async #accessToken() {
    const { clientId, clientSecret, refreshToken } = this.#account.credentials;
    const nowMs = this.#now().getTime();
    if (this.#token && this.#token.expiresAt - TOKEN_SKEW_MS > nowMs) return this.#token.value;
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.access_token) {
      throw new GmailError(`refresh de token falló: HTTP ${res.status}${data?.error ? ` (${data.error})` : ''}`);
    }
    this.#token = { value: String(data.access_token), expiresAt: nowMs + Number(data.expires_in || 3600) * 1000 };
    return this.#token.value;
  }

  async #gmail(path, token) {
    const res = await fetch(`${GMAIL_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) throw new GmailError(`Gmail API falló: HTTP ${res.status} en ${path.split('?')[0]}`);
    return res.json();
  }

  async #markRead(token, id) {
    const res = await fetch(`${GMAIL_API_BASE}/messages/${id}/modify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) throw new GmailError(`marcado de leído falló: HTTP ${res.status} en ${id}`);
  }

  async poll() {
    const { runner, poller, logger } = this.#ctx;
    if (!runner || !poller) throw new GmailError('GmailIngest.poll() necesita init({ runner, poller }).');
    const out = { saved: 0, duplicates: 0, errors: 0 };

    const token = await this.#accessToken();
    const list = await this.#gmail(
      `/messages?q=${encodeURIComponent(this.#account.query)}&maxResults=${this.#account.maxResultsPerPoll}`,
      token
    );
    const ids = (list.messages || []).map((m) => m.id).reverse();
    const savedLines = [];

    for (const id of ids) {
      try {
        const full = await this.#gmail(`/messages/${id}?format=full`, token);
        const from = extractAddress(gmailHeader(full.payload, 'From'));
        const messageId = gmailHeader(full.payload, 'Message-ID') || `gmail-${full.id}`;
        const subject = decodeRfc2047(gmailHeader(full.payload, 'Subject'));
        const body = extractGmailText(full.payload) ?? '';
        if (!from) {
          out.errors++;
          this.#logger?.error?.(`[${this.name}] mensaje ${id} sin From; lo dejo sin marcar como leído.`);
          continue;
        }
        try {
          runner.ingestEmail(this.#account.telegramId, { from, messageId, orderNumber: '', subject, body });
          await this.#markRead(token, id);
          out.saved++;
          savedLines.push(`— ${from}: "${(subject || '(sin asunto)').slice(0, 80)}"`);
        } catch (err) {
          if (err.name === 'DuplicateJobError' || err.code === 'duplicate_job' || /duplicado/i.test(err.message)) {
            await this.#markRead(token, id);
            out.duplicates++;
          } else {
            out.errors++;
            this.#logger?.error?.(`[${this.name}] mensaje ${id} no se ingirió: ${err.message}`);
          }
        }
      } catch (err) {
        out.errors++;
        this.#logger?.error?.(`[${this.name}] mensaje ${id} falló: ${err.message}`);
      }
    }

    if (savedLines.length) {
      await poller
        .sendMessage(
          this.#account.telegramId,
          `📥 Guardé ${out.saved} job(s) nuevo(s) en waiting desde Gmail (${this.name}):\n${savedLines.join('\n')}\n\nNada se confirma solo: revisalos VOS con /confirm.`
        )
        .catch((e) => this.#logger?.error?.(`[${this.name}] notificación falló: ${e.message}`));
    }
    return out;
  }
}
