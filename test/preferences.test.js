import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PreferenceStore } from '../dist/preferences.js';

async function pathFor(t) {
  const root = await mkdtemp(join(tmpdir(), 'vizio-prefs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'settings.json');
}

test('merges concurrent preference writes and restores missing files safely', async t => {
  const path = await pathFor(t);
  const store = new PreferenceStore(path);
  await store.load();
  assert.deepEqual(store.input('missing'), {});
  await Promise.all([
    store.update('Room'),
    store.update(undefined, { key: 'HDMI', preference: { name: 'TV' } }),
    store.update(undefined, { key: 'HDMI', preference: { hidden: true } }),
  ]);
  const restored = new PreferenceStore(path);
  await restored.load();
  assert.equal(restored.name, 'Room');
  assert.deepEqual(restored.input('HDMI'), { name: 'TV', hidden: true });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { name: 'Room', inputs: { HDMI: { name: 'TV', hidden: true } } });
});

test('reports corrupt preferences and can save valid settings afterwards', async t => {
  const path = await pathFor(t);
  await writeFile(path, 'invalid');
  const store = new PreferenceStore(path);
  await assert.rejects(store.load());
  await store.update('Recovered');
  const restored = new PreferenceStore(path);
  await restored.load();
  assert.equal(restored.name, 'Recovered');
});

test('failed saves leave current settings intact and do not poison the write queue', async t => {
  const path = await pathFor(t);
  const store = new PreferenceStore(path);
  await mkdir(path);
  await assert.rejects(store.update('Not Saved'));
  assert.equal(store.name, undefined);
  await rm(path, { recursive: true });
  await store.update('Saved');
  assert.equal(store.name, 'Saved');
});
