import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SmartCastClient } from '../dist/client.js';
import { parseConfig } from '../dist/config.js';
import { AUDIO, INPUT, fakeSoundbar, success } from './helpers.js';

async function clientFor(t, handler, options = {}) {
  const device = await fakeSoundbar(t, handler);
  const client = new SmartCastClient(parseConfig({ platform: 'test', ip: device.ip, ...options }));
  t.after(() => client.close());
  return { ...device, client };
}

test('reads soundbar state and distinguishes selectable inputs from Current Input', async t => {
  const { client } = await clientFor(t);
  assert.deepEqual(await client.listInputs(), [
    { name: 'HDMI', displayName: 'TV Audio' },
    { name: 'Optical', displayName: 'Optical' },
    { name: 'Bluetooth', displayName: 'Bluetooth' },
  ]);
  assert.equal(await client.getPower(), 1);
  assert.equal(await client.getInput(), 'HDMI');
  assert.equal(await client.getVolume(), 20);
  assert.equal(await client.getMute(), false);
});

test('sends authenticated absolute volume/input writes with fresh hashes and correct key commands', async t => {
  const { client, requests, state } = await clientFor(t, undefined, { authToken: 'test-token' });
  await client.setVolume(34.6);
  await client.setInput('Optical');
  await client.setMute(true);
  await client.setPower(false);
  await client.changeVolume(false);
  assert.equal(state.volume, 34);
  assert.equal(state.input, 'Optical');
  assert.equal(state.muted, true);
  assert.equal(state.power, 0);
  assert.ok(requests.every(req => req.headers.auth === 'test-token'));
  assert.deepEqual(requests[1].body, { REQUEST: 'MODIFY', HASHVAL: 1, VALUE: 35 });
  assert.deepEqual(requests[3].body, { REQUEST: 'MODIFY', HASHVAL: 2, VALUE: 'Optical' });
  assert.deepEqual(requests.slice(4).map(req => req.body.KEYLIST[0]), [
    { CODESET: 5, CODE: 3, ACTION: 'KEYPRESS' },
    { CODESET: 11, CODE: 0, ACTION: 'KEYPRESS' },
    { CODESET: 5, CODE: 0, ACTION: 'KEYPRESS' },
  ]);
});

test('serializes read-modify-write operations to avoid stale hash collisions', async t => {
  const { client, requests, state } = await clientFor(t, async req => {
    if (req.method === 'GET') {
      await delay(15);
    }
    return false;
  });
  await Promise.all([client.setVolume(10), client.setInput('Bluetooth'), client.setVolume(90)]);
  assert.equal(state.volume, 90);
  assert.equal(state.input, 'Bluetooth');
  assert.deepEqual(requests.map(req => req.method), ['GET', 'PUT', 'GET', 'PUT', 'GET', 'PUT']);
});

test('a failed command rejects without breaking the write queue', async t => {
  let reject = true;
  const { client, state } = await clientFor(t, (req, res) => {
    if (req.method === 'PUT' && reject) {
      reject = false;
      res.end(JSON.stringify({ STATUS: { RESULT: 'FAILURE' } }));
      return true;
    }
  });
  await assert.rejects(client.setVolume(35), /rejected/);
  await client.setVolume(40);
  assert.equal(state.volume, 40);
});

for (const [label, reply, pattern] of [
  ['HTTP errors', res => { res.writeHead(500); res.end('{}'); }, /HTTP error 500/],
  ['invalid JSON', res => res.end('not-json'), /JSON|Unexpected/],
  ['API failure', res => res.end(JSON.stringify({ STATUS: { RESULT: 'FAILURE' } })), /rejected/],
  ['missing status', res => res.end('{}'), /invalid status/],
  ['empty items', res => res.end(JSON.stringify(success())), /missing ITEMS/],
  ['invalid volume', res => res.end(JSON.stringify(success([{ VALUE: 101 }]))), /invalid volume/],
  ['oversized responses', res => res.end(' '.repeat(1024 * 1024 + 1)), /exceeded/],
]) {
  test(`rejects ${label}`, async t => {
    const { client } = await clientFor(t, (_req, res) => { reply(res); return true; });
    await assert.rejects(client.getVolume(), pattern);
  });
}

test('network failures and partial responses reject instead of hanging', async t => {
  const { client } = await clientFor(t, (_req, res) => {
    res.writeHead(200, { 'Content-Length': '1000' });
    res.write('{');
    res.destroy();
    return true;
  });
  await assert.rejects(client.getMute());
});

test('deadline covers a stalled request and queued writes', async t => {
  const { client, requests } = await clientFor(t, () => true, { requestTimeout: 500 });
  const start = Date.now();
  const outcomes = await Promise.allSettled([
    client.setVolume(10), client.setVolume(20), client.setVolume(30), client.getMute(),
  ]);
  assert.ok(outcomes.every(result => result.status === 'rejected'));
  assert.ok(Date.now() - start < 1800);
  assert.ok(requests.length <= 4);
});

test('shutdown aborts pending requests and prevents future network work', async t => {
  const { client } = await clientFor(t, () => true);
  const pending = client.getPower();
  const rejected = assert.rejects(pending);
  client.close();
  await rejected;
  await assert.rejects(client.getPower(), /closed/);
  await assert.rejects(client.setPower(true), /shut down/);
});

test('requires HASHVAL and rejects invalid volume before issuing writes', async t => {
  const { client, requests } = await clientFor(t, (_req, res) => {
    res.end(JSON.stringify(success([{ VALUE: 25 }])));
    return true;
  });
  await assert.rejects(client.setVolume(10), /HASHVAL/);
  for (const value of [NaN, Infinity, -1, 101]) {
    await assert.rejects(client.setVolume(value), /between/);
  }
  assert.equal(requests.length, 1);
});

test('validates malformed power, mute, input and input list responses', async t => {
  const { client } = await clientFor(t, (req, res) => {
    res.end(JSON.stringify(success(req.path === INPUT ? [{ NAME: 'Current Input' }] : [{ VALUE: {} }])));
    return true;
  });
  await assert.rejects(client.getPower(), /power/);
  await assert.rejects(client.getMute(), /mute/);
  await assert.rejects(client.getInput(), /input/);
  await assert.rejects(client.listInputs(), /no selectable inputs/);
});

test('normalizes numeric strings without treating an empty volume as zero', async t => {
  let volume = '42';
  const { client } = await clientFor(t, (req, res) => {
    const value = req.path === `${AUDIO}/volume` ? volume : '1';
    res.end(JSON.stringify(success([{ VALUE: value }])));
    return true;
  });
  assert.equal(await client.getVolume(), 42);
  assert.equal(await client.getPower(), 1);
  volume = '';
  await assert.rejects(client.getVolume(), /invalid volume/);
});
