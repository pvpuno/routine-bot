const CLARIFY_QUESTIONS = [
  { key: 'conflict', ask: 'Pregunta 1/4 — conflicto: si dos fuentes se contradicen (ej.: el email dice una cosa y el sistema otra), ¿cuál gana? Cada respuesta se convierte en regla.' },
  { key: 'saved', ask: 'Pregunta 2/4 — saved: ¿qué condiciones hacen que "el registro existe y es correcto"?' },
  { key: 'confirmed', ask: 'Pregunta 3/4 — confirmed: ¿qué confirmación PERSONAL cuenta como hecho? Ojo: "sent"/"enviado" NO cuenta como done.' },
  { key: 'waiting', ask: 'Pregunta 4/4 — waiting: ¿cómo se sigue un job pendiente sin crear duplicados?' }
];

export class StateMachine {
  #repo;
  #formatter;
  #runner;

  constructor(repo, formatter, runner = null) {
    this.#repo = repo;
    this.#formatter = formatter;
    this.#runner = runner;
  }

  static AFFIRM_RE = /^\s*(?:s[ií]\s*[,;:.!?…]*\s*(?:eso\s+es)?|eso\s+es|ok(?:ay)?|dale|vamos|correcto|exacto|perfecto|aprobado|apruebo|confirmo|sí)\s*[.!,…]*\s*$/i;

  static SENT_HINT_RE = /\b(envi|mand|sent)[a-záéíóúüñ]*/i;

  async handle(userId, text) {
    const raw = String(text || '').trim();
    if (!raw) return { phase: this.#repo.conversation(userId).phase, reply: 'Mandame texto, por favor.' };

    if (raw.startsWith('/')) {
      return this.#command(userId, raw.toLowerCase());
    }


    const conv = this.#repo.conversation(userId);
    if (conv.ctx?.confirming) {
      return this.#confirmStep(conv, userId, raw);
    }
    switch (conv.phase) {
      case 'goal': return this.#phaseGoal(conv, userId, raw);
      case 'process': return this.#phaseProcess(conv, userId, raw);
      case 'clarify': return this.#phaseClarify(conv, userId, raw);
      case 'improve': return this.#phaseImprove(conv, userId, raw);
      case 'routines': return this.#phaseRoutines(conv, userId, raw);
      case 'review': return this.#phaseReview(conv, userId, raw);
      case 'done': return this.#phaseDone(conv, userId, raw);
      default: return { phase: conv.phase, reply: 'Fase desconocida. Usa /reset para empezar de nuevo.' };
    }
  }


  #command(userId, raw) {
    const cmd = raw.split(/\s+/)[0];
    const conv = this.#repo.conversation(userId);
    if (cmd === '/start') {
      const restated = conv.ctx?.goal?.restated;
      if (restated) {
        return {
          phase: conv.phase,
          reply: `Tu conversación ya está en la fase "${conv.phase}". Usa /reset si quieres empezar una conversación nueva.\n\nMeta actual: ${restated}`
        };
      }
      return {
        phase: conv.phase,
        reply: [
          'Dimos inicio. Filosofía: goal first → process second → then routines.',
          'Fase 1/6 — goal: contame tu meta final, qué querés tener cuando esto termine.'
        ].join('\n\n')
      };
    }
    if (cmd === '/reset') {
      this.#repo.closeConversation(conv);
      const fresh = this.#repo.conversation(userId);
      return { phase: fresh.phase, reply: 'Conversación nueva. Fase 1/6 — goal: contame la meta final.' };
    }
    if (cmd === '/restate') {
      const s = conv.ctx?.process?.structured;
      if (!conv.ctx?.goal?.confirmed || !s) {
        return { phase: conv.phase, reply: 'Todavía no hay proceso estructurado; seguimos en la fase actual.' };
      }
      return {
        phase: conv.phase,
        reply: `${this.#restate(conv.ctx.goal.restated, s)}\n\n¿Correcto? Di "sí" para seguir, o agregá más detalle.`
      };
    }
    if (cmd === '/status') {
      return { phase: conv.phase, reply: '```json\n' + JSON.stringify(this.status(userId), null, 2) + '\n```' };
    }
    if (cmd === '/confirm') {
      return this.#confirmStart(conv, userId);
    }
    if (cmd === '/skip') {
      if (conv.phase === 'improve') {
        return this.#phaseImprove(conv, userId, raw);
      }
      if (conv.phase === 'clarify') {
        return { phase: conv.phase, reply: 'No puedo saltar clarify: necesito las 4 respuestas y los 3 ejemplos (uno con fallo y su lección).' };
      }
      return { phase: conv.phase, reply: '/skip solo aplica en las fases clarify/improve.' };
    }

    if (cmd === '/routines') {
      return this.#listRoutines(conv, userId);
    }
    if (cmd === '/routine') {
      return this.#useRoutine(conv, userId, raw);
    }

    return { phase: conv.phase, reply: 'Comando no reconocido. Comandos: /start, /reset, /restate, /status, /skip, /confirm, /routines, /routine <id>.' };
  }

