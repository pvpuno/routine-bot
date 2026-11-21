import { config } from './config.js';
import {
  GOAL_SYSTEM, PROCESS_SYSTEM, CLARIFY_RULE_SYSTEM, CLARIFY_EXAMPLES_SYSTEM,
  ROUTINES_SYSTEM, REVIEW_SYSTEM
} from './prompts/index.js';

export class LlmError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const asString = (v, fallback = '') =>
  typeof v === 'string' ? v.trim() : v == null || v === '' ? fallback : String(v).trim();

const asStringArray = (v) => {
  if (Array.isArray(v)) return v.map((x) => asString(x)).filter((s) => s.length > 0);
  const single = asString(v);
  return single ? [single] : [];
};

const asBool = (v) => v === true || v === 'true';

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
    const maxRetries = config.MISTRAL_RETRIES;
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await fetch(`${config.MISTRAL_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: this.#headers,
          signal: AbortSignal.timeout(config.MISTRAL_TIMEOUT_MS),
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
      } catch (err) {
        if (attempt < maxRetries) {
          attempt += 1;
          await sleep(1000 * attempt);
          continue;
        }
        throw new LlmError(`Mistral API no respondió tras ${attempt + 1} intentos: ${err.message}`);
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < maxRetries) {
          attempt += 1;
          await sleep(1000 * attempt);
          continue;
        }
        throw new LlmError(`Mistral API HTTP ${res.status} tras ${attempt + 1} intentos.`);
      }
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
  }

  async restateGoal(text) {
    const out = await this.#chat(GOAL_SYSTEM, text);
    const restated = asString(out.restated);
    if (!restated) {
      throw new LlmError('La respuesta del LLM no incluyó "restated" (la meta reformulada).');
    }
    return { restated, assumptions: asStringArray(out.assumptions) };
  }


  async structureProcess(text, goalText) {
    const out = await this.#chat(PROCESS_SYSTEM, `META: ${goalText}\n\nBRAIN DUMP:\n${text}`);
    return {
      steps: asStringArray(out.steps),
      watch_outs: asStringArray(out.watch_outs),
      tools: asStringArray(out.tools),
      check_work: asStringArray(out.check_work),
      info_from: asStringArray(out.info_from),
      feedback_from: asStringArray(out.feedback_from)
    };
  }

  async ruleFromAnswer(kind, answer) {
    const out = await this.#chat(CLARIFY_RULE_SYSTEM, `TIPO DE REGLA: ${kind}\nRESPUESTA DEL USUARIO: ${answer}`);
    const rule = asString(out.rule);
    const followup = asString(out.followup);
    return {
      rule,
      needs_followup: asBool(out.needs_followup) && followup.length > 0,
      followup
    };
  }

  async extractExamples(answer) {
    const out = await this.#chat(CLARIFY_EXAMPLES_SYSTEM, answer);
    const raw = Array.isArray(out.examples) ? out.examples : out.examples ? [out.examples] : [];
    const examples = raw
      .filter((e) => e && typeof e === 'object' && asString(e.text).length > 0)
      .map((e) => ({ text: asString(e.text), failed: asBool(e.failed), lesson: asString(e.lesson) }));
    return { examples };
  }

  async buildRoutine(goalText, processSummary, rules) {
    const out = await this.#chat(
      ROUTINES_SYSTEM,
      `META: ${goalText}\n\nPROCESO:\n${processSummary}\n\nREGLAS:\n${rules.map((r) => `- [${r.kind}] ${r.text}`).join('\n')}`
    );
    const trigger = asString(out.trigger);
    const idempotency_key_rule = asString(out.idempotency_key_rule);
    if (!trigger || !idempotency_key_rule) {
      throw new LlmError('La respuesta del LLM no incluyó "trigger" e "idempotency_key_rule" de la rutina.');
    }
    return {
      trigger,
      action: asStringArray(out.action),
      idempotency_key_rule,
      applied_rules: asStringArray(out.applied_rules)
    };
  }


  async review(goalText, processSummary, routine) {
    const out = await this.#chat(
      REVIEW_SYSTEM,
      `META: ${goalText}\n\nPROCESO:\n${processSummary}\n\nRUTINA:\n${JSON.stringify(routine, null, 2)}`
    );
    return {
      process_vs_goal: asString(out.process_vs_goal),
      better_way: asString(out.better_way),
      next_step: asString(out.next_step)
    };
  }
}