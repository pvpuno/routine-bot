import { config } from './config.js';
import { GmailIngest, exchangeCode, oauthConsentUrl } from './gmail.js';

const SESSION_TTL_MS = 15 * 60000;
const CODE_RE = /code=([A-Za-z0-9._-]+)/;

// OAuth de Gmail asistido por chat: /gmail → JSON del client → URL de consentimiento →
// el usuario pega el ?code= → canje → refresh_token persistido e ingesta activa al instante.
// Solo para ADMIN_TELEGRAM_ID: conectar una casilla da acceso de lectura a un mailbox real.
export class GmailOAuthChat {
  #repo;
  #runner;
  #poller;
  #ingesters;
  #logger;
  #makeIngester;
  #sessions = new Map();

  constructor({ repo, runner, poller, ingesters = [], logger = console, makeIngester } = {}) {
    this.#repo = repo;
    this.#runner = runner;
    this.#poller = poller;
    this.#ingesters = ingesters;
    this.#logger = logger;
    this.#makeIngester = makeIngester ?? ((acct) => new GmailIngest(acct, { logger }));
  }

  available() {
    return Boolean(String(config.ADMIN_TELEGRAM_ID || '').trim());
  }

  isAdmin(userId) {
    return this.available() && String(userId) === String(config.ADMIN_TELEGRAM_ID).trim();
  }

  // null = no es asunto de este flujo; deja que el texto siga a la máquina de estados.
  async handle(userId, raw) {
    const text = String(raw ?? '').trim();
    const session = this.#sessions.get(userId);
    if (session) {
      if (Date.now() - session.at > SESSION_TTL_MS) {
        this.#sessions.delete(userId);
        return 'La sesión de OAuth expiró sin completarse. Arrancá de nuevo con /gmail (y la conversación de rutinas no se tocó).';
      }
      return this.#step(session, userId, text);
    }
    if (/^\/gmail\b/i.test(text)) return this.#command(userId, text);
    return null;
  }

  sessions() {
    return this.#sessions.size;
  }

