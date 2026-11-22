import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BackupLoop, pruneBackups } from '../src/backups.js';
import { setup } from './helpers.js';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('backups: al llegar la hora corre VACUUM INTO y el archivo es una db válida', async (t) => {
  const { repo } = setup();
  const dir = tmpDir(t);

  const loop = new BackupLoop({
    repo,
    dir,
    hhmm: '03:30',
    keep: 3,
    now: () => new Date('2026-11-23T03:30:00Z')
  });

  const out = await loop.runOnce();
  assert.equal(out.length, 1);
  const file = out[0].file;
  assert.match(path.basename(file), /^routine-bot-20261123-033000\.db$/);
  assert.ok(fs.existsSync(file));

  const copy = new DatabaseSync(file);
  assert.ok(copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cursors'").get());
  copy.close();

  assert.equal(repo.cursor('backup'), '2026-11-23');
  repo.db.close();
});

test('backups: mismo día no duplica; la TZ manda sobre el reloj del server', async (t) => {
  const { repo } = setup();
  const dir = tmpDir(t);

  const loopUTC = new BackupLoop({
    repo,
    dir,
    hhmm: '03:30',
    keep: 3,
    now: () => new Date('2026-11-23T03:30:00Z')
  });
  assert.equal((await loopUTC.runOnce()).length, 1);
  assert.deepEqual(await loopUTC.runOnce(), [], 'ya hubo backup hoy: nada');

  const loopBA = new BackupLoop({
    repo,
    dir,
    hhmm: '03:30',
    keep: 3,
    timeZone: 'America/Argentina/Buenos_Aires',
    now: () => new Date('2026-11-23T05:30:00Z')
  });
  assert.deepEqual(await loopBA.runOnce(), [], 'en Buenos Aires son las 02:30, no es la hora');
  assert.equal((await loopBA.runOnce()).length, 0, 'sigue sin ser la hora');

  repo.db.close();
});

test('backups: rota dejando solo los últimos keep y no toca archivos ajenos', async (t) => {
  const { repo } = setup();
  const dir = tmpDir(t);
  for (const name of ['routine-bot-20250101-000000.db', 'routine-bot-20250102-000000.db', 'routine-bot-20250103-000000.db', 'routine-bot-20250104-000000.db', 'otro.txt']) {
    fs.writeFileSync(path.join(dir, name), 'x');
  }

  const loop = new BackupLoop({
    repo,
    dir,
    hhmm: '03:30',
    keep: 2,
    now: () => new Date('2026-11-23T03:30:00Z')
  });
  const [out] = await loop.runOnce();

  const remaining = fs.readdirSync(dir).sort();
  assert.ok(remaining.includes('otro.txt'), 'los archivos ajenos no se tocan');
  assert.ok(!remaining.includes('routine-bot-20250101-000000.db'));
  assert.ok(!remaining.includes('routine-bot-20250102-000000.db'));
  assert.ok(!remaining.includes('routine-bot-20250103-000000.db'));
  assert.ok(remaining.includes('routine-bot-20250104-000000.db'));
  assert.ok(remaining.includes(path.basename(out.file)));
  assert.deepEqual(out.removed.sort(), ['routine-bot-20250101-000000.db', 'routine-bot-20250102-000000.db', 'routine-bot-20250103-000000.db']);
  assert.equal(pruneBackups(dir, 10).length, 0, 'con keep holgado no borra nada más');
  repo.db.close();
});
