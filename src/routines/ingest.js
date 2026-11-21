export function normalizeEmail(raw = {}) {
  const from = String(raw.from || raw.sender || '').trim().toLowerCase();
  const messageId = String(raw.messageId || raw.message_id || raw.id || '').trim();
  const orderNumber = String(raw.orderNumber || raw.order_number || '').trim();
  if (!from || !messageId) {
    return { ok: false, error: 'Faltan "from" o "messageId" del email; no puedo derivar el idempotency_key.' };
  }
  return {
    ok: true,
    email: { from, messageId, orderNumber, subject: String(raw.subject || ''), body: String(raw.body || '') }
  };
}