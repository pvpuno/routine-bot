import { TaskLoop } from './task-loop.js';
export class IngestConnector {
  name;

  constructor(name) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('IngestConnector requiere un name no vacío');
    }
    this.name = name;
  }

  async init(ctx) {}

  async poll() {
    throw new Error(`IngestConnector "${this.name}": poll() sin implementar`);
  }
}

export class ActionAdapter {
  name;

  constructor(name) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('ActionAdapter requiere un name no vacío');
    }
    this.name = name;
  }

  async deliver(job) {
    throw new Error(`ActionAdapter "${this.name}": deliver() sin implementar`);
  }
}

export class ConnectorRegistry {
  #adapters = new Map();

  register(connector) {
    const name = connector?.name;
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('El conector necesita un name no vacío');
    }
    if (this.#adapters.has(name)) {
      throw new Error(`Conector duplicado: ${name}`);
    }
    this.#adapters.set(name, connector);
    return connector;
  }

  get(name) {
    return this.#adapters.get(name) || null;
  }

  list() {
    return [...this.#adapters.keys()];
  }
}

export class IngestLoop extends TaskLoop {
  #ingesters;

  constructor({ ingesters = [], logger = console, tickMs = 60000 } = {}) {
    super({ logger, tickMs });
    this.#ingesters = ingesters;
  }

  get loopName() {
    return 'ingest';
  }

  async runOnce() {
    const results = [];
    for (const ingester of this.#ingesters) {
      try {
        results.push(await ingester.poll());
      } catch (err) {
        this.logError(`[${ingester.name}] ${err.message}`);
      }
    }
    return results;
  }
}
