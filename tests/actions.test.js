import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionError,
  ActionDispatcher,
  WebhookAdapter,
  assertPublicHttpUrl,
  isPrivateIp,
  parseActionConfig
} from '../src/actions.js';
import { ConnectorRegistry } from '../src/connectors.js';
import { approvedFlow, EMAIL_PEDIDO, setup } from './helpers.js';

test('actions: isPrivateIp reconoce rangos privados y loopback', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.1.1',
    '0.0.0.0',
    '100.64.0.1',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    'fe80::1',
    'fc00::1',
    'fd12::abcd'
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} debe ser privado`);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '2001:4860::8888']) {
    assert.equal(isPrivateIp(ip), false, `${ip} debe ser público`);
  }
});

test('actions: assertPublicHttpUrl valida esquema, resolución y blanco privado', async () => {
  await assert.rejects(() => assertPublicHttpUrl('no-es-url'), /URL inválida/);
  await assert.rejects(() => assertPublicHttpUrl('ftp://h.com/x'), /http/);

  const privateResolve = async () => ['127.0.0.1'];
  await assert.rejects(() => assertPublicHttpUrl('http://localhost/hook', { resolve: privateResolve }), /IP privada/);

  const dnsFail = async () => {
    throw new Error('ENOTFOUND');
  };
  await assert.rejects(() => assertPublicHttpUrl('https://norealhost.tld/x', { resolve: dnsFail }), /ENOTFOUND/);

  const ok = await assertPublicHttpUrl('https://api.tienda.com/hook', {
    resolve: async () => ['8.8.8.8']
  });
  assert.equal(ok.hostname, 'api.tienda.com');

  const allowed = await assertPublicHttpUrl('http://192.168.1.5:3000/hook', {
    allowPrivate: true,
    resolve: privateResolve
  });
  assert.equal(String(allowed), 'http://192.168.1.5:3000/hook');
});

test('actions: parseActionConfig acepta objeto o JSON y rechaza basura', () => {
  assert.equal(parseActionConfig(null), null);
  assert.equal(parseActionConfig(''), null);
  assert.deepEqual(parseActionConfig('{"type":"webhook","url":"https://a.b/c"}'), {
    type: 'webhook',
    url: 'https://a.b/c',
    headers: {}
  });
  assert.throws(() => parseActionConfig('{no-json'), /JSON válido/);
  assert.throws(() => parseActionConfig('{"type":"webhook"}'), /necesita \{ type, url \}/);
  assert.throws(() => parseActionConfig('{"type":"zapier","url":"https://a.b"}'), /desconocido/);
  assert.throws(() => parseActionConfig('{"type":"webhook","url":"file:///etc/passwd"}'), /http/);
});

test('actions: WebhookAdapter POSTea el payload y falla claro con HTTP 500', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return new Response('{"received":true}', { status: 200 });
  };
  const adapter = new WebhookAdapter({
    fetchImpl,
    resolve: async () => ['8.8.8.8']
  });

  const result = await adapter.deliver(
    { id: 3, routine_id: 1, idempotency_key: 'k'.repeat(64), status: 'confirmed', confirmed_at: '2026-11-22T10:00:00Z', payload: '{"orderNumber":"ORD-1"}' },
    { type: 'webhook', url: 'https://api.tienda.com/hook' }
  );
  assert.deepEqual(result, { httpStatus: 200, body: '{"received":true}' });
  assert.equal(calls.length, 1);
  const sent = JSON.parse(calls[0].opts.body);
  assert.equal(sent.job_id, 3);
  assert.equal(sent.idempotency_key, 'k'.repeat(64));
  assert.equal(sent.data.orderNumber, 'ORD-1');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.redirect, 'manual');
  assert.equal(calls[0].opts.headers['content-type'], 'application/json');

  const failing = new WebhookAdapter({
    fetchImpl: async () => new Response('boom', { status: 500 }),
    resolve: async () => ['8.8.8.8']
  });
  await assert.rejects(() => failing.deliver({ id: 1, payload: '{}' }, { type: 'webhook', url: 'https://a.b/c' }), (err) => {
    assert.ok(err instanceof ActionError);
    assert.equal(err.httpStatus, 500);
    return true;
  });
});

test('actions: WebhookAdapter bloquea SSRF antes de fetch y recorta la respuesta', async () => {
  let fetchCalled = 0;
  const adapter = new WebhookAdapter({
    fetchImpl: async () => {
      fetchCalled++;
      return new Response('ok', { status: 200 });
    },
    resolve: async () => ['10.0.0.5']
  });
  await assert.rejects(() => adapter.deliver({ id: 1, payload: '{}' }, { type: 'webhook', url: 'http://intranet.local/hook' }), /IP privada/);
  assert.equal(fetchCalled, 0);

  const truncating = new WebhookAdapter({
    fetchImpl: async () => new Response('y'.repeat(50000), { status: 200 }),
    resolve: async () => ['8.8.8.8'],
    maxBytes: 4096
  });
  const out = await truncating.deliver({ id: 1, payload: '{}' }, { type: 'webhook', url: 'https://a.b/c' });
  assert.equal(out.body.length, 200);
});

test('actions: ActionDispatcher registra runs de éxito, error y ausencia de adapter', async () => {
  const { repo, machine } = setup();
  await approvedFlow(machine, 'user-z');
  const routine = repo.activeRoutine('user-z');
  const registry = new ConnectorRegistry();
  let httpStatus = 200;
  registry.register(new WebhookAdapter({
    fetchImpl: async () => new Response('ok', { status: httpStatus }),
    resolve: async () => ['8.8.8.8']
  }));
  const dispatcher = new ActionDispatcher({ repo, registry, logger: { error: () => {} } });

  const job = repo.insertJob(
    routine,
    'user-z',
    'k'.repeat(64),
    { orderNumber: 'ORD-9' }
  );
  repo.setRoutineActionConfig(routine.id, { type: 'webhook', url: 'https://api.tienda.com/hook' });

  assert.equal(await dispatcher.dispatchConfirmed({ id: job.id }), null, 'job sin confirmar no dispara acción');

  repo.confirmJob(job.id, 'revisión personal');
  const okRes = await dispatcher.dispatchConfirmed(repo.job(job.id));
  assert.equal(okRes.ok, true);
  assert.equal(okRes.httpStatus, 200);
  const runs = repo.actionRunsFor('user-z');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'ok');
  assert.equal(runs[0].http_status, 200);

  assert.equal(await dispatcher.dispatchConfirmed(repo.job(job.id)), null, 'un job ya ejecutado con éxito no se re-dispara');
  assert.equal(repo.actionRunsFor('user-z').length, 1);

  httpStatus = 500;
  const job2 = repo.insertJob(routine, 'user-z', 'l'.repeat(64), {});
  repo.confirmJob(job2.id, 'revisión');
  const failRes = await dispatcher.dispatchConfirmed(repo.job(job2.id));
  assert.equal(failRes.ok, false);
  assert.equal(failRes.httpStatus, 500);
  assert.equal(repo.actionRunsFor('user-z')[0].status, 'http_error');

  const job3 = repo.insertJob(routine, 'user-z', 'm'.repeat(64), {});
  repo.confirmJob(job3.id, 'revisión');
  const dispatcherSinAdapter = new ActionDispatcher({ repo, registry: new ConnectorRegistry() });
  const noAdapter = await dispatcherSinAdapter.dispatchConfirmed(repo.job(job3.id));
  assert.equal(noAdapter.ok, false);
  assert.match(noAdapter.error, /no hay adapter registrado/);
});

test('actions: dispatcher sin acción configurada es un no-op transparente', async () => {
  const { repo, machine } = setup();
  await approvedFlow(machine, 'u');
  const routine = repo.activeRoutine('u');
  const dispatcher = new ActionDispatcher({ repo, registry: new ConnectorRegistry() });
  const job = repo.insertJob(routine, 'u', 'k'.repeat(64), {});
  repo.confirmJob(job.id, 'ok');
  assert.equal(await dispatcher.dispatchConfirmed(repo.job(job.id)), null);
  assert.equal(repo.actionRunsFor('u').length, 0);
});

test('machine: /action y /runs — la acción webhook corre solo tras el /confirm del usuario', async () => {
  const { repo, machine, runner } = setup();
  const calls = [];
  const registry = new ConnectorRegistry();
  registry.register(new WebhookAdapter({
    fetchImpl: async (url, opts) => {
      calls.push({ url: String(url), body: JSON.parse(opts.body) });
      return new Response('ok', { status: 200 });
    },
    resolve: async () => ['9.9.9.9']
  }));
  const machineWithActions = await import('../src/machine.js').then((m) => m.StateMachine);
  const actions = new ActionDispatcher({ repo, registry, logger: { error: () => {} } });
  const m2 = new machineWithActions(repo, (await import('./helpers.js')).StubFormatter(), runner, actions);

  await approvedFlow(m2, '42');
  const routine = repo.activeRoutine('42');
  assert.ok(routine, 'rutina activa del flujo aprobado');

  const noArgs = await m2.handle('42', '/action');
  assert.match(noArgs.reply, /no tiene acción configurada/);

  const set = await m2.handle('42', `/action ${routine.id} https://api.tienda.com/hook`);
  assert.match(set.reply, /Acción configurada/);
  const storedCfg = JSON.parse(repo.routine(routine.id).action_config);
  assert.deepEqual(storedCfg, { type: 'webhook', url: 'https://api.tienda.com/hook' });
  assert.deepEqual(parseActionConfig(storedCfg), { ...storedCfg, headers: {} });

  const blocked = await m2.handle('42', `/action ${routine.id} http://127.0.0.1/hook`);
  assert.match(blocked.reply, /URL rechazada/);
  assert.match(blocked.reply, /IP privada/);

  runner.ingestEmail('42', { ...EMAIL_PEDIDO, messageId: '<ACTION-1@x.com>' });
  const start = await m2.handle('42', '/confirm');
  assert.match(start.reply, /Job pendiente/);
  assert.equal(calls.length, 0, 'antes del "sí" no hay ningún POST');

  const afirmation = await m2.handle('42', 'sí');
  assert.match(afirmation.reply, /Acción webhook ejecutada → HTTP 200/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.tienda.com/hook');
  assert.equal(calls[0].body.idempotency_key, runner.list('42').find((j) => j.data.messageId === '<ACTION-1@x.com>')?.idempotency_key ?? calls[0].body.idempotency_key);
  assert.equal(calls[0].body.status, 'confirmed');

  const runs = await m2.handle('42', '/runs');
  assert.match(runs.reply, /#1 job .* → webhook https:\/\/api\.tienda\.com\/hook → ok HTTP 200/);

  const runsEmptyUser = await m2.handle('otro-user', '/runs');
  assert.match(runsEmptyUser.reply, /No hay ejecuciones/);

  const off = await m2.handle('42', `/action ${routine.id} off`);
  assert.match(off.reply, /desconfigurada/);
  const afterOff = await m2.handle('42', '/action');
  assert.match(afterOff.reply, /no tiene acción configurada/);
});

test('machine: /action rechaza rutinas ajenas y /runs admite límite', async () => {
  const { repo, machine, runner } = setup();
  await approvedFlow(machine, '42');
  const routine = repo.activeRoutine('42');

  const ajena = await machine.handle('otro-user', `/action ${routine.id} https://a.b/c`);
  assert.match(ajena.reply, /No encuentro la rutina/);

  runner.ingestEmail('42', { ...EMAIL_PEDIDO, messageId: '<LIM-1@x.com>' });
  const key = runner.list('42').find((j) => j.status === 'waiting').idempotency_key;
  runner.confirmJob('42', key, 'ok');
  repo.insertActionRun(
    { jobId: runner.list('42').find((j) => j.idempotency_key === key).id, routineId: routine.id, userId: '42', adapter: 'webhook', target: 'https://a.b/c' }
  );
  const one = await machine.handle('42', '/runs 1');
  assert.match(one.reply, /→ webhook https:\/\/a\.b\/c → falló:/);
});
