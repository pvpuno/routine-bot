export class TaskLoop {
  tickMs;
  running = false;
  enabled = true;
  timer = null;
  lastRunAt = null;
  lastError = null;
  #logger;

  constructor({ logger = console, tickMs = 60000 } = {}) {
    this.#logger = logger;
    this.tickMs = tickMs ?? 60000;
  }

  get loopName() {
    return 'task';
  }

  logError(message) {
    this.#logger.error(`${this.loopName} falló: ${message}`);
  }

  async runOnce() {
    return [];
  }

  start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      const ok = () => {
        this.lastRunAt = Date.now();
        this.lastError = null;
      };
      const fail = (err) => {
        this.lastRunAt = Date.now();
        this.lastError = err.message;
        this.logError(err.message);
      };
      try {
        const out = this.runOnce();
        if (out && typeof out.catch === 'function') out.then(ok, fail);
        else ok();
      } catch (err) {
        fail(err);
      }
    }, this.tickMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.running = false;
  }
}
