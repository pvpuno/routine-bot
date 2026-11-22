import { config } from './config.js';

const DAY = 24 * 3600000;

export function weeklyStats(repo, userId, nowMs = Date.now()) {
  const since = nowMs - 7 * DAY;
  const jobs = repo.jobsFor(userId);
  let created = 0;
  let confirmed = 0;
  let confirmDurations = 0;
  let waiting = 0;
  let failed = 0;
  for (const job of jobs) {
    const savedTs = job.saved_at ? Date.parse(job.saved_at) : NaN;
    const confirmedTs = job.confirmed_at ? Date.parse(job.confirmed_at) : NaN;
    if (Number.isFinite(savedTs) && savedTs >= since) created++;
    if (Number.isFinite(confirmedTs) && confirmedTs >= since) {
      confirmed++;
      if (Number.isFinite(savedTs) && confirmedTs >= savedTs) confirmDurations += confirmedTs - savedTs;
    }
    if (job.status === 'waiting') waiting++;
    if (job.status === 'failed') failed++;
  }
  const avgConfirmH = confirmed > 0 ? confirmDurations / confirmed / 3600000 : null;
  return { created, confirmed, waiting, failed, avgConfirmH };
}

export function statsMessage(s, windowText = 'últimos 7 días') {
  if (!s.created && !s.waiting && !s.failed) {
    return `Resumen semanal (${windowText}): semana tranquila — nada guardado ni pendiente.`;
  }
  const lines = [
    `Resumen semanal (${windowText}):`,
    `- jobs guardados: ${s.created}`,
    `- confirmados por vos: ${s.confirmed}`
  ];
  if (s.avgConfirmH != null) {
    const h = Math.floor(s.avgConfirmH);
    const m = Math.round((s.avgConfirmH - h) * 60);
    lines.push(`- tiempo medio hasta confirmar: ${h}h ${m}m`);
  }
  lines.push(`- waiting ahora: ${s.waiting}`);
  lines.push(`- failed: ${s.failed}`);
  if (s.waiting > 0) {
    lines.push('Los waiting esperan tu revisión: pasá /confirm ("enviado" no cuenta como done).');
  }
  return lines.join('\n');
}

export class StatsLoop {
  #repo;
  #poller;
  #logger;
  #now;
  #tickMs;
  #timer;

  constructor({ repo, poller, logger = console, tickMs = 60000, now, day, hhmm } = {}) {
    this.#repo = repo;
    this.#poller = poller;
    this.#logger = logger;
    this.#tickMs = tickMs ?? 60000;
    this.#now = now ?? (() => new Date());
    this.day = day ?? config.STATS_DAY;
    this.hhmm = hhmm ?? config.STATS_HHMM;
    this.enabled = Boolean(this.hhmm) && this.hhmm !== 'off' && this.day >= 0 && this.day <= 6;
    this.running = false;
  }

  async runOnce() {
    if (!this.enabled) return [];
    const fired = [];
    const d = this.#now();
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (d.getDay() !== this.day || hhmm !== this.hhmm) return fired;
    const nowMs = d.getTime();

    for (const row of this.#repo.usersWithJobs()) {
      const key = `stats:${row.user_id}`;
      const last = this.#repo.cursor(key);
      const lastTs = last ? Date.parse(last) : 0;
      if (nowMs - lastTs < 6.5 * DAY) continue;
      const s = weeklyStats(this.#repo, row.user_id, nowMs);
      await this.#poller.sendMessage(row.user_id, statsMessage(s));
      this.#repo.saveCursor(key, d.toISOString());
      fired.push(row.user_id);
    }
    return fired;
  }

  start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.#timer = setInterval(() => {
      this.runOnce().catch((err) => this.#logger.error(`stats falló: ${err.message}`));
    }, this.#tickMs);
    if (this.#timer.unref) this.#timer.unref();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.running = false;
  }
}
