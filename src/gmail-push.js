import { config } from './config.js';
import { TaskLoop } from './task-loop.js';
import { fetchAccessToken } from './gmail.js';

export const PUBSUB_BASE = 'https://pubsub.googleapis.com';
const PULL_MAX = 100;
const TOKEN_SKEW_MS = 60000;
const RENEW_WINDOW_MS = 48 * 3600000;

// Notificación de Gmail en Pub/Sub: data base64 con { emailAddress, historyId }.
export function decodeNotification(dataBase64) {
  if (!dataBase64) return null;
  try {
    return JSON.parse(Buffer.from(String(dataBase64), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

// Push de Gmail SIN endpoint público: usa una SUSCRIPCIÓN PULL de Pub/Sub (la misma filosofía
// getUpdates del bot). Cada tick consulta subscriptions:pull; si viene una notificación
// { emailAddress } la canjea por un poll() instantáneo del ingester de esa casilla y ack'ea.
// Además renueva users.watch de las casillas antes de que venca (~7 días).
export class GmailPushLoop extends TaskLoop {
  #repo;
  #ingesters;
  #now;
  #token = null;
  #tokenKey = '';

  constructor({ repo, ingesters = [], logger = console, tickMs, subscription = config.GMAIL_PUBSUB_SUBSCRIPTION, now } = {}) {
    super({ logger, tickMs: tickMs ?? Math.max(2, Number(config.GMAIL_PUSH_TICK_SECONDS ?? 5)) * 1000 });
    this.#repo = repo;
    this.#ingesters = ingesters;
    this.#now = now ?? (() => new Date());
    this.subscription = String(subscription || '').trim();
    this.enabled = Boolean(this.subscription);
  }

  get loopName() {
    return 'gmail-push';
  }

  #gmails() {
    return this.#ingesters.filter((i) => typeof i.poll === 'function' && typeof i.startWatch === 'function' && i.account?.credentials);
  }

  #currentCreds() {
    return this.#gmails()[0]?.account?.credentials || null;
  }

  async #accessToken() {
    const creds = this.#currentCreds();
    if (!creds) throw new Error('gmail-push sin casilla Gmail conectada: conectar una con /gmail');
    const key = creds.clientId;
    if (this.#tokenKey !== key) {
      this.#token = null;
      this.#tokenKey = key;
    }
    const nowMs = this.#now().getTime();
    if (this.#token && this.#token.expiresAt - TOKEN_SKEW_MS > nowMs) return this.#token.value;
    this.#token = await fetchAccessToken(creds, nowMs);
    return this.#token.value;
  }

  async #pubsub(path, body, token) {
    const res = await fetch(`${PUBSUB_BASE}/v1/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`Pub/Sub falló: HTTP ${res.status} en ${path.split('/').pop().split(':')[1]}`);
    return res.json().catch(() => ({}));
  }

  async #resolve(gmails, emailAddress) {
    if (gmails.length === 1) return gmails[0];
    if (!emailAddress) return null;
    const wanted = String(emailAddress).toLowerCase();
    for (const g of gmails) {
      const address = await g.emailAddress?.().catch(() => '');
      if (address === wanted) return g;
    }
    return null;
  }

  async #renewWatches(gmails) {
    const topic = String(config.GMAIL_WATCH_TOPIC || '').trim();
    if (!topic) return;
    const horizon = this.#now().getTime() + RENEW_WINDOW_MS;
    for (const ing of gmails) {
      const key = `gmail_watch:${ing.name}`;
      const raw = this.#repo.cursor(key);
      if (raw === 'off') continue;
      if ((Number(raw) || 0) > horizon) continue;
      try {
        const res = await ing.startWatch(topic);
        const exp = Number(res?.expiration) || this.#now().getTime() + 6 * 24 * 3600000;
        this.#repo.saveCursor(key, String(exp));
      } catch (err) {
        this.logError(`watch de ${ing.name} no se pudo activar/renovar: ${err.message}`);
      }
    }
  }

  async runOnce() {
    if (!this.enabled) return [];
    const gmails = this.#gmails();
    if (!gmails.length) return [];
    await this.#renewWatches(gmails);

    const token = await this.#accessToken();
    const data = await this.#pubsub(`${this.subscription}:pull`, { maxMessages: PULL_MAX }, token);
    const received = data?.receivedMessages || [];
    const polled = [];

    for (const rm of received) {
      const notification = decodeNotification(rm?.message?.data);
      const target = await this.#resolve(gmails, notification?.emailAddress);
      if (!target) continue;
      try {
        await target.poll();
        if (!polled.includes(target.name)) polled.push(target.name);
      } catch (err) {
        this.logError(`poll de ${target.name} tras push falló: ${err.message}`);
      }
    }
    if (received.length) {
      await this.#pubsub(`${this.subscription}:acknowledge`, { ackIds: received.map((r) => r.ackId) }, token);
    }
    return polled;
  }
}
