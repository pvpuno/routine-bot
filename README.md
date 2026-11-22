# routine-bot

Bot conversacional (Telegram) que convierte tareas repetitivas en rutinas automatizadas,
siguiendo la filosofía: **goal first → process second → then routines** (entender primero,
automatizar segundo).

- Canal v1: **Telegram** (texto; voz queda para v2).
- LLM: **Mistral** (`mistral-large-latest`, con `response_format: json_object`).
- Persistencia: **SQLite** (cero dependencias npm: Node ≥ 22 usa `node:sqlite` nativo).

## La máquina de estados (6 fases)

| Fase | Qué hace el bot | Sale cuando |
|--------|-----------------|-------------|
| `goal` | Reformula tu meta en UNA frase y pregunta si es correcto | Confirmás "sí, eso es" |
| `process` | Estructura tu brain dump en `steps, watch_outs, tools, check_work, info_from, feedback_from` y hace `/restate` (meta + proceso simple) | Confirmás "sí" |
| `clarify` | Pregunta UNA A LA VEZ: conflicto → saved → confirmed → waiting; cada respuesta se convierte en regla. Antes de salir, exige 3 ejemplos reales con uno fallido + lección | Ejemplos completos |
| `improve` | Comparación proceso vs. evidencia. **v1: se salta** (requiere conectores) | Siempre (skip) |
| `routines` | Convierte reglas en rutina: `trigger → acción → idempotency_key` (hash de remitente + message-id) | Propuesta lista |
| `review` | Muestra `{ goal, process, rules, routine, next_step }`. **DEFAULT: proponer y esperar; nada se ejecuta sin tu "sí"** | Aprobás la rutina concreta |


Reglas globales implementadas:
- Una pregunta a la vez en las fases conversacionales.
- Nada se ejecuta sin confirmación explícita en `review`; la rutina recién entonces pasa a `active`.
- `waiting := track it, resume later`: el job con confirmación fallida queda en `waiting`
  y se re-retoma con la misma clave; **nunca se re-crea un job duplicado**.
- `confirmed` exige confirmación personal: "sent" / "enviado" NO cuenta como done
  (queda registrado como intento rechazado en `attempts`).
- La confirmación en el chat es **conversacional**: `/confirm` pregunta uno a uno por los jobs
  en `waiting` y solo un "sí" explícito confirma (el mismo `AFFIRM_RE` de la máquina).
  Frases como "te lo envié" nunca confirman: se registran como intento rechazado y el diálogo
  sigue esperando un sí/no/cancelar. El `Runner.confirmJob` programático queda para integraciones.
- `saved_at` y `confirmed_at` son DOS timestamps distintos; el listado de jobs muestra ambos.

## Estructura

```
db/schema.sql          conversations, goals, processes, rules, routines, jobs
src/config.js          variables de entorno
src/db.js              SQLite (node:sqlite) + repositorio
src/machine.js         máquina de estados + transiciones (1 pregunta a la vez)
src/llm.js             cliente Mistral, salida JSON estricto
src/prompts/index.js   los 6 prompts de sistema (uno por fase)
src/telegram.js        adaptador Telegram (long polling, cero deps)
src/index.js           arranque del bot
src/routines/runner.js idempotencia, jobs saved/confirmed, anti-duplicados
src/routines/ingest.js normalización del email entrante
scripts/smoke.mjs      demo completo del flujo sin claves ni red
tests/                 2 tests e2e con el caso de uso de emails de pedidos
```

## Correrlo local

