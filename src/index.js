import fs from 'node:fs';
import { config } from './config.js';
import { openDb } from './db.js';
import { MistralFormatter, LlmError } from './llm.js';
import { StateMachine } from './machine.js';
import { Runner } from './routines/runner.js';
import { TelegramPoller } from './telegram.js';

function fileEnv(path) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
fileEnv(new URL('../../.env', import.meta.url).pathname);

const repo = openDb(config.DB_PATH);
const machine = new StateMachine(repo, new MistralFormatter());
const runner = new Runner(repo);
const poller = new TelegramPoller(config);

const VOICE_NOTICE = 'Recibí una nota de voz. En v1 solo leo texto: transcribila y mandala como mensaje. (Voz llega en v2.)';
const ATTACH_NOTICE = 'Recibí un adjunto. En v1 solo leo texto plano.';

async function onUpdate(update) {
  const message = update.message;
  if (!message) return;
  const userId = String(message.from?.id ?? 'unknown');
  const chatId = String(message.chat?.id ?? userId);

  let text;
  if (message.voice || message.audio) {
    await poller.sendMessage(chatId, VOICE_NOTICE);
    return;
  }
  if (!message.text) {
    await poller.sendMessage(chatId, ATTACH_NOTICE);
    return;
  }
  const cmd = message.text.trim().toLowerCase();
  if (cmd === '/jobs') {
    const jobs = runner.list(userId);
    await poller.sendMessage(chatId, '```json\n' + JSON.stringify(jobs, null, 2) + '\n```');
    return;
  }

  try {
    const { reply } = await machine.handle(userId, message.text);
    await poller.sendMessage(chatId, reply);
  } catch (err) {
    if (err instanceof LlmError) {
      await poller.sendMessage(chatId, `Error del LLM: ${err.message}`);
      return;
    }
    await poller.sendMessage(chatId, `Error: ${err.message}`);
  }
}


process.on('SIGINT', () => {
  poller.stop();
  process.exit(0);
});

console.log('routine-bot en marcha (long polling). DB:', config.DB_PATH);
await poller.start(onUpdate);