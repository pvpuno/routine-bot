const FETCH_TIMEOUT_MS = 15000;

export class TelegramPoller {
  constructor(config, logger = console, options = {}) {
    this.token = config.TELEGRAM_TOKEN;
    this.pollSeconds = config.POLL_SECONDS;
    this.logger = logger;
    const loaded = options.loadOffset ? Number(options.loadOffset()) : 0;
    this.offset = Number.isFinite(loaded) && loaded > 0 ? loaded : 0;
    this.saveOffset = options.saveOffset || null;
    this.onPollFailure = options.onPollFailure || null;
    this.retryMs = options.retryMs ?? 5000;
    this.failures = 0;
    this.lastPollAt = null;
    this.lastPollError = null;
    this.base = `https://api.telegram.org/bot${this.token}`;
    this.running = false;
  }

  async #postSend(body) {
    try {
      const res = await fetch(`${this.base}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      let data = null;
      try { data = await res.json(); } catch { /* cuerpo no-JSON */ }
      const retryAfter = data?.parameters?.retry_after;
      return {
        ok: res.ok && data?.ok !== false,
        retryAfter: retryAfter == null ? null : Number(retryAfter),
        description: data?.description || `HTTP ${res.status}`
      };
    } catch (err) {
      return { ok: false, retryAfter: null, description: err.message };
    }
  }

  async #deliver(chatId, text, markdown) {
    const payload = JSON.stringify(
      markdown ? { chat_id: chatId, text, parse_mode: 'Markdown' } : { chat_id: chatId, text }
    );
    let out = await this.#postSend(payload);
    if (!out.ok && out.retryAfter != null) {
      await new Promise((r) => setTimeout(r, Math.max(1, out.retryAfter) * 1000));
      out = await this.#postSend(payload);
    }
    return out;
  }

  async sendMessage(chatId, text) {
    let out = await this.#deliver(chatId, text, true);
    if (!out.ok) out = await this.#deliver(chatId, text.replace(/[*_`]/g, ''), false);
    if (!out.ok) this.logger.error(`sendMessage falló para chat ${chatId}: ${out.description}`);
  }

  // Vuelve la meta del archivo (file_path para descargar). Necesita bot en este servidor si es >20MB.
  async getFile(fileId) {
    const res = await fetch(`${this.base}/getFile?file_id=${encodeURIComponent(fileId)}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || data?.ok !== true || !data.result?.file_path) {
      throw new Error(`getFile falló: ${data?.description || `HTTP ${res.status}`}`);
    }
    return data.result;
  }

  async downloadFile(fileId, { maxBytes = 20 * 1024 * 1024 } = {}) {
    const meta = await this.getFile(fileId);
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${meta.file_path}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`descarga de archivo falló: HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error(`el archivo pesa ${declared} bytes y el límite es ${maxBytes}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`el archivo pesa ${buf.length} bytes y el límite es ${maxBytes}`);
    return buf;
  }

  async *updates() {
    while (this.running) {
      let batch = [];
      try {
        const res = await fetch(
          `${this.base}/getUpdates?timeout=${this.pollSeconds}&offset=${this.offset}&allowed_updates=${encodeURIComponent('["message"]')}`
        );
        const data = await res.json();
        this.failures = 0;
        this.lastPollAt = Date.now();
        this.lastPollError = null;
        batch = data.ok ? data.result || [] : [];
      } catch (err) {
        this.failures++;
        this.lastPollAt = Date.now();
        this.lastPollError = err.message;
        const delay = Math.min(this.retryMs * 2 ** (this.failures - 1), 60000);
        this.logger.error(`getUpdates falló (${this.failures} seguidos): ${err.message}; reintento en ${Math.round(delay / 1000)}s`);
        try { await this.onPollFailure?.(err, this.failures); } catch (hookErr) { this.logger.error(`onPollFailure falló: ${hookErr.message}`); }
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      for (const u of batch) {
        this.offset = u.update_id + 1;
        yield u;
      }
      if (batch.length && this.saveOffset) {
        try { await this.saveOffset(String(this.offset)); } catch (err) { this.logger.error(`saveOffset falló: ${err.message}`); }
      }
      if (!batch.length) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  start(onUpdate) {
    this.running = true;
    return (async () => {
      for await (const u of this.updates()) {
        try {
          await onUpdate(u);
        } catch (err) {
          this.logger.error(`Error procesando update ${u.update_id}: ${err.message}`);
        }
      }
    })();
  }

  stop() {
    this.running = false;
  }
}