1. Node ≥ 22.13 (`node --version`). No hay `npm install`: cero dependencias.
2. Creá un bot con [@BotFather](https://t.me/BotFather) y sacá el token.
3. Clave de Mistral: <https://console.mistral.ai>.
4. Variables de entorno:

```bash
cp .env.example .env
# editá .env con TELEGRAM_TOKEN y MISTRAL_API_KEY
npm start
```

5. Demo del flujo completo sin claves (formateador determinista local):

```bash
npm run smoke
```

6. Tests e2e (sin red ni claves):

```bash
npm test
```

### Ejemplo de conversación


```
tú:  cuando llegue un email de pedido con número de orden, guardarlo en una base y avisarme
bot: Meta reformulada en UNA frase: "…". ¿Es correcto? Di "sí, eso es" …
tú:  sí, eso es
bot: Fase 2/6 — process: hacé tu brain dump libre y desordenado …
…
bot: Fase 6/6 — review: { goal, process, rules, routine, next_step } — DEFAULT: propongo y espero.
tú:  sí
bot: Aprobado y activado. La ejecución automática corre SOLO para esta rutina aprobada.
```

Comandos: `/start` (nueva conversación), `/restate`, `/status`, `/skip`, `/mejorar` (análisis de mejoras de la fase improve), `/confirm`, `/routines`, `/routine <id|off>`, `/schedule <HH:MM|off>`, `/export [id]`, `/import {json}`, `/stats`, `/action <id> <url|off>`, `/runs`, `/prune [dias]` (purga jobs confirmados/fallidos viejos; los waiting jamás se borran), `/health` (estado de DB, poller y loops), `/gmail` (admin: OAuth asistido por chat para conectar casillas Gmail) y `/jobs` (lista de jobs con ambos timestamps).

### Ingesta de emails en v1

El conector real de email es v2. En v1, `Runner.ingestEmail(userId, email)` acepta el email
como objeto JSON (`from`, `messageId`, `orderNumber`) — así corren los tests e2e — y el runner
solo procesa si hay **rutina aprobada y activa** para ese usuario.

```js
import { openDb } from './src/db.js';
import { StateMachine } from './src/machine.js';
import { MistralFormatter } from './src/llm.js';
import { Runner } from './src/routines/runner.js';

const repo = openDb();
const machine = new StateMachine(repo, new MistralFormatter());
const jobs = new Runner(repo);

const { idempotencyKey } = jobs.ingestEmail(userId, {
  from: 'pedidos@tienda.com', messageId: '<abc@t.com>', orderNumber: 'ORD-1'
}); // → job 'waiting', saved_at set, confirmed_at null; re-intento → DuplicateJobError

jobs.confirmJob(userId, idempotencyKey, 'confirmado, revisé la orden'); // → 'confirmed' + confirmed_at
jobs.list(userId); // muestra saved_at y confirmed_at separados
```

## Desplegar

### Docker (VPS, Railway, Fly, Render)

```bash
docker build -t routine-bot .
docker run -d --name routine-bot \
  -e TELEGRAM_TOKEN=xx -e MISTRAL_API_KEY=xx \
  -v routine-bot-data:/app/data \
  routine-bot
```

El volumen persiste `data/routine-bot.db`; el polling es saliente, así que no hace falta
dominio ni TLS.

### Systemd (VPS con Node 22)


```bash
sudo tee /etc/routine-bot.env <<'ENV'
TELEGRAM_TOKEN=reemplazar
MISTRAL_API_KEY=reemplazar
ENV
sudo chmod 600 /etc/routine-bot.env

sudo tee /etc/systemd/system/routine-bot.service <<'UNIT'
[Unit]
Description=routine-bot (Telegram + Mistral)
After=network-online.target

[Service]
WorkingDirectory=/opt/routine-bot
EnvironmentFile=/etc/routine-bot.env
ExecStart=/usr/bin/node src/index.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl enable --now routine-bot
```

- Backup de la DB: con `BACKUP_DIR` definido, un loop diario corre `VACUUM INTO` a las `BACKUP_HHMM` (hora `TIMEZONE`) y conserva los `BACKUP_KEEP` más recientes. Alternativa manual: `sqlite3 data/routine-bot.db ".backup backup.db"` (cron).
- El loop de `getUpdates` ya reintenta con backoff ante fallos de red.

### Ingesta por email: IMAP y Gmail API

Dos conectores de ingesta conviven con el mismo contrato `IngestConnector` de v2:

- **IMAP**: cuentas en `IMAP_ACCOUNTS` (JSON con `host`, `user`, `pass`, `telegramId`).
- **Gmail API**: cuentas en `GMAIL_ACCOUNTS` (JSON con `clientId`, `clientSecret`, `refreshToken`, `telegramId`).
  REST puro cero deps: OAuth2 con refresh-token grant, query configurable (default `in:inbox is:unread`),
  y marca el mail como leído SOLO si lo guardó o ya era duplicado.

En ambos: cada email nuevo entra como job en `waiting` y se notifica por Telegram — nada se
confirma solo: `/confirm`.

Para obtener el `refreshToken` tenés dos caminos:

**Por chat (recomendado): mandá `/gmail` desde la cuenta que pongas en `ADMIN_TELEGRAM_ID`.** El bot
guía el flujo completo: le pasás el JSON del OAuth client (`{"clientId":"...","clientSecret":"..."}`),
te devuelve el link de consentimiento, pegás el `?code=` y listo — el token queda en la DB (tabla
`oauth_accounts`) y la ingesta arranca al instante, sin reiniciar. `/gmail status` muestra el estado
y `/gmail off <name>` desconecta una casilla.

**Push instantáneo (opcional):** además del polling, se puede conectar Pub/Sub en modo **pull**
(sin endpoint público): creá topic + suscripción PULL en GCP con rol publisher en el topic para
`gmail-api-push@system.gserviceaccount.com`, definí `GMAIL_WATCH_TOPIC` y
`GMAIL_PUBSUB_SUBSCRIPTION` y activá con `/gmail watch on` — el bot renueva `users.watch` solo
antes de vencer (~7 días) y, cuando llega una notificación, hace poll de esa casilla al instante.
Las casillas deben estar conectadas con el scope de Pub/Sub (relinkeá con `/gmail` si las
conectaste antes de esta versión).

**Manual (config):**

1. Google Cloud Console → credenciales → OAuth client (tipo Desktop) → `clientId`/`clientSecret`.
2. Abrí esta URL con tu clientId, aprobá, y copiá el `?code=` de la URL de redirect (que falla
   a `localhost:1` por diseño): `https://accounts.google.com/o/oauth2/v2/auth?client_id=CLIENT_ID&redirect_uri=http://localhost:1&response_type=code&scope=https://www.googleapis.com/auth/gmail.readonly&access_type=offline&prompt=consent`
3. Canjeá el code: `curl -s -X POST https://oauth2.googleapis.com/token -d client_id=CLIENT_ID -d client_secret=CLIENT_SECRET -d code=EL_CODE -d redirect_uri=http://localhost:1 -d grant_type=authorization_code`
4. Pegá el `refresh_token` que devuelve en `GMAIL_ACCOUNTS`.

## Roadmap

- v2 completa (M0–M4): fundaciones, IMAP, acciones webhook, voz con Voxtral, fase `improve` real,
  timezone y ops (backups, `/prune`, `/health`, multi-arch).
- Posibles siguientes pasos: librería OAuth de proveedor si se relaja cero deps.
- Implementado encima de v2: OAuth interactivo por chat (`/gmail`) y push de Gmail con Pub/Sub
  para ingest instantánea (modo pull, sin endpoint público).