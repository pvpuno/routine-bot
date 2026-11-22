import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedFlow, setup, EMAIL_PEDIDO } from './helpers.js';

function extractJson(reply) {
  const m = reply.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(m, 'el export incluye un bloque ```json```');
  return JSON.parse(m[1]);
}

function rulesOk(rules) {
  return rules.every((r) => typeof r.kind === 'string' && typeof r.text === 'string' && r.text.length > 0);
}

test('export: la rutina activa sale completa (routine, goal, process, rules) y parsea', async () => {
  const { repo, machine } = setup();
  await approvedFlow(machine, 'user-export');

  const out = await machine.handle('user-export', '/export');
  assert.match(out.reply, /\[id 1\]/);

  const exported = extractJson(out.reply);
  assert.equal(exported.version, 1);
  assert.equal(exported.routine.trigger, 'Llega un email de pedidos con número de orden.');
  assert.ok(Array.isArray(exported.routine.action) && exported.routine.action.length >= 2);
  assert.equal(exported.routine.schedule, null);
  assert.match(exported.routine.idempotency_key_rule, /sha256/);
  assert.ok(exported.goal && exported.goal.includes('número de orden'), 'la meta va incluida');
  assert.ok(exported.process.steps.length >= 3);
  const kinds = exported.rules.map((r) => r.kind);
  for (const kind of ['conflict', 'saved', 'confirmed', 'waiting', 'example', 'example_failed']) {
    assert.ok(kinds.includes(kind), `las rules incluyen ${kind}`);
  }
  assert.ok(rulesOk(exported.rules), 'cada regla tiene kind y text');
  repo.db.close();
});

test('export: con schedule incluido; por id propio sí y ajeno no', async () => {
  const { repo, machine } = setup();
  await approvedFlow(machine, 'user-owner');
  const routine = repo.activeRoutine('user-owner');
  repo.setRoutineSchedule(routine.id, '08:30');

  const withSchedule = await machine.handle('user-owner', '/export');
  assert.equal(extractJson(withSchedule.reply).routine.schedule, '08:30');

  const byId = await machine.handle('user-owner', `/export ${routine.id}`);
  assert.match(byId.reply, /```json/);

  const unknown = await machine.handle('user-owner', '/export 999');
  assert.match(unknown.reply, /No encuentro la rutina 999 que sea tuya/);

  const foreign = await machine.handle('user-other', `/export ${routine.id}`);
  assert.match(foreign.reply, /No encuentro la rutina/, 'el id ajeno no exporta nada');

  const missing = await machine.handle('user-other', '/export');
  assert.match(missing.reply, /No hay rutina activa para exportar/);
  repo.db.close();
});

test('import: el JSON de otro usuario crea una rutina propia e inactiva (el sí sigue mandando)', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, 'user-source');
  const out = await machine.handle('user-source', '/export');
  const json = extractJson(out.reply);

  const sourceIntake = runner.ingestEmail('user-source', { ...EMAIL_PEDIDO });
  assert.equal(sourceIntake.routine_id, repo.activeRoutine('user-source').id);
  runner.confirmJob('user-source', sourceIntake.idempotencyKey, 'confirmado, la orden está en la base');

  const imported = await machine.handle('user-target', `/import ${JSON.stringify(json)}`);
  assert.match(imported.reply, /\[id 2\]/, 'nuevo id propio del usuario que importa');
  assert.match(imported.reply, /INACTIVA/);
  assert.match(imported.reply, /\/routine 2/);

  const routinesTarget = repo.routinesFor('user-target');
  assert.equal(routinesTarget.length, 1);
  assert.equal(routinesTarget[0].active, 0, 'importada queda inactiva: nada se ejecuta sin aprobación');
  assert.equal(routinesTarget[0].idempotency_key_rule, json.routine.idempotency_key_rule);
  assert.equal(routinesTarget[0].schedule, json.routine.schedule, 'el schedule viaja');
  assert.throws(() => runner.ingestEmail('user-target', { ...EMAIL_PEDIDO }),
    (e) => e.code === 'no_active_routine', 'hasta activarla, no ingiere nada');

  await machine.handle('user-target', '/routine 2');
  const intake = runner.ingestEmail('user-target', { ...EMAIL_PEDIDO });
  assert.equal(intake.routine_id, 2);
  assert.equal(runner.list('user-target').length, 1);
  const sourceJobs = runner.list('user-source');
  assert.equal(sourceJobs.length, 1, 'los jobs del origen no se tocan');
  assert.equal(sourceJobs[0].status, 'confirmed');

  const outTarget = await machine.handle('user-target', '/export');
  const reexported = extractJson(outTarget.reply);
  assert.deepEqual(reexported.routine.action, json.routine.action);
  assert.deepEqual(reexported.rules, [], 'las rules no viajan con la importación: arranca limpia');
  repo.db.close();
});

test('import: JSON cortado, con faltantes o schedule inválido da errores accionables', async () => {
  const { repo, machine } = setup();

  const usage = await machine.handle('user-x', '/import');
  assert.match(usage.reply, /Pegame el JSON después de \/import/);

  const broken = await machine.handle('user-x', '/import {"version": 1, "routine": {"trigger": "cort');
  assert.match(broken.reply, /No pude parsear el JSON/);

  const empty = await machine.handle('user-x', '/import {}');
  assert.match(empty.reply, /trigger, idempotency_key_rule/);

  const noAction = await machine.handle('user-x', '/import {"version":1, "routine":{"trigger":"t","idempotency_key_rule":"k"}}');
  assert.match(noAction.reply, /action/);

  const badSchedule = await machine.handle('user-x', '/import {"version":1,"routine":{"trigger":"t","action":["a"],"idempotency_key_rule":"k","schedule":"25:00"}}');
  assert.match(badSchedule.reply, /schedule inválido/);
  assert.equal(repo.routinesFor('user-x').length, 0, 'nada malo termina guardado');

  const flat = await machine.handle('user-x', '/import {"trigger":"t","action":["a"],"idempotency_key_rule":"k2"}');
  assert.match(flat.reply, /\[id 1\]/, 'tolera el formato plano sin wrapper');
  repo.db.close();
});
