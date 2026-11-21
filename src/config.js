import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(new URL('..', import.meta.url).pathname);


export const config = {
  DB_PATH: process.env.DB_PATH || path.join(root, 'data', 'routine-bot.db'),
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN || '',
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
  MISTRAL_MODEL: process.env.MISTRAL_MODEL || 'mistral-large-latest',
  MISTRAL_BASE_URL: process.env.MISTRAL_BASE_URL || 'https://api.mistral.ai/v1',
  MISTRAL_TIMEOUT_MS: Number(process.env.MISTRAL_TIMEOUT_MS || 30000),
  MISTRAL_RETRIES: Number(process.env.MISTRAL_RETRIES || 2),
  POLL_SECONDS: Number(process.env.POLL_SECONDS || 30)
};

fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });