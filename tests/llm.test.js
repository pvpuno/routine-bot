import test from 'node:test';
import assert from 'node:assert/strict';
import { MistralFormatter, LlmError } from '../src/llm.js';

function okJson(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] })
  };
}

async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return stub(calls.length);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const RULES = [{ kind: 'conflict', text: 'gana el sistema' }];


test('llm: normaliza shapes incorrectos de structureProcess y buildRoutine', async () => {
  const f = new MistralFormatter('key-test');

  await withFetch(
    () => okJson({ steps: 'extraer el número', watch_outs: null, tools: ['gmail'], check_work: '', info_from: 'el email', feedback_from: undefined }),
    async () => {
      const s = await f.structureProcess('dump', 'meta');
      assert.deepEqual(s.steps, ['extraer el número'], 'un string suelto se envuelve en array');
      assert.deepEqual(s.watch_outs, [], 'null se vuelve array vacío');
      assert.deepEqual(s.tools, ['gmail']);
      assert.deepEqual(s.check_work, []);
      assert.deepEqual(s.info_from, ['el email']);
      assert.deepEqual(s.feedback_from, []);
    }
  );

  await withFetch(
    () => okJson({ trigger: 'Llega email de pedido', action: 'guardar la orden', idempotency_key_rule: 'sha256(from|id)' }),
    async () => {
      const r = await f.buildRoutine('meta', 'proceso', RULES);
      assert.equal(r.trigger, 'Llega email de pedido');
      assert.deepEqual(r.action, ['guardar la orden'], 'acción en string se envuelve en array');
      assert.deepEqual(r.applied_rules, []);
    }
  );
});

test('llm: extractExamples conserva objetos y descarta ejemplos sin texto', async () => {
  const f = new MistralFormatter('key-test');

  await withFetch(
    () => okJson({
      examples: [
        { text: 'pedido 0031 salió bien', failed: false, lesson: '' },
        { text: 'se reenvió el correo y casi duplico', failed: 'true', lesson: 'clave única por email' },
        { lesson: 'sin texto no sirve' }
      ]
    }),
    async () => {
      const { examples } = await f.extractExamples('blah');
      assert.equal(examples.length, 2, 'el ejemplo sin text se descarta');
      assert.equal(examples[0].failed, false);
      assert.equal(examples[1].failed, true, 'failed en string "true" se interpreta como true');
      assert.equal(examples[1].lesson, 'clave única por email');
    }
  );
});


test('llm: restateGoal sin "restated" lanza LlmError con mensaje claro', async () => {
  const f = new MistralFormatter('key-test');
  await withFetch(
    () => okJson({ assumptions: ['sin datos'] }),
    async () => {
      await assert.rejects(() => f.restateGoal('meta'), LlmError);
    }
  );
});

test('llm: reintenta ante 429/5xx y responde cuando la API se recupera; falla tras agotar reintentos', async () => {
  const f = new MistralFormatter('key-test');

  const { restated } = await withFetch(
    (call) => (call <= 2 ? { ok: false, status: 503, text: async () => 'upstream' } : okJson({ restated: 'meta clara' })),
    async () => f.restateGoal('meta')
  );
  assert.equal(restated, 'meta clara');

  await withFetch(
    () => ({ ok: false, status: 429, text: async () => 'rate limited' }),
    async () => {
      await assert.rejects(() => f.restateGoal('meta'), /HTTP 429 tras/);
    }
  );
});

test('llm: respuesta que no es JSON lanza LlmError', async () => {
  const f = new MistralFormatter('key-test');
  await withFetch(
    () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'no soy json' } }] }) }),
    async () => {
      await assert.rejects(() => f.ruleFromAnswer('saved', 'x'), LlmError);
    }
  );
});