import test from 'node:test';
import assert from 'node:assert/strict';
import { IngestConnector, ActionAdapter, ConnectorRegistry } from '../src/connectors.js';

test('conectores: los contratos base rechazan nombres vacíos y llamadas sin implementar', async () => {
  assert.throws(() => new IngestConnector(''), /requiere un name/);
  assert.throws(() => new IngestConnector('   '), /requiere un name/);
  assert.throws(() => new ActionAdapter(null), /requiere un name/);

  const ingest = new IngestConnector('gmail');
  await assert.rejects(() => ingest.poll(), /poll\(\) sin implementar/);
  const action = new ActionAdapter('webhook');
  await assert.rejects(() => action.deliver({ id: 1 }), /deliver\(\) sin implementar/);

  await ingest.init({ repo: {} });
  await action.deliver;
});

test('ConnectorRegistry: registra, devuelve y lista por name', () => {
  const registry = new ConnectorRegistry();
  const ingest = new IngestConnector('gmail');
  const action = new ActionAdapter('webhook');

  registry.register(ingest);
  registry.register(action);

  assert.equal(registry.get('gmail'), ingest);
  assert.equal(registry.get('webhook'), action);
  assert.equal(registry.get('noexiste'), null);
  assert.deepEqual(registry.list(), ['gmail', 'webhook']);
});

test('ConnectorRegistry: rechaza duplicados y conectores sin name válido', () => {
  const registry = new ConnectorRegistry();
  registry.register(new IngestConnector('gmail'));

  assert.throws(() => registry.register(new IngestConnector('gmail')), /Conector duplicado: gmail/);
  assert.throws(() => registry.register(new IngestConnector('')), /name no vacío/);
  assert.throws(() => registry.register({ name: '' }), /name no vacío/);
  assert.throws(() => registry.register(null), /name no vacío/);
});

test('contratos: una subclase concreta hereda y sobreescribe sin fricción', async () => {
  class GmailIngest extends IngestConnector {
    async poll() {
      return [{ from: 'a@b.co', subject: 'Pedido' }];
    }
  }

  const gmail = new GmailIngest('gmail');
  assert.equal(gmail.name, 'gmail');
  await gmail.init({});
  assert.deepEqual(await gmail.poll(), [{ from: 'a@b.co', subject: 'Pedido' }]);

  const registry = new ConnectorRegistry();
  registry.register(gmail);
  assert.equal(registry.get('gmail'), gmail);
});
