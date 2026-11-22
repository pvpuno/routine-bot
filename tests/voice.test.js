import test from 'node:test';
import assert from 'node:assert/strict';
import { MistralFormatter, LlmError } from '../src/llm.js';
import { TelegramPoller } from '../src/telegram.js';

test('voz: transcribeAudio manda multipart a Voxtral y devuelve el texto', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url: String(url), opts });
    return new Response(JSON.stringify({ text: 'quiero que cuando llegue un pedido se guarde' }), { status: 200 });
  });

  const llm = new MistralFormatter('test-key');
  const text = await llm.transcribeAudio(Buffer.from('OGG-FAKE'), { filename: 'nota.ogg' });

  assert.equal(text, 'quiero que cuando llegue un pedido se guarde');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/audio\/transcriptions$/);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer test-key');
  assert.ok(calls[0].opts.body instanceof FormData, 'el cuerpo es multipart FormData');
  assert.equal(calls[0].opts.body.get('model'), 'voxtral-mini-latest');
  const file = calls[0].opts.body.get('file');
  assert.equal(file.name, 'nota.ogg');
  assert.equal(file.type, 'audio/ogg');
});

test('voz: errores HTTP y respuestas vacías se traducen en LlmError', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('boom', { status: 500 }));
  const llm = new MistralFormatter('test-key');
  await assert.rejects(() => llm.transcribeAudio(Buffer.from('x')), (err) => {
    assert.ok(err instanceof LlmError);
    assert.match(err.message, /HTTP 500/);
    return true;
  });

  globalThis.fetch.mock.resetCalls?.();
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ text: '' }), { status: 200 }));
  await assert.rejects(() => llm.transcribeAudio(Buffer.from('x')), /transcripción volvió vacía/);
});

test('voz: downloadFile hace getFile y después baja el archivo con límite de tamaño', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    if (String(url).includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'voicenotes/file_1.oga' } }), { status: 200 });
    }
    return new Response(Buffer.from('AUDIOBYTES'), { status: 200, headers: { 'content-length': '10' } });
  });

  const poller = new TelegramPoller({ TELEGRAM_TOKEN: 'T', POLL_SECONDS: 1 }, console);
  const buf = await poller.downloadFile('file-id-1');
  assert.ok(buf instanceof Buffer);
  assert.equal(buf.toString(), 'AUDIOBYTES');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /getFile\?file_id=file-id-1/);
  assert.match(calls[1], /\/file\/botT\/voicenotes\/file_1\.oga/);

  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: false, description: 'bad' }), { status: 200 }));
  await assert.rejects(() => poller.downloadFile('x'), /getFile falló/);
});
