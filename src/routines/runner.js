import { createHash } from 'node:crypto';
import { normalizeEmail } from './ingest.js';

export class RoutineError extends Error {
  constructor(message, code = 'routine_error') {
    super(message);
    this.code = code;
  }
}

export class DuplicateJobError extends Error {
  constructor(existing) {
    super(`Job duplicado bloqueado: idempotency_key=${existing.idempotency_key.slice(0, 12)}… status=${existing.status}`);
    this.code = 'duplicate_job';
    this.existing = existing;
  }
}

export function keyFor(email) {
  return createHash('sha256')
    .update(`${String(email.from).trim().toLowerCase()}|${String(email.messageId).trim()}`)
    .digest('hex');
}

const SENT_RE = /\b(envi|mand|sent)[a-záéíóúüñ]*/i;
const CONFIRM_RE = /\b(confirmo|confirmar|confirmado|confirmada|done|hecho|hecha|verificado|verificada|cumple|aprobado|aplie|apliqu[ée]|listo|todo correcto)\b/i;

export class Runner {
  #repo;

  constructor(repo) {
    this.#repo = repo;
  }

  ingestEmail(userId, rawEmail) {
    const norm = normalizeEmail(rawEmail);
    if (!norm.ok) throw new RoutineError(norm.error, 'invalid_email');

    const routine = this.#repo.latestRoutine(userId);
    if (!routine || !routine.active) {
      throw new RoutineError(
        'No hay rutina aprobada y activa para este usuario: nada se ejecuta sin aprobación explícita en review.',
        'no_active_routine'
      );
    }

    const key = keyFor(norm.email);
    const existing = this.#repo.findJob(key, userId);
    if (existing) throw new DuplicateJobError(existing);


    const job = this.#repo.insertJob(routine, userId, key, {
      from: norm.email.from,
      messageId: norm.email.messageId,
      orderNumber: norm.email.orderNumber,
      subject: norm.email.subject
    });
    if (!job) {
      const dupe = this.#repo.findJob(key, userId);
      if (dupe) throw new DuplicateJobError(dupe);
      throw new RoutineError('La inserción del job falló inesperadamente.', 'insert_failed');
    }
    return { job, idempotencyKey: key, routine_id: routine.id, orderNumber: norm.email.orderNumber };
  }

  confirmJob(userId, idempotencyKey, message) {
    const job = this.#repo.findJob(idempotencyKey, userId);
    if (!job) throw new RoutineError('No existe job para esa idempotency_key.', 'job_not_found');
    if (job.user_id !== userId) throw new RoutineError('El job pertenece a otro usuario.', 'forbidden');

    const note = String(message || '').trim();
    if (!note || SENT_RE.test(note)) {
      this.#repo.logAttempt(job.id, `"${note}" no confirma: "sent"/"enviado" NO cuenta como done.`);
      return { job: this.#repo.job(job.id), confirmed: false, reason: 'sent_does_not_confirm' };
    }
    if (CONFIRM_RE.test(note)) {
      if (job.status === 'confirmed') {
        return { job, confirmed: true, reason: 'already_confirmed' };
      }
      if (job.status === 'failed') {
        return { job, confirmed: false, reason: 'job_failed' };
      }
      return { job: this.#repo.confirmJob(job.id, note), confirmed: true };
    }
    this.#repo.logAttempt(job.id, `"${note}" no es una confirmación reconocida.`);
    return { job: this.#repo.job(job.id), confirmed: false, reason: 'unrecognized_confirmation' };
  }

  failJob(userId, idempotencyKey, note = '') {
    const job = this.#repo.findJob(idempotencyKey, userId);
    if (!job) throw new RoutineError('No existe job para esa idempotency_key.', 'job_not_found');
    return { job: this.#repo.failJob(job.id, note), failed: true };
  }


  rejectJob(userId, idempotencyKey, note = '') {
    const job = this.#repo.findJob(idempotencyKey, userId);
    if (!job) throw new RoutineError('No existe job para esa idempotency_key.', 'job_not_found');
    return {
      job: this.#repo.logAttempt(job.id, `respuesta rechazada (no confirma): "${note}"`),
      confirmed: false,
      reason: 'rejected_in_dialog'
    };
  }

  list(userId, status = null) {
    return this.#repo.jobsFor(userId, status).map((j) => ({
      id: j.id,
      idempotency_key: j.idempotency_key,
      status: j.status,
      orderNumber: (JSON.parse(j.payload || '{}').orderNumber) || null,
      data: JSON.parse(j.payload || '{}'),
      saved_at: j.saved_at,
      confirmed_at: j.confirmed_at
    }));
  }

  waiting(userId) {
    return this.list(userId, 'waiting');
  }
}