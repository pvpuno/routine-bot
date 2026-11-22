import fs from 'node:fs';
import { config, isAllowedTelegramId } from './config.js';
import { openDb } from './db.js';
import { MistralFormatter, LlmError } from './llm.js';
import { StateMachine } from './machine.js';
import { Runner } from './routines/runner.js';
import { TelegramPoller } from './telegram.js';
import { BackupLoop } from './backups.js';
import { ReminderLoop } from './reminders.js';
import { ScheduleLoop } from './schedule.js';
import { StatsLoop } from './stats.js';
import { createPollWatchdog } from './watchdog.js';
import { ImapIngest, parseImapAccounts } from './imap.js';
import { GmailIngest, parseGmailAccounts } from './gmail.js';
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
const llm = new MistralFormatter();
const actionRegistry = new ConnectorRegistry();
actionRegistry.register(new WebhookAdapter({
  logger: console,
  allowPrivate: config.ALLOW_PRIVATE_WEBHOOKS === '1'
}));
const actions = new ActionDispatcher({ repo, registry: actionRegistry, logger: console });
const machine = new StateMachine(repo, llm, runner, actions, healthReport);
const poller = new TelegramPoller(config, console, {
  loadOffset: () => repo.cursor('telegram_offset'),
  saveOffset: (value) => repo.saveCursor('telegram_offset', value)
});
poller.onPollFailure = createPollWatchdog(repo, poller, config.ADMIN_TELEGRAM_ID);
const reminders = new ReminderLoop({ repo, poller });
const scheduleLoop = new ScheduleLoop({ repo, poller });
const statsLoop = new StatsLoop({ repo, poller });
const backups = new BackupLoop({ repo });

const startedAt = Date.now();

function ago(ts) {
  if (!ts) return 'nunca';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `hace ${s}s` : `hace ${Math.round(s / 60)}m`;
}

function humanUptime() {
  const s = Math.round((Date.now() - startedAt) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

function healthReport() {
  const h = repo.health();
  const jobs = Object.entries(h.jobs).map(([k, v]) => `${k}=${v}`).join(', ') || 'ninguno';
  const loops = [reminders, scheduleLoop, statsLoop, backups, ingestLoop]
    .filter(Boolean)
    .map((l) => {
      const extra = l.lastRunAt
        ? `, último tick ${ago(l.lastRunAt)}${l.lastError ? ` (error: ${l.lastError})` : ''}`
        : '';
      return `${l.loopName}${l.running ? '' : ' (parado)'}${extra}`;
    })
    .join('; ');
  return [
    `Salud de routine-bot (uptime ${humanUptime()}):`,
    `- getUpdates: offset ${poller.offset}, fallos seguidos ${poller.failures}, último poll ${ago(poller.lastPollAt)}${poller.lastPollError ? ` (error: ${poller.lastPollError})` : ''}`,
    `- db: jobs ${jobs}; rutinas ${h.routines} (${h.activeRoutines} activas); schema v${h.schemaVersion}; cursores ${h.cursors}`,
    `- loops: ${loops}`
  ].join('\n');
}

const ingesters = [];
let ingestLoop = null;
try {
  for (const account of parseImapAccounts(config.IMAP_ACCOUNTS)) {
    const ingester = new ImapIngest(account, { logger: console });
    ingester.init({ repo, runner, poller, logger: console });
    ingesters.push(ingester);
  }
} catch (err) {
  console.error(`IMAP deshabilitado: ${err.message}`);
}
try {
  for (const account of parseGmailAccounts(config.GMAIL_ACCOUNTS)) {
    const ingester = new GmailIngest(account, { logger: console });
    ingester.init({ repo, runner, poller, logger: console });
    ingesters.push(ingester);
  }
} catch (err) {
  console.error(`Gmail deshabilitado: ${err.message}`);
}
if (ingesters.length) {
  const seconds = Math.min(
    String(config.IMAP_ACCOUNTS || '').trim() ? config.IMAP_POLL_SECONDS : Infinity,
    String(config.GMAIL_ACCOUNTS || '').trim() ? config.GMAIL_POLL_SECONDS : Infinity
  );
  ingestLoop = new IngestLoop({ ingesters, tickMs: Math.max(15, Number.isFinite(seconds) ? seconds : 60) * 1000 });
}

const VOICE_FALLBACK = 'No pude transcribir la nota de voz. Transcribila vos y mandala como texto.';
const ATTACH_NOTICE = 'Recibí un adjunto. Solo leo texto plano.';

async function handleVoice(message, chatId, userId) {
  const media = message.voice || message.audio;
  try {
    const buf = await poller.downloadFile(media.file_id);
    const transcript = await llm.transcribeAudio(buf, {
      filename: message.voice ? 'nota.ogg' : 'audio.mp3',
      mimeType: message.voice ? 'audio/ogg' : 'audio/mpeg'
    });
    const { reply } = await machine.handle(userId, transcript);
    await poller.sendMessage(chatId, `🎙️ ${transcript}\n\n${reply}`);
  } catch (err) {
    console.error(`transcripción de voz falló: ${err.message}`);
    await poller.sendMessage(chatId, VOICE_FALLBACK);
  }
}

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
    if (String(config.VOICE_TRANSCRIBE) === '0') {
      await poller.sendMessage(chatId, VOICE_FALLBACK);
      return;
    }
    await handleVoice(message, chatId, userId);
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
  backups.stop();
  ingestLoop?.stop();
  process.exit(0);
});

console.log('routine-bot en marcha (long polling). DB:', config.DB_PATH);
reminders.start();
scheduleLoop.start();
statsLoop.start();
backups.start();
ingestLoop?.start();
await poller.start(onUpdate);