export class TaskLoop {
  tickMs;
  running = false;
  enabled = true;
  timer = null;
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
      try {
        const out = this.runOnce();
        if (out && typeof out.catch === 'function') out.catch((err) => this.logError(err.message));
      } catch (err) {
        this.logError(err.message);
      }
    }, this.tickMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.running = false;
  }
}
