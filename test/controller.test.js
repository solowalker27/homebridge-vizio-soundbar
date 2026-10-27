import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SoundbarController } from '../dist/controller.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function controllerFor(t, overrides = {}, options = {}) {
  const state = { power: 1, volume: 20, mute: false, input: 'HDMI' };
  const counts = { power: 0, volume: 0, mute: 0, input: 0, discovery: 0, close: 0 };
  const device = {
    listInputs: async () => {
      counts.discovery++;
      return [{ name: 'HDMI', displayName: 'TV Audio' }, { name: 'Optical', displayName: 'HDMI' }];
    },
    getPower: async () => { counts.power++; return state.power; },
    getVolume: async () => { counts.volume++; return state.volume; },
    getMute: async () => { counts.mute++; return state.mute; },
    getInput: async () => { counts.input++; return state.input; },
    setPower: async active => { state.power = active ? 1 : 0; },
    setVolume: async volume => { state.volume = volume; },
    setMute: async mute => { state.mute = mute; },
    setInput: async input => { state.input = input; },
    changeVolume: async up => { state.volume += up ? 1 : -1; },
    key: async () => undefined,
    close: () => { counts.close++; },
    ...overrides,
  };
  const errors = [];
  const controller = new SoundbarController(device, { pollInterval: 0, requestTimeout: 500, ...options },
    (error, operation) => errors.push({ error, operation }));
  t.after(() => controller.stop());
  await controller.start(() => undefined);
  await controller.refresh();
  return { controller, device, counts, state, errors };
}

test('coalesces overlapping GETs and refreshes, but does not cache later reads', async t => {
  const context = await controllerFor(t);
  const gate = deferred();
  context.device.getVolume = async () => { context.counts.volume++; return gate.promise; };
  const baseline = context.counts.volume;
  const reads = Array.from({ length: 20 }, () => context.controller.getVolume());
  const refresh = context.controller.refresh();
  await delay(0);
  assert.equal(context.counts.volume - baseline, 1);
  gate.resolve(42);
  assert.deepEqual(await Promise.all(reads), Array(20).fill(42));
  await refresh;
  await context.controller.getVolume();
  assert.equal(context.counts.volume - baseline, 2);
});

test('a stale GET returns fresh state after a concurrent command instead of overwriting it', async t => {
  const context = await controllerFor(t);
  const stale = deferred();
  let first = true;
  context.device.getVolume = async () => {
    if (first) { first = false; return stale.promise; }
    return context.state.volume;
  };
  const updates = [];
  context.controller.subscribe(update => updates.push(update));
  const reading = context.controller.getVolume();
  await delay(0);
  await context.controller.setVolume(70);
  stale.resolve(5);
  assert.equal(await reading, 70);
  assert.equal(context.controller.state.volume, 70);
  assert.deepEqual(updates, [{ volume: 70 }]);
});

test('a stale read error cannot hide a successful command', async t => {
  const context = await controllerFor(t);
  const stale = deferred();
  let first = true;
  context.device.getMute = async () => {
    if (first) { first = false; return stale.promise; }
    return context.state.mute;
  };
  const reading = context.controller.getMute();
  await delay(0);
  await context.controller.setMute(true);
  stale.reject(new Error('Old request failed'));
  assert.equal(await reading, true);
  assert.equal(context.controller.state.mute, true);
  assert.deepEqual(context.errors, []);
});

test('reads wait for writes to finish and recover after a failed write', async t => {
  const context = await controllerFor(t);
  const command = deferred();
  context.device.setPower = () => command.promise;
  const writing = context.controller.setPower(false);
  const rejection = assert.rejects(writing, /offline/);
  const before = context.counts.power;
  const reading = context.controller.getPower();
  await delay(0);
  assert.equal(context.counts.power, before);
  command.reject(new Error('offline'));
  await rejection;
  assert.equal(await reading, 1);
  assert.equal(context.controller.state.power, 1);
});

test('relative volume refresh is not lost behind an older snapshot and reads only volume', async t => {
  const context = await controllerFor(t);
  const stale = deferred();
  let first = true;
  context.device.getVolume = async () => {
    context.counts.volume++;
    if (first) { first = false; return stale.promise; }
    return context.state.volume;
  };
  const poll = context.controller.refresh();
  await delay(0);
  const before = { ...context.counts };
  await context.controller.changeVolume(true);
  await context.controller.getVolume();
  assert.equal(context.controller.state.volume, 21);
  assert.equal(context.counts.power, before.power);
  assert.equal(context.counts.mute, before.mute);
  assert.equal(context.counts.input, before.input);
  stale.resolve(20);
  await poll;
  assert.equal(context.controller.state.volume, 21);
});

test('failed properties do not discard successful updates, and unchanged snapshots emit nothing', async t => {
  const context = await controllerFor(t);
  const updates = [];
  context.controller.subscribe(update => updates.push(update));
  await context.controller.refresh();
  assert.deepEqual(updates, []);
  context.state.volume = 40;
  context.device.getMute = async () => { throw new Error('mute unavailable'); };
  await context.controller.refresh();
  assert.equal(context.controller.state.volume, 40);
  assert.match(context.controller.state.mute.message, /mute unavailable/);
  const notified = updates.length;
  await context.controller.refresh();
  assert.equal(updates.length, notified);
  context.device.getMute = async () => false;
  await context.controller.refresh();
  assert.equal(context.controller.state.mute, false);
  assert.deepEqual(updates.at(-1), { mute: false });
});

test('canonical input names win over aliases, and writes use the protocol name', async t => {
  const context = await controllerFor(t);
  assert.equal(await context.controller.getInput(), 'HDMI');
  context.state.input = 'TV Audio';
  assert.equal(await context.controller.getInput(), 'HDMI');
  await context.controller.setInput('TV Audio');
  assert.equal(context.state.input, 'HDMI');
  assert.throws(() => context.controller.setInput('missing'), /not discovered/);
});

test('one failing subscriber cannot break commands or other adapters', async t => {
  const context = await controllerFor(t);
  const updates = [];
  const unsubscribe = context.controller.subscribe(() => { throw new Error('adapter failed'); });
  context.controller.subscribe(update => updates.push(update));
  await context.controller.setPower(false);
  assert.deepEqual(updates, [{ power: 0 }]);
  assert.equal(context.errors.at(-1).operation, 'subscriber');
  unsubscribe();
  await context.controller.setPower(true);
  assert.deepEqual(updates.at(-1), { power: 1 });
});

test('repeated start does not rediscover or create another poll loop', async t => {
  const context = await controllerFor(t);
  await context.controller.start(() => { throw new Error('must not run'); });
  assert.equal(context.counts.discovery, 1);
});

test('slow polling does not overlap, and stop suppresses late state updates', async t => {
  const context = await controllerFor(t, {}, { pollInterval: 0.01 });
  const gate = deferred();
  let calls = 0;
  context.device.getVolume = async () => { calls++; return gate.promise; };
  const updates = [];
  context.controller.subscribe(update => updates.push(update));
  await delay(50);
  assert.equal(calls, 1);
  context.controller.stop();
  context.controller.stop();
  gate.resolve(99);
  await delay(25);
  assert.deepEqual(updates, []);
  assert.equal(calls, 1);
  assert.equal(context.counts.close, 1);
  await assert.rejects(context.controller.getVolume(), /closed/);
});

test('a controller read has a deadline even while waiting for an unresponsive write', async t => {
  const context = await controllerFor(t, {}, { requestTimeout: 20 });
  const command = deferred();
  context.device.setMute = () => command.promise;
  const writing = context.controller.setMute(true);
  await assert.rejects(context.controller.getMute(), /timed out/);
  command.resolve();
  await writing;
  assert.equal(context.controller.state.mute, true);
});

test('older command acknowledgements cannot overwrite a newer result', async t => {
  const context = await controllerFor(t);
  const first = deferred();
  context.device.setVolume = volume => volume === 10 ? first.promise : Promise.resolve();
  const older = context.controller.setVolume(10);
  await context.controller.setVolume(80);
  first.resolve();
  await older;
  assert.equal(context.controller.state.volume, 80);
});

test('shutdown rejects waiting reads immediately even if a device never settles its promise', async t => {
  const context = await controllerFor(t);
  const gate = deferred();
  context.device.getMute = () => gate.promise;
  const reading = context.controller.getMute();
  const rejected = assert.rejects(reading, /closed/);
  await delay(0);
  context.controller.stop();
  await rejected;
  assert.equal(context.controller.state.mute, false);
});

test('discovery and adapter setup failures retry, and a late discovery cannot publish after stop', async t => {
  let discoveries = 0;
  let setups = 0;
  const ready = deferred();
  const context = await controllerFor(t);
  const device = {
    ...context.device,
    listInputs: async () => {
      discoveries++;
      if (discoveries === 1) { throw new Error('offline'); }
      return [{ name: 'HDMI', displayName: 'TV Audio' }];
    },
  };
  const controller = new SoundbarController(device, { pollInterval: 0, requestTimeout: 500, retryInterval: 5 });
  t.after(() => controller.stop());
  await controller.start(() => {
    setups++;
    if (setups === 1) { throw new Error('adapter not ready'); }
    ready.resolve();
  });
  for (let attempt = 0; attempt < 100 && setups < 2; attempt++) {
    await delay(5);
  }
  assert.equal(setups, 2);
  await ready.promise;
  assert.equal(discoveries, 3);
  assert.equal(setups, 2);

  const gate = deferred();
  const late = new SoundbarController({ ...device, listInputs: () => gate.promise }, { pollInterval: 0, requestTimeout: 500 });
  const launching = late.start(() => { throw new Error('must not publish'); });
  late.stop();
  gate.resolve([{ name: 'HDMI', displayName: 'TV Audio' }]);
  await launching;
});


test('a response arriving after the controller deadline cannot clear an unavailable state', async t => {
  const context = await controllerFor(t, {}, { requestTimeout: 20 });
  const gate = deferred();
  context.device.getVolume = () => gate.promise;
  await assert.rejects(context.controller.getVolume(), /timed out/);
  gate.resolve(50);
  await delay(0);
  assert.match(context.controller.state.volume.message, /timed out/);
});
