import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { URL, fileURLToPath } from 'node:url';
import { Plugin } from '../node_modules/homebridge/dist/plugin.js';
import { apiFor } from './helpers.js';

test('Homebridge 2 loads the actual ESM entrypoint and registers the packaged plugin', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const plugin = new Plugin('homebridge-vizio-soundbar', fileURLToPath(new URL('..', import.meta.url)), metadata, '@jorts');
  await plugin.load();
  const { api } = apiFor('unused');
  let registered;
  api.on('registerPlatform', (name, ctor, packageName) => { registered = { name, ctor, packageName }; });
  await plugin.initialize(api);
  assert.equal(registered.packageName, metadata.name);
  assert.equal(registered.name, 'HomebridgeVizioSoundbar');
  assert.equal(typeof registered.ctor, 'function');
});
