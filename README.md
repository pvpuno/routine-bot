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

Comandos: `/start` (nueva conversación), `/restate`, `/status`, `/skip`, `/mejorar` (análisis de mejoras de la fase improve), `/confirm`, `/routines`, `/routine <id|off>`, `/schedule <HH:MM|off>`, `/export [id]`, `/import {json}`, `/stats`, `/action <id> <url|off>`, `/runs`, `/prune [dias]` (purga jobs confirmados/fallidos viejos; los waiting jamás se borran), `/health` (estado de DB, poller y loops) y `/jobs` (lista de jobs con ambos timestamps).

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

## Roadmap v2

- Voz en Telegram (transcripción) y conector de email real, que además habilita la fase `improve`.
- Panel de jobs en `waiting` para re-tomarlos; multi-rutina por usuario.