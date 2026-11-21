import { config } from './config.js';
import {
  GOAL_SYSTEM, PROCESS_SYSTEM, CLARIFY_RULE_SYSTEM, CLARIFY_EXAMPLES_SYSTEM,
  ROUTINES_SYSTEM, REVIEW_SYSTEM
} from './prompts/index.js';

export class LlmError extends Error {}

export class MistralFormatter {
  #headers;

  constructor(apiKey = config.MISTRAL_API_KEY, model = config.MISTRAL_MODEL) {
    if (!apiKey) {
      throw new LlmError(
        'Falta MISTRAL_API_KEY. Copia .env.example a .env, exporta la variable, o usa MODE=smoke.'
      );
    }
    this.model = model;
    this.#headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    };
  }

  async #chat(system, user) {
    const res = await fetch(`${config.MISTRAL_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: this.#headers,
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      })
    });
    if (!res.ok) {
      throw new LlmError(`Mistral API HTTP ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    try {
      return JSON.parse(text);
    } catch {
      throw new LlmError(`La respuesta no es JSON válido: ${text.slice(0, 200)}`);
    }
  }

  restateGoal(text) {
    return this.#chat(GOAL_SYSTEM, text);
  }

  structureProcess(text, goalText) {
    return this.#chat(PROCESS_SYSTEM, `META: ${goalText}\n\nBRAIN DUMP:\n${text}`);
  }

  ruleFromAnswer(kind, answer) {
    return this.#chat(CLARIFY_RULE_SYSTEM, `TIPO DE REGLA: ${kind}\nRESPUESTA DEL USUARIO: ${answer}`);
  }

  extractExamples(answer) {
    return this.#chat(CLARIFY_EXAMPLES_SYSTEM, answer);
  }


  buildRoutine(goalText, processSummary, rules) {
    return this.#chat(
      ROUTINES_SYSTEM,
      `META: ${goalText}\n\nPROCESO:\n${processSummary}\n\nREGLAS:\n${rules.map((r) => `- [${r.kind}] ${r.text}`).join('\n')}`
    );
  }

  review(goalText, processSummary, routine) {
    return this.#chat(
      REVIEW_SYSTEM,
      `META: ${goalText}\n\nPROCESO:\n${processSummary}\n\nRUTINA:\n${JSON.stringify(routine, null, 2)}`
    );
  }
}