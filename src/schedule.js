const pad = (n) => String(n).padStart(2, '0');

export class ScheduleLoop {
  #repo;
  #poller;
  #logger;
  #now;
  #tickMs;
  #timer;

  constructor({ repo, poller, logger = console, tickMs = 60000, now } = {}) {
    this.#repo = repo;
    this.#poller = poller;
    this.#logger = logger;
    this.#tickMs = tickMs ?? 60000;
    this.#now = now ?? (() => new Date());
    this.running = false;
  }

  async runOnce() {
    const fired = [];
    const d = this.#now();
    const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

  start() {
    if (this.running) return;
    this.running = true;
    this.#timer = setInterval(() => {
      this.runOnce().catch((err) => this.#logger.error(`schedule falló: ${err.message}`));
    }, this.#tickMs);
    if (this.#timer.unref) this.#timer.unref();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.running = false;
  }
}
