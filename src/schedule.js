import { config } from './config.js';
import { TaskLoop } from './task-loop.js';
import { tzDateString, tzParts } from './time.js';

const pad = (n) => String(n).padStart(2, '0');

export class ScheduleLoop extends TaskLoop {
  #repo;
  #poller;
  #now;

  constructor({ repo, poller, logger = console, tickMs = 60000, now, timeZone } = {}) {
    super({ logger, tickMs });
    this.#repo = repo;
    this.#poller = poller;
    this.#now = now ?? (() => new Date());
    this.timeZone = timeZone; // undefined = config.TIMEZONE (private = UTC)
  }

  get loopName() {
    return 'schedule';
  }

  async runOnce() {
    const fired = [];
    const d = this.#now();
    const parts = tzParts(d, this.timeZone);
    const hhmm = `${pad(parts.hour)}:${pad(parts.minute)}`;
    const day = tzDateString(parts);
    const waiting = new Map(this.#repo.waitingJobsByUser().map((w) => [w.user_id, w.count]));

    for (const routine of this.#repo.scheduledRoutines()) {
      if (routine.schedule !== hhmm) continue;
      const key = `schedule:${routine.id}`;
      if (this.#repo.cursor(key) === day) continue;
      const count = waiting.get(routine.user_id) ?? 0;
      const message = count > 0
        ? [
            `Aviso diario ${hhmm} — rutina [id ${routine.id}]: ${routine.trigger}`,
            `Tenés ${count} job(s) en waiting sin confirmar: revisalos VOS y pasá /confirm ("enviado" no cuenta como done).`
          ].join('\n')
        : [
            `Aviso diario ${hhmm} — rutina [id ${routine.id}]: ${routine.trigger}`,
            'Nada en waiting: todo al día.'
          ].join('\n');
      await this.#poller.sendMessage(routine.user_id, message);
      this.#repo.saveCursor(key, day);
      fired.push(routine.id);
    }
    return fired;
  }
}
