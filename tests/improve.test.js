import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedFlow, setup, StubFormatter } from './helpers.js';
import { StateMachine } from '../src/machine.js';
import { Runner } from '../src/routines/runner.js';

function formatterWithImprove(extra = {}) {
  const base = StubFormatter();
  return {
    ...base,
    improve: async () => ({
      assessment: 'El proceso es razonable pero manual.',
      idea: 'agregar verificación del número de orden contra la base antes de avisar',
      effort: 'bajo'
    }),
    ...extra
  };
}

async function machineWithImprove() {
  const { repo, runner } = setup();
  const machine = new StateMachine(repo, formatterWithImprove(), runner);
  const poller = { sent: [], async sendMessage(chatId, text) { this.sent.push({ chatId, text }); } };
  const userId = '42';
  await approvedFlow(machine, userId);
  const oldRoutineId = repo.activeRoutine(userId).id;
  return { repo, machine, runner, poller, userId, oldRoutineId };
}

test('mejorar: /mejorar consulta el LLM y propone la mejora sin tocar la rutina', async () => {
  const { repo, machine, userId, oldRoutineId } = await machineWithImprove();

  const reply = await machine.handle(userId, '/mejorar');
  assert.match(reply.reply, /El proceso es razonable pero manual/);
  assert.match(reply.reply, /agregar verificación del número de orden/);
  assert.match(reply.reply, /esfuerzo: bajo/);

  assert.equal(repo.activeRoutine(userId).id, oldRoutineId, 'nada se activa ni cambia al sugerir');
  assert.equal(repo.routinesFor(userId).length, 1, 'no se creó rutina nueva todavía');
});

test('mejorar: al aceptar, la rutina con la mejora se propone en review y NADA se activa solo', async () => {
  const { repo, machine, userId, oldRoutineId } = await machineWithImprove();
  await machine.handle(userId, '/mejorar');

  const propuesta = await machine.handle(userId, 'sí');
  assert.equal(propuesta.phase, 'review');
  assert.match(propuesta.reply, /Propongo esta rutina/);
  assert.match(propuesta.reply, /mejora aplicada: agregar verificación/);

  const routines = repo.routinesFor(userId);
  assert.equal(routines.length, 2);
  assert.equal(repo.activeRoutine(userId).id, oldRoutineId, 'la vieja sigue activa hasta aprobar la nueva');

  const aprobacion = await machine.handle(userId, 'sí');
  assert.equal(aprobacion.phase, 'done');
  assert.ok(aprobacion.reply.includes('activada'));

  const routines2 = repo.routinesFor(userId);
  const active = repo.activeRoutine(userId);
  assert.notEqual(active.id, oldRoutineId, 'la nueva rutina reemplaza a la vieja');
  assert.equal(routines2.find((r) => r.id === oldRoutineId).active, 0, 'solo queda UNA activa');
});

test('mejorar: seguir el flujo con texto libre re-estructura el proceso; "no" y "cancelar" salen limpios', async () => {
  const { repo, machine, userId } = await machineWithImprove();
  await machine.handle(userId, '/mejorar');

  const corregido = await machine.handle(userId, 'yo reviso primero el sistema de órdenes y después anoto');
  assert.equal(corregido.phase, 'review');
  assert.match(corregido.reply, /Propongo esta rutina/);
  const machine2 = await machineWithImprove();
  await machine2.machine.handle(machine2.userId, '/mejorar');
  const no = await machine2.machine.handle(machine2.userId, 'no');
  assert.equal(no.phase, 'review', '"no" arma la rutina como estaba, en review');

  const machine3 = await machineWithImprove();
  await machine3.machine.handle(machine3.userId, '/mejorar');
  const cancel = await machine3.machine.handle(machine3.userId, 'cancelar');
  assert.match(cancel.reply, /Cancelado/);
  assert.equal(machine3.repo.activeRoutine(machine3.userId).id, machine3.oldRoutineId);
});

test('mejorar: en fase improve basta escribir "mejorar", y /skip arma la rutina sin análisis', async () => {
  const machine1 = await machineWithImprove();
  const conv = machine1.repo.conversation(machine1.userId);
  machine1.repo.saveContext(conv, conv.ctx, 'improve');

  const improve = await machine1.machine.handle(machine1.userId, 'mejorar');
  assert.equal(improve.phase, 'improve');
  assert.match(improve.reply, /mejora propuesta/);
  assert.match(improve.reply, /esfuerzo: bajo/);

  const machine2 = await machineWithImprove();
  const conv2 = machine2.repo.conversation(machine2.userId);
  machine2.repo.saveContext(conv2, conv2.ctx, 'improve');
  const skip = await machine2.machine.handle(machine2.userId, '/skip');
  assert.equal(skip.phase, 'review');
  assert.match(skip.reply, /Propongo esta rutina/);
});

test('mejorar: con formatter sin improve(), /mejorar avisa y no rompe el flujo', async () => {
  const { repo, machine } = setup();
  await approvedFlow(machine, '42');

  const reply = await machine.handle('42', '/mejorar');
  assert.match(reply.reply, /no está disponible/);
  assert.ok(repo.routinesFor('42').length >= 1);
  assert.ok(await machine.handle('42', '/status'), 'la máquina sigue funcionando');
});
