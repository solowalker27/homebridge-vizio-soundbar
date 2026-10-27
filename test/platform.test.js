import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { clearTimeout } from 'node:timers';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import register from '../dist/index.js';
import { HomebridgeVizioSoundbar, inputIdentifier } from '../dist/platform.js';
import { AUDIO, INPUT, apiFor, fakeSoundbar, success, until } from './helpers.js';

async function setup(t, handler, options = {}) {
  const device = await fakeSoundbar(t, handler);
  const storage = await mkdtemp(join(tmpdir(), 'vizio-test-'));
  t.after(() => rm(storage, { recursive: true, force: true }));
  const { api, log, logs } = apiFor(storage);
  const config = { platform: 'HomebridgeVizioSoundbar', name: 'Living Room', ip: device.ip, pollInterval: 0, ...options };
  const platform = new HomebridgeVizioSoundbar(log, config, api);
  t.after(() => api.emit('shutdown'));
  const launched = once(api, 'publishExternalAccessories');
  return { ...device, api, log, logs, config, platform, storage, launched };
}

async function launch(context) {
  context.api.emit('didFinishLaunching');
  await context.launched;
  await until(() => !context.platform.refreshing);
  const C = context.api.hap.Characteristic;
  const S = context.api.hap.Service;
  return {
    C, S, tv: context.platform.accessory.getService(S.Television),
    speaker: context.platform.accessory.getService(S.TelevisionSpeaker),
    inputs: context.platform.accessory.services.filter(s => s.UUID === S.InputSource.UUID),
  };
}

test('ESM initializer registers with the exact scoped package name', async t => {
  const storage = await mkdtemp(join(tmpdir(), 'vizio-register-'));
  t.after(() => rm(storage, { recursive: true, force: true }));
  const { api } = apiFor(storage);
  const event = once(api, 'registerPlatform');
  register(api);
  const [name, ctor, plugin] = await event;
  assert.equal(name, 'HomebridgeVizioSoundbar');
  assert.equal(plugin, '@solowalker27/homebridge-vizio-soundbar');
  assert.equal(ctor, HomebridgeVizioSoundbar);
});

test('publishes a primary receiver with all linked inputs only after discovery finishes', async t => {
  const context = await setup(t, async req => {
    if (req.path === INPUT) {
      await delay(40);
    }
  });
  let publications = 0;
  context.api.on('publishExternalAccessories', () => { publications++; });
  assert.equal(publications, 0);
  context.api.emit('didFinishLaunching');
  await delay(10);
  assert.equal(publications, 0);
  await context.launched;
  const { api, platform } = context;
  const C = api.hap.Characteristic;
  const S = api.hap.Service;
  const tv = platform.accessory.getService(S.Television);
  assert.equal(platform.accessory._associatedPlugin, '@solowalker27/homebridge-vizio-soundbar');
  assert.equal(platform.accessory.category, api.hap.Categories.AUDIO_RECEIVER);
  assert.equal(platform.accessory.UUID, api.hap.uuid.generate('homebridge:vizio-soundbar:accessory:Living Room'));
  assert.equal(tv.isPrimaryService, true);
  assert.equal(tv.linkedServices.length, 4);
  const ids = tv.linkedServices.filter(s => s.UUID === S.InputSource.UUID).map(s => s.getCharacteristic(C.Identifier).value);
  assert.deepEqual(ids, ['HDMI', 'Optical', 'Bluetooth'].map(inputIdentifier));
  assert.ok(ids.every(id => id > 0));
  assert.equal(publications, 1);
});

test('HomeKit reads/writes control the device and mirror linked power', async t => {
  const context = await setup(t);
  const { C, tv, speaker } = await launch(context);
  assert.equal(await tv.getCharacteristic(C.Active).handleGetRequest(), 1);
  assert.equal(await tv.getCharacteristic(C.ActiveIdentifier).handleGetRequest(), inputIdentifier('HDMI'));
  await tv.getCharacteristic(C.Active).handleSetRequest(0);
  assert.equal(context.state.power, 0);
  assert.equal(speaker.getCharacteristic(C.Active).value, 0);
  await tv.getCharacteristic(C.ActiveIdentifier).handleSetRequest(inputIdentifier('Optical'));
  assert.equal(context.state.input, 'Optical');
  await speaker.getCharacteristic(C.Volume).handleSetRequest(65);
  assert.equal(context.state.volume, 65);
  await speaker.getCharacteristic(C.Mute).handleSetRequest(true);
  assert.equal(await speaker.getCharacteristic(C.Mute).handleGetRequest(), true);
  await speaker.getCharacteristic(C.VolumeSelector).handleSetRequest(C.VolumeSelector.INCREMENT);
  assert.equal(context.state.volume, 66);
});

test('failed reads/writes return communication errors and do not report successful control', async t => {
  let failing = false;
  const context = await setup(t, (req, res) => {
    if (failing && req.path !== INPUT) {
      res.end(JSON.stringify({ STATUS: { RESULT: 'FAILURE' } }));
      return true;
    }
  });
  const { C, tv, speaker } = await launch(context);
  failing = true;
  const status = context.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
  await assert.rejects(speaker.getCharacteristic(C.Volume).handleGetRequest(), error => error === status);
  await assert.rejects(tv.getCharacteristic(C.Active).handleSetRequest(0), error => error === status);
  assert.equal(context.state.power, 1);
  assert.equal(speaker.getCharacteristic(C.Active).value, 1);
  await context.platform.refresh();
  assert.equal(tv.getCharacteristic(C.Active).statusCode, status);
  failing = false;
  await context.platform.refresh();
  assert.equal(tv.getCharacteristic(C.Active).statusCode, 0);
});

test('rejects unknown input identifiers and unsupported remote commands without network writes', async t => {
  const context = await setup(t);
  const { C, tv } = await launch(context);
  const count = context.requests.length;
  const invalid = context.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST;
  await assert.rejects(tv.getCharacteristic(C.ActiveIdentifier).handleSetRequest(123), error => error === invalid);
  await assert.rejects(tv.getCharacteristic(C.RemoteKey).handleSetRequest(C.RemoteKey.SELECT), error => error === invalid);
  assert.equal(context.requests.length, count);
  await tv.getCharacteristic(C.RemoteKey).handleSetRequest(C.RemoteKey.REWIND);
  assert.deepEqual(context.requests.at(-1).body.KEYLIST[0], { CODESET: 2, CODE: 1, ACTION: 'KEYPRESS' });
});

test('Home app names and visibility survive restart without changing protocol input names', async t => {
  const context = await setup(t);
  const { C, tv, inputs } = await launch(context);
  const hdmi = inputs.find(s => s.getCharacteristic(C.Identifier).value === inputIdentifier('HDMI'));
  await tv.getCharacteristic(C.ConfiguredName).handleSetRequest('Cinema');
  await Promise.all([
    hdmi.getCharacteristic(C.ConfiguredName).handleSetRequest('My TV'),
    hdmi.getCharacteristic(C.TargetVisibilityState).handleSetRequest(C.TargetVisibilityState.HIDDEN),
  ]);
  context.api.emit('shutdown');
  const { api, log } = apiFor(context.storage);
  const restored = new HomebridgeVizioSoundbar(log, context.config, api);
  t.after(() => api.emit('shutdown'));
  const published = once(api, 'publishExternalAccessories');
  api.emit('didFinishLaunching');
  await published;
  const restoredTV = restored.accessory.getService(api.hap.Service.Television);
  const restoredInput = restored.accessory.getServiceById(api.hap.Service.InputSource, 'input:HDMI');
  assert.equal(restoredTV.getCharacteristic(C.ConfiguredName).value, 'Cinema');
  assert.equal(restoredInput.getCharacteristic(C.ConfiguredName).value, 'My TV');
  assert.equal(restoredInput.getCharacteristic(C.CurrentVisibilityState).value, C.CurrentVisibilityState.HIDDEN);
  await restoredTV.getCharacteristic(C.ActiveIdentifier).handleSetRequest(inputIdentifier('HDMI'));
  assert.equal(context.state.input, 'HDMI');
});

test('refresh reflects physical remote changes and does not overwrite a newer HomeKit write', async t => {
  let blocked = false;
  let release;
  let readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const context = await setup(t, async (req, res) => {
    if (blocked && req.method === 'GET' && req.path === `${AUDIO}/volume`) {
      readStarted();
      await gate;
      res.end(JSON.stringify(success([{ VALUE: 5 }])));
      return true;
    }
  });
  const { C, tv, speaker } = await launch(context);
  context.state.volume = 33;
  context.state.muted = true;
  context.state.input = 'Bluetooth';
  await context.platform.refresh();
  assert.equal(speaker.getCharacteristic(C.Volume).value, 33);
  assert.equal(speaker.getCharacteristic(C.Mute).value, true);
  assert.equal(tv.getCharacteristic(C.ActiveIdentifier).value, inputIdentifier('Bluetooth'));
  blocked = true;
  const pending = context.platform.refresh();
  await started;
  // Power uses a key command, so it can finish while the snapshot's volume read is stalled.
  await tv.getCharacteristic(C.Active).handleSetRequest(0);
  release();
  await pending;
  assert.equal(tv.getCharacteristic(C.Active).value, 0);
  assert.equal(speaker.getCharacteristic(C.Active).value, 0);
  assert.equal(speaker.getCharacteristic(C.Volume).value, 33);
});

test('discovery failure retries without publishing a partially configured accessory', async t => {
  let failing = true;
  const context = await setup(t, (req, res) => {
    if (failing && req.path === INPUT) {
      res.end(JSON.stringify({ STATUS: { RESULT: 'FAILURE' } }));
      return true;
    }
  });
  context.api.emit('didFinishLaunching');
  await until(() => context.platform.retryTimer !== undefined);
  assert.equal(context.platform.published, false);
  failing = false;
  // Trigger the scheduled retry directly without waiting 30 seconds in the test suite.
  clearTimeout(context.platform.retryTimer);
  await context.platform.discover();
  assert.equal(context.platform.published, true);
  assert.equal(context.platform.inputs.size, 3);
});

test('shutdown stops polling, aborts discovery, and prevents late publication', async t => {
  let discoveryStarted;
  const started = new Promise(resolve => { discoveryStarted = resolve; });
  const context = await setup(t, (req) => {
    if (req.path === INPUT) {
      discoveryStarted();
      return true;
    }
  }, { pollInterval: 10 });
  context.api.emit('didFinishLaunching');
  await started;
  context.api.emit('shutdown');
  await delay(20);
  assert.equal(context.platform.published, false);
  assert.equal(context.platform.retryTimer, undefined);
  assert.equal(context.platform.pollTimer, undefined);
});

test('canonical input names take priority over another input display alias', async t => {
  const context = await setup(t, (req, res) => {
    if (req.path === INPUT) {
      res.end(JSON.stringify(success([
        { NAME: 'HDMI', VALUE: { NAME: 'Optical' } },
        { NAME: 'Optical', VALUE: { NAME: 'HDMI' } },
      ])));
      return true;
    }
  });
  const { C, tv } = await launch(context);
  context.state.input = 'Optical';
  assert.equal(await tv.getCharacteristic(C.ActiveIdentifier).handleGetRequest(), inputIdentifier('Optical'));
});

test('input identifiers survive reordered discovery and duplicate entries do not create extra services', async t => {
  let reordered = false;
  const context = await setup(t, (req, res) => {
    if (req.path === INPUT) {
      res.end(JSON.stringify(success((reordered ? ['Optical', 'HDMI', 'HDMI'] : ['HDMI', 'Optical'])
        .map(name => ({ NAME: name })))));
      return true;
    }
  });
  const { C, inputs } = await launch(context);
  const identifiers = inputs.map(input => input.getCharacteristic(C.Identifier).value).sort();
  context.api.emit('shutdown');
  reordered = true;
  const { api, log } = apiFor(context.storage);
  const restored = new HomebridgeVizioSoundbar(log, context.config, api);
  t.after(() => api.emit('shutdown'));
  const published = once(api, 'publishExternalAccessories');
  api.emit('didFinishLaunching');
  await published;
  const restoredIDs = restored.accessory.services.filter(s => s.UUID === api.hap.Service.InputSource.UUID)
    .map(s => s.getCharacteristic(C.Identifier).value).sort();
  assert.deepEqual(restoredIDs, identifiers);
});

test('preserves legacy UUID for a configuration with no name and clears an active poll timer', async t => {
  const context = await setup(t, undefined, { name: undefined, pollInterval: 10 });
  await launch(context);
  assert.equal(context.platform.accessory.UUID, context.api.hap.uuid.generate('homebridge:vizio-soundbar:accessory:undefined'));
  assert.ok(context.platform.pollTimer);
  context.api.emit('shutdown');
  assert.equal(context.platform.pollTimer._destroyed, true);
});
