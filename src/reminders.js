import { config } from './config.js';
import { TaskLoop } from './task-loop.js';

const DAY = 24 * 3600000;

export class ReminderLoop extends TaskLoop {
  #repo;
  #poller;
  #now;

  constructor({ repo, poller, logger = console, everyMs, afterHours, now } = {}) {
    const resolvedEveryMs = everyMs ?? Math.max(0, config.REMINDER_MINUTES) * 60000;
    super({ logger, tickMs: resolvedEveryMs });
    this.#repo = repo;
    this.#poller = poller;
    this.enabled = resolvedEveryMs > 0;
    this.afterHours = afterHours ?? config.REMINDER_AFTER_HOURS;
    this.#now = now ?? (() => new Date().toISOString());
  }

  get loopName() {
    return 'reminder';
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
      if (last && nowTs - Date.parse(last) < this.tickMs) continue;
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
}
