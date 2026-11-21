import { openDb } from '../src/db.js';
import { StateMachine } from '../src/machine.js';
import { Runner } from '../src/routines/runner.js';


export function StubFormatter() {
  return {
    async restateGoal(text) {
      const clean = text.replace(/\s+/g, ' ').trim();
      return { restated: `META(<${clean.slice(0, 80)}>): cuando llegue un email de pedido con número de orden, guardarlo y avisar` };
    },
    async structureProcess(brainDump) {
      return {
        steps: [`(del brain dump) ${brainDump.slice(0, 60)}…`, 'extraer número de orden', 'guardar en la base', 'avisar'],
        watch_outs: ['duplicados', 'email sin número de orden'],
        tools: ['gmail', 'sistema de órdenes'],
        check_work: ['la orden aparece en la base'],
        info_from: ['email de pedidos'],
        feedback_from: ['yo reviso la base']
      };
    },
    async ruleFromAnswer(kind, answer) {
      return { rule: `[${kind}] ${answer}`, needs_followup: false, followup: '' };
    },
    async extractExamples(answer) {
      return {
        examples: [
          { text: 'pedido 0031 salió bien', failed: false, lesson: '' },
          { text: 'pedido 0038 salió bien', failed: false, lesson: '' },
          { text: 'se reenvió el correo y casi duplico', failed: true, lesson: 'clave única por email' }
        ]
      };
    },
    async buildRoutine() {
      return {
        trigger: 'Llega un email de pedidos con número de orden.',
        action: ['extraer número de orden', 'guardar el registro', 'avisar al usuario'],
        idempotency_key_rule: 'sha256(remitente_normalizado + message_id_del_email)'
      };
    },
    async review() {
      return {
        process_vs_goal: 'El proceso tal como está alcanza la meta.',
        better_way: '',
        next_step: 'Esperar el primer email de pedido y ejecutar solo esta rutina aprobada.'
      };
    }
  };
}

export function setup() {
  const repo = openDb(':memory:');
  const machine = new StateMachine(repo, StubFormatter());
  const runner = new Runner(repo);
  return { repo, machine, runner };
}


export async function approvedFlow(machine, userId = 'test-user') {
  const say = (t) => machine.handle(userId, t);
  await say('/start');
  await say('quiero que cuando llegue un email de pedido con número de orden se guarde en una base y me avises');
  await say('sí, eso es');
  await say('reviso gmail, extraigo el número de orden, lo comparo con el sistema, lo anoto y aviso en el canal');
  await say('sí');
  await say('gana el número del sistema de órdenes');
  await say('la fila existe con número de orden único y monto correcto');
  await say('yo reviso personalmente la orden contra la base antes de darla por confirmada');
  await say('lo dejo anotado como pendiente y lo re-consulto con la misma clave sin duplicar');
  await say('el 0031 salió bien; el 0038 también; una vez falló: se reenvió el mismo correo y casi dupliqué el registro, aprendí a usar clave única');
  return say('sí');
}

export const EMAIL_PEDIDO = {
  from: 'pedidos@tienda.com',
  messageId: '<CAFEBABE-001@mail.tienda.com>',
  orderNumber: 'ORD-2024-0042',
  subject: 'Confirmación de pedido',
  body: 'Pedido ORD-2024-0042, 2 items.'
};