  async #command(userId, text) {
    if (!this.available()) {
      return 'Para conectar casillas por chat necesito ADMIN_TELEGRAM_ID en la config: solo el admin puede iniciar el OAuth de Gmail.';
    }
    if (!this.isAdmin(userId)) {
      return 'El OAuth de Gmail es solo para el admin del bot.';
    }
    const parts = text.split(/\s+/);
    if (parts[1]?.toLowerCase() === 'status') return this.#status(userId);
    if (parts[1]?.toLowerCase() === 'watch') return this.#watch(userId, parts[2]?.toLowerCase() || '', parts[3]);
    if (parts[1]?.toLowerCase() === 'off') return this.#off(userId, parts[2]);
    this.#sessions.set(userId, { step: 'creds', at: Date.now() });
    return [
      'Vamos a conectar una casilla Gmail con OAuth de solo lectura.',
      '1) En Google Cloud Console creá credenciales → OAuth client (tipo "Desktop").',
      '2) Mandame el JSON (con name opcional para llamar a la cuenta):',
      '   {"clientId":"...","clientSecret":"...","name":"pedidos"}',
      '',
      'Cualquier momento: "cancelar" (no toca tu conversación de rutinas) o /gmail status.'
    ].join('\n');
  }

  #step(session, userId, text) {
    if (/^\/gmail\b/i.test(text)) {
      this.#sessions.delete(userId);
      return this.#command(userId, text);
    }
    if (/^\s*cancelar[.!,…]*\s*$/i.test(text)) {
      this.#sessions.delete(userId);
      return 'Cancelado: nada quedó configurado y tu conversación de rutinas no se tocó.';
    }
    if (session.step === 'creds') return this.#creds(session, userId, text);
    return this.#codeStep(session, userId, text);
  }

  #creds(session, userId, text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return 'Eso no es JSON válido. Mandame: {"clientId":"...","clientSecret":"..."} o "cancelar".';
    }
    const clientId = String(parsed?.clientId || parsed?.client_id || '').trim();
    const clientSecret = String(parsed?.clientSecret || parsed?.client_secret || '').trim();
    if (!clientId || !clientSecret) {
      return 'Falta clientId o clientSecret. El formato es {"clientId":"...","clientSecret":"..."} (o "cancelar").';
    }
    session.clientId = clientId;
    session.clientSecret = clientSecret;
    session.name = String(parsed?.name || '').trim() || `gmail-chat-${userId}`;
    session.step = 'code';
    session.at = Date.now();
    return [
      'Perfecto. Abrí este link, aprobá el acceso de solo lectura:',
      '',
      oauthConsentUrl({ clientId }),
      '',
      'Cuando el browser llegue a http://localhost:1 y falle (es normal), copiame el ?code= de esa URL (puede ser la URL completa).'
    ].join('\n');
  }

  async #codeStep(session, userId, text) {
    const code = CODE_RE.exec(text)?.[1] || text.trim();
    if (!code || /\s/.test(code)) {
      return 'No veo un code ahí: copiame la URL completa post-consent o solo el valor de code. También podés "cancelar".';
    }
    let tokens;
    try {
      tokens = await exchangeCode({ clientId: session.clientId, clientSecret: session.clientSecret, code });
    } catch (err) {
      return `El canje falló: ${err.message}. Verificá el code (se usa una sola vez) y mandamelo de nuevo, o "cancelar".`;
    }
    const name = this.#uniqueName(session.name);
    this.#repo.saveOauthAccount({
      name,
      userId,
      clientId: session.clientId,
      clientSecret: session.clientSecret,
      refreshToken: tokens.refresh_token
    });
    this.#upsertIngester({ name, userId, clientId: session.clientId, clientSecret: session.clientSecret, refreshToken: tokens.refresh_token });
    this.#sessions.delete(userId);
    return [
      `Casilla conectada como "${name}". La chequeo desde ya:`,
      'los emails nuevos entran como jobs en waiting y te aviso por acá.',
      'Nada se confirma solo: revisalos VOS con /confirm.',
      'Para desconectarla: /gmail off ' + name
    ].join('\n');
  }

  #upsertIngester({ name, userId, clientId, clientSecret, refreshToken }) {
    const ingester = this.#makeIngester({
      name,
      credentials: { clientId, clientSecret, refreshToken },
      telegramId: userId
    });
    ingester.init({ repo: this.#repo, runner: this.#runner, poller: this.#poller });
    const i = this.#ingesters.findIndex((x) => x.name === name);
    if (i >= 0) this.#ingesters.splice(i, 1, ingester);
    else this.#ingesters.push(ingester);
    return ingester;
  }

  #uniqueName(base) {
    let name = base;
    let n = 2;
    const taken = (nm) => this.#ingesters.some((x) => x.name === nm) || this.#repo.oauthAccounts().some((a) => a.name === nm);
    while (taken(name) && !name.endsWith(`-${n - 1}`)) {
      name = `${base}-${n}`;
      n++;
    }
    return name;
  }

  async #watch(userId, action, name) {
    if (action !== 'on' && action !== 'off') {
      return 'Usá "/gmail watch on" (o con <name> para una sola casilla) o "/gmail watch off [name]". Los nombres están en /gmail status.';
    }
    if (action === 'on' && !String(config.GMAIL_WATCH_TOPIC || '').trim()) {
      return 'Para el push instantáneo definí GMAIL_WATCH_TOPIC (projects/TU_PROYECTO/topics/TU_TOPIC) en la config.';
    }
    const gmails = this.#ingesters.filter((x) => typeof x.startWatch === 'function');
    const targets = name ? gmails.filter((x) => x.name === name) : gmails;
    if (!targets.length) {
      return name
        ? `No encuentro una casilla Gmail llamada "${name}". Mirá /gmail status.`
        : 'No hay casillas Gmail conectadas todavía: conectá una con /gmail.';
    }
    if (action === 'on') {
      const topic = String(config.GMAIL_WATCH_TOPIC).trim();
      const lines = [];
      for (const ing of targets) {
        const res = await ing.startWatch(topic);
        const exp = Number(res?.expiration) || Date.now() + 6 * 24 * 3600000;
        this.#repo.saveCursor(`gmail_watch:${ing.name}`, String(exp));
        lines.push(`- ${ing.name}: push activo`);
      }
      return [
        'Push instantáneo activado (se renueva solo antes de vencer):',
        ...lines,
        '',
        'El push llega si definiste GMAIL_PUBSUB_SUBSCRIPTION con tu suscripción PULL, y',
        'la cuenta de servicio gmail-api-push@system.gserviceaccount.com tiene rol publisher en el topic.'
      ].join('\n');
    }
    const lines = [];
    for (const ing of targets) {
      await ing.stopWatch?.();
      this.#repo.saveCursor(`gmail_watch:${ing.name}`, 'off');
      lines.push(`- ${ing.name}: push desactivado`);
    }
    return ['Push desactivado (vuelve con /gmail watch on):', ...lines].join('\n');
  }

  #off(userId, name) {
    if (!this.isAdmin(userId)) return 'El OAuth de Gmail es solo para el admin del bot.';
    if (!name) {
      const cuentas = this.#repo.oauthAccounts().map((a) => `- ${a.name} → chat ${a.user_id}`).join('\n');
      return cuentas ? `Casillas conectadas por chat:\n${cuentas}\n\nPara desconectar: /gmail off <name>.` : 'No hay casillas conectadas por chat. Conectá una con /gmail.';
    }
    const removedDb = this.#repo.deleteOauthAccount(name);
    const i = this.#ingesters.findIndex((x) => x.name === name);
    if (i >= 0) this.#ingesters.splice(i, 1);
    return removedDb || i >= 0
      ? `Casilla "${name}" desconectada: dejó de chequearse. Los jobs ya guardados en la DB no se tocan.`
      : `No conozco la casilla "${name}". Mirá las conectadas con /gmail off (sin nombre).`;
  }

  #status(userId) {
    const session = this.#sessions.get(userId);
    const cuentas = this.#repo.oauthAccounts().map((a) => `- ${a.name} → chat ${a.user_id}`).join('\n');
    const where = session ? `Sesión en curso con vos (paso: ${session.step === 'creds' ? 'esperando clientId/clientSecret' : 'esperando el code'}).` : 'Con vos no hay sesión en curso.';
    return [
      where,
      cuentas ? `Casillas conectadas por chat:\n${cuentas}` : 'No hay casillas conectadas por chat todavía (conectá una con /gmail).'
    ].join('\n');
  }
}