  #routineActionText(r) {
    try {
      const a = JSON.parse(r.action);
      return Array.isArray(a) ? a.join('; ') : String(a);
    } catch {
      return r.action;
    }
  }

  #listRoutines(conv, userId) {
    const routines = this.#repo.routinesFor(userId);
    if (!routines.length) {
      return {
        phase: conv.phase,
        reply: 'Todavía no tenés rutinas. Terminá el flujo (goal → process → clarify → review) y aparecen acá.'
      };
    }
    const lines = routines.map((r) => `- [id ${r.id}] ${r.active ? '**ACTIVA**' : 'inactiva'} — trigger: ${r.trigger} — acción: ${this.#routineActionText(r)}`);
    return {
      phase: conv.phase,
      reply: ['Tus rutinas:', ...lines, '', 'Usá "/routine <id>" para poner otra como activa, o "/routine off" para desactivar.'].join('\n')
    };
  }

  #useRoutine(conv, userId, raw) {
    const arg = raw.split(/\s+/).slice(1).join(' ').trim();
    if (!arg) {
      return { phase: conv.phase, reply: 'Usá "/routine <id>" (mirá los ids con /routines), o "/routine off" para desactivar.' };
    }

    if (/^off$/i.test(arg)) {
      const current = this.#repo.activeRoutine(userId);
      if (current) this.#repo.setRoutineActive(current.id, false);
      return {
        phase: conv.phase,
        reply: 'Sin rutina activa: no se ingiere nada hasta que actives una con "/routine <id>".'
      };
    }

    if (!/^\d+$/.test(arg)) {
      return { phase: conv.phase, reply: `"${arg}" no es un id de rutina. Mirá los ids con /routines.` };
    }

    const target = this.#repo.routine(Number(arg));
    if (!target || target.user_id !== userId) {
      return { phase: conv.phase, reply: `No encuentro la rutina ${arg} que sea tuya. Mirá /routines.` };
    }

    this.#repo.activateRoutine(target.id, userId);
    return {
      phase: conv.phase,
      reply: `Rutina [id ${target.id}] activada: ${target.trigger}\nLos eventos nuevos se ingieren contra esta rutina; "/routine off" la desactiva.`
    };
  }

  async #phaseGoal(conv, userId, raw) {
    const ctx = { ...conv.ctx };
    if (ctx.goal?.awaitingConfirm) {
      if (StateMachine.AFFIRM_RE.test(raw)) {
        this.#repo.saveGoal(conv, userId, ctx.goal.original, ctx.goal.restated, true);
        ctx.goal = { ...ctx.goal, confirmed: true };
        this.#repo.saveContext(conv, ctx, 'process');
        return {
          phase: 'process',
          reply: [
            `Meta guardada: "${ctx.goal.restated}"`,
            'Fase 2/6 — process: hacé tu **brain dump** libre y desordenado.',
            'Contame: qué haces, qué miras, qué apps usas, cómo sabes que quedó bien, de dónde viene la info y quién da feedback. Desorden está bien — yo no lo ordeno primero.'
          ].join('\n\n')
        };
      }
      const restated = await this.#formatter.restateGoal(raw);
      ctx.goal = { original: raw, restated: restated.restated, awaitingConfirm: true };
      this.#repo.saveContext(conv, ctx, 'goal');
      return {
        phase: 'goal',
        reply: `Meta reformulada en una frase:\n"${restated.restated}"\n\n¿Es correcto? Di "sí, eso es" para continuar, o reescribila.`
      };
    }

    const restated = await this.#formatter.restateGoal(raw);
    ctx.goal = { original: raw, restated: restated.restated, awaitingConfirm: true };
    this.#repo.saveContext(conv, ctx, 'goal');
    return {
      phase: 'goal',
      reply: `Entendido. Meta reformulada en UNA frase:\n"${restated.restated}"\n\n¿Es correcto? No avanzo hasta que confirmes: di "sí, eso es", o corregime la meta.`
    };
  }

  async #phaseProcess(conv, userId, raw) {
    const ctx = { ...conv.ctx };
    if (!ctx.process) ctx.process = { brainDumpParts: [], structured: null, awaitingConfirm: false };


    if (ctx.process.awaitingConfirm && StateMachine.AFFIRM_RE.test(raw)) {
      if (!ctx.process.structured) {
        return { phase: conv.phase, reply: 'Todavía no tengo proceso que guardar: contame el brain dump.' };
      }
      this.#repo.saveProcess(conv, userId, ctx.process.brainDumpParts.join('\n'), ctx.process.structured, true);
      ctx.process = { ...ctx.process, confirmed: true, awaitingConfirm: false };
      ctx.clarify = { step: 0, answers: {} };
      this.#repo.saveContext(conv, ctx, 'clarify');
      return {
        phase: 'clarify',
        reply: [
          'Proceso guardado. Fase 3/6 — clarify: hago preguntas UNA A LA VEZ para descubrir decisiones ocultas.',
          `${CLARIFY_QUESTIONS[0].ask}`
        ].join('\n\n')
      };
    }

    ctx.process.brainDumpParts.push(raw);

    const brainDump = ctx.process.brainDumpParts.join('\n');
    const goalText = ctx.goal?.restated || ctx.goal?.original || '';
    const structured = await this.#formatter.structureProcess(brainDump, goalText);
    ctx.process.structured = structured;
    ctx.process.awaitingConfirm = true;
    this.#repo.saveContext(conv, ctx, 'process');
    this.#repo.saveGoal(conv, userId, ctx.goal.original, ctx.goal.restated, true);

    return {
      phase: 'process',
      reply: `${this.#restate(goalText, structured)}\n\n¿Correcto? Di "sí" para pasar a la fase de reglas (clarify), o seguí agregando detalle del proceso. También podés pedir /restate para ver esto de nuevo.`
    };
  }

  #restate(goalText, s) {
    const list = (arr, fallback) => (arr && arr.length ? arr.map((x) => `- ${x}`).join('\n') : `- ${fallback}`);
    return [
      '/restate',
      `**Meta:** ${goalText || '(meta pendiente)'}`,
      '',
      '**Proceso en lenguaje simple:**',
      `Pasos:\n${list(s.steps, 'no mencionaste pasos')}`,
      `Puntos de atención:\n${list(s.watch_outs, 'ninguno mencionado')}`,
      `Tools:\n${list(s.tools, 'ninguna mencionada')}`,
      `Cómo sabe que quedó bien:\n${list(s.check_work, 'no mencionado')}`,
      `Info viene de:\n${list(s.info_from, 'no mencionado')}`,
      `Feedback de:\n${list(s.feedback_from, 'no mencionado')}`
    ].join('\n');
  }

  async #phaseClarify(conv, userId, raw) {
    const ctx = { ...conv.ctx };
    if (!ctx.clarify) ctx.clarify = { step: 0, answers: {} };

    const QUESTIONS = CLARIFY_QUESTIONS;

    const step = ctx.clarify.step;


    if (step < QUESTIONS.length) {
      const answered = QUESTIONS[step];
      let rule = await this.#formatter.ruleFromAnswer(answered.key, raw);
      ctx.clarify.answers[answered.key] = raw;
      this.#repo.addRule(conv, userId, answered.key, rule.rule);
      if (rule.needs_followup && rule.followup) {
        this.#repo.saveContext(conv, ctx, 'clarify');
        return { phase: 'clarify', reply: `Duda concreta: ${rule.followup}` };
      }

      const next = step + 1;
      ctx.clarify.step = next;
      if (next < QUESTIONS.length) {
        this.#repo.saveContext(conv, ctx, 'clarify');
        return { phase: 'clarify', reply: `Regla guardada: "${rule.rule}"\n\n${QUESTIONS[next].ask}` };
      }

      ctx.clarify.step = QUESTIONS.length;
      this.#repo.saveContext(conv, ctx, 'clarify');
      return {
        phase: 'clarify',
        reply: [
          `Regla guardada: "${rule.rule}"`,
          'Antes de salir de clarify, dame **3 ejemplos reales** del proceso, **incluyendo uno que haya salido mal** y qué se aprendió de él.'
        ].join('\n\n')
      };
    }

    const extracted = await this.#formatter.extractExamples(raw);
    for (const ex of extracted.examples || []) {
      this.#repo.addRule(conv, userId, ex.failed ? 'example_failed' : 'example', ex.lesson ? `${ex.text} (lección: ${ex.lesson})` : ex.text);
    }
    const examples = extracted.examples || [];
    if (!(examples.length >= 3) || !examples.some((e) => e.failed)) {
      const missing = examples.length < 3
        ? `guardé ${examples.length}/3, esperaba 3`
        : 'no veo el ejemplar que salió mal (y su lección)';
      ctx.clarify.done = false;
      this.#repo.saveContext(conv, ctx, 'clarify');
      return {
        phase: 'clarify',
        reply: `${missing}: necesito 3 ejemplos reales del proceso, incluyendo uno que haya salido mal y qué se aprendió.`
      };
    }
    ctx.clarify.done = true;
    this.#repo.saveContext(conv, ctx, 'improve');


    const goalText = ctx.goal?.restated || ctx.goal?.original || '';
    const proc = ctx.process?.structured;
    const rules = this.#repo.rules(conv.id);
    return this.#routinize(conv, userId, ctx, goalText, proc, rules);
  }

  async #phaseImprove(conv, userId, raw) {
    const ctx = { ...conv.ctx };
    if (!ctx.process?.structured || !ctx.goal?.restated) {
      return { phase: conv.phase, reply: 'No puedo saltar a routines: faltan goal confirmada y proceso estructurado.' };
    }
    ctx.improve = 'skipped (sin conectores en v1)';
    this.#repo.saveContext(conv, ctx, 'routines');
    const goalText = ctx.goal.restated;
    const proc = ctx.process.structured;
    const rules = this.#repo.rules(conv.id);
    return this.#routinize(conv, userId, ctx, goalText, proc, rules);
  }

  async #routinize(conv, userId, ctx, goalText, proc, rules) {
    const built = await this.#formatter.buildRoutine(goalText, this.#processSummary(proc), rules);
    const routine = {
      trigger: built.trigger,
      action: Array.isArray(built.action) ? built.action : [built.action],
      idempotency_key_rule: built.idempotency_key_rule
    };
    const review = await this.#formatter.review(goalText, this.#processSummary(proc), routine);
    const nextStep = (review && review.next_step) || 'Aprobar o corregir la rutina propuesta.';

    const stored = this.#repo.saveRoutine(conv, userId, { ...routine, active: false });
    ctx.routine = { ...routine, id: stored.id };
    ctx.review = { process_vs_goal: review?.process_vs_goal || '', better_way: review?.better_way || '' };
    this.#repo.saveContext(conv, ctx, 'review');

    const finalObject = {
      goal: goalText,
      process: proc,
      rules: rules.map((r) => ({ kind: r.kind, text: r.text })),
      routine: { trigger: routine.trigger, action: routine.action, idempotency_key_rule: routine.idempotency_key_rule, active: false },
      next_step: nextStep
    };
    ctx.finalObject = finalObject;
    this.#repo.saveContext(conv, ctx, 'review');


    return {
      phase: 'review',
      reply: [
        `Fase 4/6 — improve: ${ctx.improve || 'skipped (sin conectores en v1)'}.`,
        'Fase 5/6 — routines. Propongo esta rutina:',
        `- trigger: ${routine.trigger}`,
        `- acción: ${routine.action.join('; ')}`,
        `- idempotency_key: ${routine.idempotency_key_rule} — antes de insertar se verifica duplicados; nunca se crea dos veces lo mismo.`,
        '',
        'Fase 6/6 — review:',
        `proceso vs meta: ${ctx.review.process_vs_goal}`,
        ctx.review.better_way ? `mejora propuesta: ${ctx.review.better_way}` : 'sin mejora evidente por ahora',
        '',
        '```json',
        JSON.stringify(finalObject, null, 2),
        '```',
        '',
        '**DEFAULT: propongo y espero.** Nada se ejecuta sin tu "sí". ¿Apruebas ESTA rutina concreta? Di "sí" para activar la ejecución, o decime qué cambiar. Si no apruebas, la rutina queda inactiva.'
      ].join('\n')
    };
  }
  #processSummary(proc) {
    if (!proc) return '(sin proceso)';
    return [
      `pasos: ${(proc.steps || []).join(' -> ')}`,
      `watch_outs: ${(proc.watch_outs || []).join(', ')}`,
      `tools: ${(proc.tools || []).join(', ')}`,
      `check_work: ${(proc.check_work || []).join(', ')}`,
      `info_from: ${(proc.info_from || []).join(', ')}`,
      `feedback_from: ${(proc.feedback_from || []).join(', ')}`
    ].join('\n');
  }

  async #phaseRoutines(conv, userId, raw) {
    const ctx = { ...conv.ctx };
    const goalText = ctx.goal?.restated || ctx.goal?.original || '';
    const proc = ctx.process?.structured;
    const rules = this.#repo.rules(conv.id);
    return this.#routinize(conv, userId, ctx, goalText, proc, rules);
  }


  async #phaseReview(conv, userId, raw) {
    const ctx = { ...conv.ctx };
    if (ctx.review?.awaitingRevisionDetail) {
      const goalText = ctx.goal?.restated || ctx.goal?.original || '';
      const proc = ctx.process?.structured;
      const rules = this.#repo.rules(conv.id);
      ctx.review = { ...ctx.review, awaitingRevisionDetail: false, lastRevision: raw };
      this.#repo.saveContext(conv, ctx, 'review');
      return this.#routinize(conv, userId, ctx, goalText, proc, rules);
    }
    if (StateMachine.AFFIRM_RE.test(raw)) {
      this.#repo.activateRoutine(ctx.routine.id, userId);
      this.#repo.saveContext(conv, { ...ctx, approved: true }, 'done');
      return {
        phase: 'done',
        reply: `Rutina activada y aprobada para ejecución. Nada más se ejecuta sin esa aprobación explícita.\n\nnext_step: ${ctx.finalObject.next_step}`
      };
    }
    ctx.review = { ...ctx.review, awaitingRevisionDetail: true };
    this.#repo.saveContext(conv, ctx, 'review');
    return { phase: 'review', reply: 'Ok, no apruebo nada todavía. Decime qué cambiar de la rutina y te repropongo.' };
  }

  async #phaseDone(conv, userId, raw) {
    const ctx = { ...conv.ctx };
    if (!StateMachine.AFFIRM_RE.test(raw)) {
      const goalText = ctx.goal?.restated || ctx.goal?.original || '';
      const proc = ctx.process?.structured;
      const rules = this.#repo.rules(conv.id);
      return this.#routinize(conv, userId, ctx, goalText, proc, rules);
    }
    return { phase: 'done', reply: 'La rutina ya está activada. Mandame el próximo evento (ej.: un email de pedido) y lo proceso.' };
  }

  status(userId) {
    const conv = this.#repo.conversation(userId);
    return {
      phase: conv.phase,
      goal: conv.ctx?.goal ?? null,
      process: conv.ctx?.process?.structured ?? null,
      rules: this.#repo.rules(conv.id),
      routine: conv.ctx?.routine ?? null,
      confirming: conv.ctx?.confirming ?? null
    };
  }


  #confirmStart(conv, userId) {
    if (!this.#runner) {
      return { phase: conv.phase, reply: 'Confirmación conversacional no disponible en este modo (falta el runner de rutinas).' };
    }
    if (conv.ctx?.confirming) {
      const current = this.#runner.list(userId).find((j) => j.idempotency_key === conv.ctx.confirming.idempotency_key);
      if (!current) {
        const ctx = { ...conv.ctx };
        delete ctx.confirming;
        this.#repo.saveContext(conv, ctx, conv.phase);
        return { phase: conv.phase, reply: 'Ese job ya no está en waiting. Usá /confirm de nuevo.' };
      }
      return this.#confirmAsk(conv, current, ['Seguimos donde estábamos:']);
    }
    const jobs = this.#runner.waiting(userId);
    if (!jobs.length) {
      return { phase: conv.phase, reply: 'No hay jobs en waiting para confirmar.' };
    }
    const ctx = { ...conv.ctx };
    ctx.confirming = { idempotency_key: jobs[0].idempotency_key };
    this.#repo.saveContext(conv, ctx, conv.phase);
    return this.#confirmAsk(conv, jobs[0], [`Hay ${jobs.length} job(s) en waiting. Vamos uno a la vez.`]);
  }

  #confirmAsk(conv, job, extra = []) {
    return {
      phase: conv.phase,
      reply: [
        ...extra,
        `Job pendiente: orden ${job.orderNumber ?? '(sin número de orden)'} — saved_at: ${job.saved_at} — clave ${job.idempotency_key.slice(0, 12)}…`,
        '¿Confirmás que VOS la revisaste y quedó bien? ("enviado" NO cuenta como done.)',
        'Respondé "sí" para confirmar, "no" para dejarla en waiting, o "cancelar".'
      ].join('\n\n')
    };
  }

  #confirmStep(conv, userId, raw) {
    const ctx = { ...conv.ctx };
    const key = ctx.confirming.idempotency_key;


    if (StateMachine.AFFIRM_RE.test(raw)) {
      const out = this.#runner.confirmJob(userId, key, 'confirmado por chat (revisión personal)');
      const pending = this.#runner.waiting(userId);
      if (pending.length) {
        ctx.confirming = { idempotency_key: pending[0].idempotency_key };
        this.#repo.saveContext(conv, ctx, conv.phase);
        return this.#confirmAsk(
          conv,
          pending[0],
          [`Orden ${out.job ? 'confirmada' : 'procesada'}: confirmed_at ${this.#runner.list(userId).find((j) => j.idempotency_key === key)?.confirmed_at ?? '(ya estaba)'}`]
        );
      }
      delete ctx.confirming;
      this.#repo.saveContext(conv, ctx, conv.phase);
      return {
        phase: conv.phase,
        reply: `Confirmada. confirmed_at: ${this.#runner.list(userId).find((j) => j.idempotency_key === key)?.confirmed_at ?? '(ya estaba confirmada)'}`
      };
    }

    if (/^\s*cancel(?:ar|o)?\s*[.!,…]*\s*$/i.test(raw)) {
      delete ctx.confirming;
      this.#repo.saveContext(conv, ctx, conv.phase);
      return { phase: conv.phase, reply: 'Cancelado, seguimos antes de la confirmación. Usá /confirm para retomar.' };
    }

    if (/^\s*no\b/i.test(raw)) {
      this.#runner.rejectJob(userId, key, raw);
      delete ctx.confirming;
      this.#repo.saveContext(conv, ctx, conv.phase);
      return { phase: conv.phase, reply: 'Ok, queda en waiting. Retomala con /confirm cuando la revises.' };
    }

    this.#runner.rejectJob(userId, key, raw);
    if (StateMachine.SENT_HINT_RE.test(raw)) {
      return { phase: conv.phase, reply: '"enviado"/"sent" NO cuenta como done. Respondé "sí" si vos mismo la revisaste y quedó bien, "no" si sigue pendiente, o "cancelar".' };
    }
    return { phase: conv.phase, reply: 'No entendí la respuesta. Respondé "sí" (confirmás), "no" (queda en waiting) o "cancelar".' };
  }
}
