import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { TaskLoop } from './task-loop.js';
import { tzDateString, tzParts } from './time.js';

const BACKUP_RE = /^routine-bot-\d{8}-\d{6}\.db$/;

// Borra los backups más viejos y deja solo los últimos `keep` (el nombre lleva la fecha, así que ordenar por nombre = por antigüedad).
export function pruneBackups(dir, keep) {
  const limit = Math.max(1, Number(keep) || 1);
  const files = fs.readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort((a, b) => (a < b ? 1 : -1));
  const removed = [];
  for (const f of files.slice(limit)) {
    fs.unlinkSync(path.join(dir, f));
    removed.push(f);
  }
  return removed;
}

// Un backup diario de la DB por VACUUM INTO (online, no bloquea el bot).
export class BackupLoop extends TaskLoop {
  #repo;
  #now;

  constructor({
    repo,
    logger = console,
    tickMs = 60000,
    dir,
    hhmm = config.BACKUP_HHMM,
    keep = config.BACKUP_KEEP,
    now,
    timeZone
  } = {}) {
    super({ logger, tickMs });
    this.#repo = repo;
    this.#now = now ?? (() => new Date());
    this.dir = dir ?? config.BACKUP_DIR ?? '';
    this.hhmm = hhmm;
    this.keep = Math.max(1, Number(keep) || 7);
    this.timeZone = timeZone;
    this.enabled = Boolean(this.dir && this.hhmm && this.hhmm !== 'off');
  }

  get loopName() {
    return 'backups';
  }

  async runOnce() {
    if (!this.enabled) return [];
    const d = this.#now();
    const parts = tzParts(d, this.timeZone);
    const hhmm = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
    if (hhmm !== this.hhmm) return [];
    const day = tzDateString(parts);
    if (this.#repo.cursor('backup') === day) return [];

    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${day.replace(/-/g, '')}-${pad(parts.hour)}${pad(parts.minute)}${pad(parts.second)}`;
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `routine-bot-${stamp}.db`);
    this.#repo.vacuumInto(file);
    const removed = pruneBackups(this.dir, this.keep);
    this.#repo.saveCursor('backup', day);
    return [{ file, removed }];
  }
}
