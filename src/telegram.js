export class TelegramPoller {
  constructor(config, logger = console) {
    this.token = config.TELEGRAM_TOKEN;
    this.pollSeconds = config.POLL_SECONDS;
    this.logger = logger;
    this.offset = 0;
    this.base = `https://api.telegram.org/bot${this.token}`;
    this.running = false;
  }

  async sendMessage(chatId, text) {
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
    const res = await fetch(`${this.base}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    if (!res.ok) {
      const fallback = JSON.stringify({ chat_id: chatId, text: text.replace(/[*_`]/g, '') });
      await fetch(`${this.base}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: fallback
      }).catch(() => {});
    }
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