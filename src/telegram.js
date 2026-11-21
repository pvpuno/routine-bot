const FETCH_TIMEOUT_MS = 15000;

export class TelegramPoller {
  constructor(config, logger = console, options = {}) {
    this.token = config.TELEGRAM_TOKEN;
    this.pollSeconds = config.POLL_SECONDS;
    this.logger = logger;
    const loaded = options.loadOffset ? Number(options.loadOffset()) : 0;
    this.offset = Number.isFinite(loaded) && loaded > 0 ? loaded : 0;
    this.saveOffset = options.saveOffset || null;
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

  async *updates() {
    while (this.running) {
      let batch = [];
      try {
        const res = await fetch(
          `${this.base}/getUpdates?timeout=${this.pollSeconds}&offset=${this.offset}&allowed_updates=${encodeURIComponent('["message"]')}`
        );
        const data = await res.json();
        batch = data.ok ? data.result || [] : [];
      } catch (err) {
        this.logger.error(`getUpdates falló: ${err.message}; reintento en 5s`);
        await new Promise((r) => setTimeout(r, 5000));
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
