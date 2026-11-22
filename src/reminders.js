import { config } from './config.js';

export class ReminderLoop {
  #repo;
  #poller;
  #logger;
  #now;
  #timer;

  constructor({ repo, poller, logger = console, everyMs, afterHours, now } = {}) {
    this.#repo = repo;
    this.#poller = poller;
    this.#logger = logger;
    this.enabled = everyMs != null ? everyMs > 0 : config.REMINDER_MINUTES > 0;
    this.everyMs = everyMs ?? config.REMINDER_MINUTES * 60000;
    this.afterHours = afterHours ?? config.REMINDER_AFTER_HOURS;
    this.#now = now ?? (() => new Date().toISOString());
    this.running = false;
  }

  async runOnce() {
    if (!this.enabled) return [];
    const sent = [];
    const nowTs = Date.parse(this.#now());
    for (const row of this.#repo.waitingJobsByUser()) {
      const ageHours = (nowTs - Date.parse(row.oldest)) / 3600000;
      if (!(ageHours >= this.afterHours)) continue;
      const key = `reminder:${row.user_id}`;
      const last = this.#repo.cursor(key);
      if (last && nowTs - Date.parse(last) < this.everyMs) continue;
      await this.#poller.sendMessage(row.user_id, this.#message(row, ageHours));
      this.#repo.saveCursor(key, this.#now());
      sent.push(row.user_id);
    }
    return sent;
  }

  #message(row, ageHours) {
    return [
      `Recordatorio: tenés ${row.count} job(s) en waiting sin confirmar (el más viejo lleva ${Math.floor(ageHours)}h).`,
      'Nada confirma solo: revisalos VOS y pasá /confirm. "enviado" no cuenta como done.'
    ].join('\n');
  }

  start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.#timer = setInterval(() => {
      this.runOnce().catch((err) => this.#logger.error(`reminder falló: ${err.message}`));
    }, this.everyMs);
    if (this.#timer.unref) this.#timer.unref();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.running = false;
  }
}
