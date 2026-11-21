import { openDb } from '../src/db.js';
import { StateMachine } from '../src/machine.js';
import { Runner, DuplicateJobError } from '../src/routines/runner.js';

export const EMAIL_FELIZ = {
  from: 'pedidos@tienda.com',
  messageId: '<CAFEBABE-001@mail.tienda.com>',
  orderNumber: 'ORD-2024-0042',
  subject: 'Tu pedido fue enviado 📦',
  body: 'Pedido ORD-2024-0042 a nombre de Ana, 2 items, total $84.00'
};


function DemoFormatter() {
  let exampleNgSeen = false;
  return {
    async restateGoal(text) {
      return { restated: `Cuando llegue un email de pedido con número de orden, guardarlo en una base y avisarme (${text.slice(0, 60)}…)` };
    },
    async structureProcess(brainDump) {
      return {
        steps: ['Detecto el email del pedido', 'Extraigo el número de orden', 'Lo guardo en la base', 'Aviso al canal'],
        watch_outs: ['emails sin número de orden', 'duplicados del mismo correo'],
        tools: ['Gmail', 'hoja de cálculo'],
        check_work: ['la orden aparece en la base con su número'],
        info_from: ['email de pedidos', 'sistema de órdenes'],
        feedback_from: ['yo mismo reviso la base']
      };
    },
    async ruleFromAnswer(kind, answer) {
      if (kind === 'confirmed' && /envi/i.test(answer)) {
        return { rule: `[${kind}] AVISO: "enviado" no cuenta como confirmación`, needs_followup: true, followup: '¿qué confirmación personal cuenta como done?' };
      }
      return { rule: `[${kind}] ${answer}`, needs_followup: false, followup: '' };
    },
    async extractExamples(answer) {
      exampleNgSeen = exampleNgSeen || /sal[ií]ó mal|fall[óo]/i.test(answer);
      return {
        examples: [
          { text: 'Pedido ORD-2024-0031 guardado y avisado', failed: false, lesson: '' },
          { text: 'Pedido ORD-2024-0038 guardado tras revisar la base', failed: false, lesson: '' },
          { text: 'Se reenvió el mismo correo y casi duplico el registro', failed: true, lesson: 'con hash de remitente + message-id nunca se duplica' }
        ]
      };
    },
    async buildRoutine() {
      return {
        trigger: 'Llega un email de pedidos con número de orden.',
        action: [
          'extraer número de orden y remitente',
          'guardar el registro (saved: si el número no existe aún)',
          'avisar al usuario en el chat'
        ],
        idempotency_key_rule: 'sha256(remitente_normalizado + message_id_del_email)',

        applied_rules: ['conflict: gana el número del sistema', 'waiting: re-consultar con la misma clave']
      };
    },
    async review() {
      return {
        process_vs_goal: 'El proceso cubre la meta, con el riesgo de duplicados ya cubierto por la clave.',
        better_way: '',
        next_step: 'Esperar y procesar el primer email de pedido; ejecutado solo con esta rutina aprobada.'
      };
    }
  };
}

export function setupBot() {
  const repo = openDb(':memory:');
  const machine = new StateMachine(repo, DemoFormatter());
  const runner = new Runner(repo);
  return { repo, machine, runner };
}


if (import.meta.url === `file://${process.argv[1]}`) {
  const { machine, runner, repo } = setupBot();
  const step = async (t) => {
    const out = await machine.handle('demo-user', t);
    console.log(`\n👤 ${t}\n🤖 ${out.reply}\n[phase: ${out.phase}]`);
    return out;
  };
  await step('/start');
  await step('quiero que cuando llegue un email de pedido con número de orden se guarde en una base y me avises');
  await step('sí, eso es');
  await step('reviso gmail, extraigo el número de orden, lo comparo con el sistema, lo anoto en la hoja y aviso en el canal; cómo sé que quedó bien: la orden aparece en la hoja; la info viene del email; el feedback lo doy yo');
  await step('sí');
  await step('gana el sistema de órdenes');
  await step('fila con número de orden único y monto correcto');
  await step('yo reviso la orden contra la base y doy yo la confirmación personal');
  await step('lo anoto como pendiente y lo re-consulto con la misma clave, sin duplicar');
  await step('el 0031 salió bien; el 0038 también; una vez falló: se reenvió el mismo correo y casi duplico el registro, aprendí a usar clave única');
  await step('sí');
  console.log('\n--- rutina activada (aprobada en review); inserto email de ejemplo ---');
  const r1 = runner.ingestEmail('demo-user', EMAIL_FELIZ);
  console.log(`job creado: status=${r1.job.status} saved_at=${r1.job.saved_at} key=${r1.idempotencyKey.slice(0, 12)}…`);
  try {
    runner.ingestEmail('demo-user', EMAIL_FELIZ);
    console.log('ERROR: no bloqueó duplicado');
  } catch (e) {
    if (e instanceof DuplicateJobError) console.log(`duplicado bloqueado OK: ${e.message}`);
    else throw e;
  }
  const c1 = runner.confirmJob('demo-user', r1.idempotencyKey, 'confirmado, la orden está en la base');
  console.log(`confirmado: status=${c1.job.status} confirmed_at=${c1.job.confirmed_at}`);
  repo.db.close();
}