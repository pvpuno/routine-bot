import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));


export const config = {
  DB_PATH: process.env.DB_PATH || path.join(root, 'data', 'routine-bot.db'),
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN || '',
  ALLOWED_TELEGRAM_IDS: process.env.ALLOWED_TELEGRAM_IDS || '',
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
  MISTRAL_MODEL: process.env.MISTRAL_MODEL || 'mistral-large-latest',
  MISTRAL_BASE_URL: process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1',
  MISTRAL_TIMEOUT_MS: Number(process.env.MISTRAL_TIMEOUT_MS || 30000),
  MISTRAL_RETRIES: Number(process.env.MISTRAL_RETRIES || 2),
  POLL_SECONDS: Number(process.env.POLL_SECONDS || 30),
  REMINDER_MINUTES: Number(process.env.REMINDER_MINUTES ?? 60),
  REMINDER_AFTER_HOURS: Number(process.env.REMINDER_AFTER_HOURS ?? 6),
  STATS_DAY: Number(process.env.STATS_DAY ?? 1),
  STATS_HHMM: process.env.STATS_HHMM ?? '09:00',
  ADMIN_TELEGRAM_ID: process.env.ADMIN_TELEGRAM_ID || '',
  IMAP_ACCOUNTS: process.env.IMAP_ACCOUNTS || '',
  IMAP_POLL_SECONDS: Number(process.env.IMAP_POLL_SECONDS ?? 60),
  ALLOW_PRIVATE_WEBHOOKS: process.env.ALLOW_PRIVATE_WEBHOOKS || ''
};

fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });

// Sin allowlist definida (o vacía) se mantiene el comportamiento de v1: entra todo.
export function isAllowedTelegramId(userId, raw = config.ALLOWED_TELEGRAM_IDS) {
  const allowed = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.length) return true;
  return allowed.includes(String(userId).trim());
}
