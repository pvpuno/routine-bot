import fs from 'node:fs';
import { config, isAllowedTelegramId } from './config.js';
import { openDb } from './db.js';
import { MistralFormatter, LlmError } from './llm.js';
import { StateMachine } from './machine.js';
import { Runner } from './routines/runner.js';
import { TelegramPoller } from './telegram.js';
import { ReminderLoop } from './reminders.js';
import { ScheduleLoop } from './schedule.js';
import { StatsLoop } from './stats.js';
import { createPollWatchdog } from './watchdog.js';
import { ImapIngest, parseImapAccounts } from './imap.js';
import { ConnectorRegistry, IngestLoop } from './connectors.js';
import { ActionDispatcher, WebhookAdapter } from './actions.js';

function fileEnv(path) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
fileEnv(new URL('../../.env', import.meta.url).pathname);

const repo = openDb(config.DB_PATH);
const runner = new Runner(repo);
const actionRegistry = new ConnectorRegistry();
actionRegistry.register(new WebhookAdapter({
  logger: console,
  allowPrivate: config.ALLOW_PRIVATE_WEBHOOKS === '1'
}));
const actions = new ActionDispatcher({ repo, registry: actionRegistry, logger: console });
const machine = new StateMachine(repo, new MistralFormatter(), runner, actions);
const poller = new TelegramPoller(config, console, {
  loadOffset: () => repo.cursor('telegram_offset'),
  saveOffset: (value) => repo.saveCursor('telegram_offset', value)
});
poller.onPollFailure = createPollWatchdog(repo, poller, config.ADMIN_TELEGRAM_ID);
const reminders = new ReminderLoop({ repo, poller });
const scheduleLoop = new ScheduleLoop({ repo, poller });
const statsLoop = new StatsLoop({ repo, poller });

const imapIngesters = [];
let ingestLoop = null;
try {
  for (const account of parseImapAccounts(config.IMAP_ACCOUNTS)) {
    const ingester = new ImapIngest(account, { logger: console });
    ingester.init({ repo, runner, poller, logger: console });
    imapIngesters.push(ingester);
  }
  if (imapIngesters.length) {
    ingestLoop = new IngestLoop({ ingesters: imapIngesters, tickMs: Math.max(15, config.IMAP_POLL_SECONDS) * 1000 });
  }
} catch (err) {
  console.error(`IMAP deshabilitado: ${err.message}`);
}

const VOICE_NOTICE = 'Recibí una nota de voz. En v1 solo leo texto: transcribila y mandala como mensaje. (Voz llega en v2.)';
const ATTACH_NOTICE = 'Recibí un adjunto. En v1 solo leo texto plano.';

async function onUpdate(update) {
  const message = update.message;
  if (!message) return;
  const userId = String(message.from?.id ?? 'unknown');
  const chatId = String(message.chat?.id ?? userId);

  if (!isAllowedTelegramId(userId)) {
    console.log(`Update rechazado: usuario ${userId} fuera de la allowlist`);
    await poller.sendMessage(chatId, 'Acceso restringido. Este bot no puede atenderte.');
    return;
  }

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
  reminders.stop();
  scheduleLoop.stop();
  statsLoop.stop();
  ingestLoop?.stop();
  process.exit(0);
});

console.log('routine-bot en marcha (long polling). DB:', config.DB_PATH);
reminders.start();
scheduleLoop.start();
statsLoop.start();
ingestLoop?.start();
await poller.start(onUpdate);