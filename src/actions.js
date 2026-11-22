import dns from 'node:dns/promises';
import { ActionAdapter } from './connectors.js';

export class ActionError extends Error {
  constructor(message, code = 'action_error') {
    super(message);
    this.code = code;
  }
}

const defaultResolve = async (host) => (await dns.lookup(host, { all: true })).map((r) => r.address);

export function isPrivateIp(ip) {
  const s = String(ip || '').toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (s === '::' || s === '::1') return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return isPrivateIp(mapped[1]);
  if (/^fe[89ab]/.test(s)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return true;
  return false;
}

export async function assertPublicHttpUrl(rawUrl, { allowPrivate = false, resolve = defaultResolve } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl ?? ''));
  } catch {
    throw new ActionError(`URL inválida: "${rawUrl}"`, 'invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ActionError('Solo se permiten URLs http:// o https://', 'invalid_url');
  }
  if (allowPrivate) return url;
  let addresses;
  try {
    addresses = await resolve(url.hostname);
  } catch (err) {
    throw new ActionError(`No pude resolver el host "${url.hostname}": ${err.message}`, 'dns_error');
  }
  if (!addresses?.length) {
    throw new ActionError(`El host "${url.hostname}" no resolvió a ninguna IP.`, 'dns_error');
  }
  const bad = addresses.find((ip) => isPrivateIp(ip));
  if (bad) {
    throw new ActionError(
      `La URL "${url.hostname}" apunta a una IP privada (${bad}): bloqueado por seguridad. Si realmente la querés, configurá ALLOW_PRIVATE_WEBHOOKS=1.`,
      'private_target'
    );
  }
  return url;
}

// Acepta un objeto {type, url, headers?} o su JSON. null/vacío = sin acción.
export function parseActionConfig(raw) {
  if (raw == null || raw === '') return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new ActionError('La configuración de acción no es JSON válido.', 'invalid_action_config');
    }
  }
  if (typeof obj !== 'object' || ![obj?.type, obj?.url].every((v) => typeof v === 'string' && v.trim())) {
    throw new ActionError('La acción necesita { type, url } con url http(s).', 'invalid_action_config');
  }
  if (obj.type !== 'webhook') {
    throw new ActionError(`Tipo de acción desconocido: "${obj.type}" (hoy solo "webhook").`, 'invalid_action_config');
  }
  if (!/^https?:\/\//i.test(obj.url)) {
    throw new ActionError('La URL de la acción debe ser http:// o https://', 'invalid_action_config');
  }
  return { type: 'webhook', url: obj.url, headers: obj.headers && typeof obj.headers === 'object' ? obj.headers : {} };
}

export class WebhookAdapter extends ActionAdapter {
  #fetchImpl;
  #resolve;
  #allowPrivate;
  #timeoutMs;
  #maxBytes;

  constructor({
    fetchImpl,
    resolve,
    allowPrivate = false,
    timeoutMs = 10000,
    maxBytes = 65536,
    logger = console
  } = {}) {
    super('webhook');
    this.#fetchImpl = fetchImpl ?? ((url, opts) => fetch(url, opts));
    this.#resolve = resolve ?? defaultResolve;
    this.#allowPrivate = allowPrivate === true;
    this.#timeoutMs = Math.max(1000, Number(timeoutMs) || 10000);
    this.#maxBytes = Math.max(1024, Number(maxBytes) || 65536);
    this.logger = logger;
  }

  get allowPrivate() {
    return this.#allowPrivate;
  }

  async deliver(job, cfg = null) {
    const action = parseActionConfig(cfg);
    if (!action || action.type !== 'webhook') {
      throw new ActionError('WebhookAdapter necesita una configuración { type: "webhook", url }.', 'invalid_action_config');
    }
    const url = await assertPublicHttpUrl(action.url, {
      allowPrivate: this.#allowPrivate,
      resolve: this.#resolve
    });

    let data = {};
    try {
      data = JSON.parse(job?.payload || '{}');
    } catch {}

    const res = await this.#fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...action.headers },
      body: JSON.stringify({
        job_id: job.id,
        routine_id: job.routine_id,
        idempotency_key: job.idempotency_key,
        status: job.status,
        confirmed_at: job.confirmed_at,
        data
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.#timeoutMs)
    });

    const body = (await res.text()).slice(0, this.#maxBytes);
    if (!res.ok) {
      const err = new ActionError(`El webhook respondió HTTP ${res.status}`, 'webhook_http_error');
      err.httpStatus = res.status;
      err.body = body;
      throw err;
    }
    return { httpStatus: res.status, body: body.slice(0, 200) };
  }
}

export class ActionDispatcher {
  #repo;
  #registry;
  #logger;

  constructor({ repo, registry, logger = console } = {}) {
    this.#repo = repo;
    this.#registry = registry;
    this.#logger = logger;
  }

  // Solo corre tras un /confirm exitoso (aprobación explícita) y una sola vez por job+target.
  async dispatchConfirmed(job) {
    if (!job) return null;
    const fresh = this.#repo.job(job.id);
    if (!fresh || fresh.status !== 'confirmed') return null;
    const routine = fresh.routine_id != null ? this.#repo.routine(fresh.routine_id) : null;
    let cfg;
    try {
      cfg = parseActionConfig(routine?.action_config);
    } catch (err) {
      this.#logger.error?.(`acción: config inválida en rutina ${fresh.routine_id}: ${err.message}`);
      return null;
    }
    if (!cfg) return null;
    if (this.#repo.successfulActionRun(fresh.id, cfg.url)) return null;

    const adapter = this.#registry.get(cfg.type);
    const runId = this.#repo.insertActionRun({
      jobId: fresh.id,
      routineId: fresh.routine_id,
      userId: fresh.user_id,
      adapter: cfg.type,
      target: cfg.url
    });

    if (!adapter) {
      const error = `no hay adapter registrado para "${cfg.type}"`;
      this.#repo.finishActionRun(runId, { status: 'error', error });
      return { ok: false, error, target: cfg.url };
    }

    try {
      const result = await adapter.deliver(fresh, cfg);
      this.#repo.finishActionRun(runId, {
        status: 'ok',
        httpStatus: result.httpStatus,
        response: result.body ?? ''
      });
      return { ok: true, ...result, target: cfg.url };
    } catch (err) {
      this.#repo.finishActionRun(runId, {
        status: err.httpStatus ? 'http_error' : 'error',
        httpStatus: err.httpStatus ?? null,
        error: err.message
      });
      return { ok: false, error: err.message, httpStatus: err.httpStatus ?? null, target: cfg.url };
    }
  }
}
