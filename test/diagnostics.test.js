import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SoundbarDiagnostics } from '../dist/diagnostics.js';
import { SmartCastClient } from '../dist/client.js';
import { SoundbarController } from '../dist/controller.js';
import { parseConfig } from '../dist/config.js';
import { AUDIO, fakeSoundbar, success } from './helpers.js';

function logger(enabled = false, token) {
  const lines = [];
  const diagnostics = new SoundbarDiagnostics({ info: line => lines.push(line) }, enabled, token);
  return { lines, diagnostics };
}

async function deviceFor(t, enabled = false, handler, token) {
  const device = await fakeSoundbar(t, handler);
  const { lines, diagnostics } = logger(enabled, token);
  const options = parseConfig({ platform: 'test', ip: device.ip, pollInterval: 0, authToken: token });
  const client = new SmartCastClient(options, diagnostics);
  t.after(() => client.close());
  return { ...device, client, options, lines, diagnostics };
}

test('command audit remains visible while debug mode is off and reads stay quiet', async t => {
  const { client, lines } = await deviceFor(t);
  await client.getPower();
  await client.getVolume();
  assert.deepEqual(lines, []);
  await client.setPower(true);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\[Command\].*Sending soundbar command/);
  assert.match(lines[0], /power.on/);
  assert.match(lines[0], /"CODESET":11,"CODE":1/);
  assert.match(lines[1], /acknowledged/);
  const first = JSON.parse(lines[0].slice(lines[0].indexOf('{')));
  const second = JSON.parse(lines[1].slice(lines[1].indexOf('{')));
  assert.equal(first.details.requestId, second.details.requestId);
});

test('verbose diagnostics show requests, responses, queues and static auth mode through info logging', async t => {
  const { client, lines, requests } = await deviceFor(t, true, undefined, 'actual-secret');
  await client.setVolume(33);
  const output = lines.join('\n');
  assert.match(output, /SmartCast HTTP request/);
  assert.match(output, /SmartCast HTTP response/);
  assert.match(output, /"method":"GET"/);
  assert.match(output, /"method":"PUT"/);
  assert.match(output, /"VALUE":33/);
  assert.match(output, /command queued/);
  assert.match(output, /command dequeued/);
  assert.match(output, /"hasAuthToken":true/);
  assert.match(output, /"automaticAuthRefresh":false/);
  assert.ok(!output.includes('actual-secret'));
  assert.ok(requests.every(request => request.headers.auth === 'actual-secret'));
});

test('redacts nested credentials and configured secrets in strings and errors', () => {
  const { diagnostics, lines } = logger(true, 'configured-secret');
  diagnostics.debug('Credentials', {
    AUTH: 'server-token', access_token: 'access-token-value', nested: { password: 'password-value',
      items: [{ refreshToken: 'refresh-token-value', API_KEY: 'api-key-value' }] },
    error: new Error('request failed with configured-secret'), value: 'configured-secret',
  });
  const output = lines.join('\n');
  for (const secret of ['server-token', 'access-token-value', 'password-value', 'refresh-token-value', 'api-key-value', 'configured-secret']) {
    assert.ok(!output.includes(secret), secret);
  }
  assert.match(output, /REDACTED/);
});

test('does not log arbitrary malformed response bodies', async t => {
  const { client, lines } = await deviceFor(t, true, (_req, res) => {
    res.end('unexpected private token: never-log-this');
    return true;
  });
  await assert.rejects(client.getVolume(), /invalid JSON/);
  const output = lines.join('\n');
  assert.ok(!output.includes('never-log-this'));
  assert.match(output, /non-JSON body omitted/);
  assert.match(output, /request failed/);
});

test('HTTP authentication failures are visible without retrying or inventing token refreshes', async t => {
  const { client, lines, requests } = await deviceFor(t, true, (_req, res) => {
    res.writeHead(401);
    res.end(JSON.stringify({ STATUS: { RESULT: 'UNAUTHORIZED' }, AUTH_TOKEN: 'returned-secret' }));
    return true;
  });
  await assert.rejects(client.getMute(), /HTTP error 401/);
  assert.match(lines.join('\n'), /authentication rejected; automatic token refresh is not supported/);
  assert.ok(!lines.join('\n').includes('returned-secret'));
  assert.equal(requests.length, 1);
});

test('failed commands record their outcome at normal log level', async t => {
  const { client, lines } = await deviceFor(t, false, (_req, res) => {
    res.end(JSON.stringify({ STATUS: { RESULT: 'FAILURE' } }));
    return true;
  });
  await assert.rejects(client.setPower(true));
  assert.match(lines.join('\n'), /Sending soundbar command/);
  assert.match(lines.join('\n'), /Soundbar command failed/);
  assert.ok(!lines.join('\n').includes('acknowledged'));
});

test('source metadata follows each queued command instead of leaking between concurrent callers', async t => {
  const { client, lines, diagnostics } = await deviceFor(t, false, async req => {
    if (req.method === 'PUT') { await delay(10); }
  });
  await Promise.all([
    diagnostics.run({ source: 'HomeKit SET', client: '10.0.0.10', operationId: 'first' }, () => client.setPower(true)),
    diagnostics.run({ source: 'HomeKit SET', client: '10.0.0.20', operationId: 'second' }, () => client.setMute(true)),
  ]);
  const outgoing = lines.filter(line => line.includes('Sending soundbar command'))
    .map(line => JSON.parse(line.slice(line.indexOf('{'))));
  assert.equal(outgoing[0].operationId, 'first');
  assert.equal(outgoing[0].client, '10.0.0.10');
  assert.equal(outgoing[1].operationId, 'second');
  assert.equal(outgoing[1].client, '10.0.0.20');
});

test('polling/discovery only issue GETs and cannot send power or remote commands', async t => {
  const { client, options, lines, diagnostics, requests } = await deviceFor(t, true);
  const controller = new SoundbarController(client, options, () => undefined, diagnostics);
  t.after(() => controller.stop());
  await controller.start(() => undefined);
  await controller.refresh();
  await controller.refresh();
  assert.ok(requests.every(request => request.method === 'GET'));
  assert.ok(!requests.some(request => request.path === '/key_command/'));
  assert.ok(!lines.some(line => line.includes('[Command]')));
  assert.match(lines.join('\n'), /Poll started/);
  assert.match(lines.join('\n'), /Poll completed/);
  assert.match(lines.join('\n'), /Input discovery/);
  assert.match(lines.join('\n'), /"source":"poll"/);
  assert.match(lines.join('\n'), /"source":"discovery"/);
});

test('response payloads are available in debug mode with secrets redacted', async t => {
  const { client, lines } = await deviceFor(t, true, (req, res) => {
    if (req.path === `${AUDIO}/volume`) {
      res.end(JSON.stringify(success([{ VALUE: 24, HASHVAL: 9, AUTH_TOKEN: 'do-not-log' }])));
      return true;
    }
  });
  assert.equal(await client.getVolume(), 24);
  assert.match(lines.join('\n'), /"VALUE":24,"HASHVAL":9/);
  assert.ok(!lines.join('\n').includes('do-not-log'));
});

test('a failing log sink cannot prevent a device command', async t => {
  const device = await fakeSoundbar(t);
  const diagnostics = new SoundbarDiagnostics({ info: () => { throw new Error('log sink failed'); } }, true);
  const client = new SmartCastClient(parseConfig({ platform: 'test', ip: device.ip }), diagnostics);
  t.after(() => client.close());
  await client.setPower(false);
  assert.equal(device.state.power, 0);
});

test('API-level authentication failures are diagnosed even when HTTP status is 200', async t => {
  const { client, lines, requests } = await deviceFor(t, true, (_req, res) => {
    res.end(JSON.stringify({ STATUS: { RESULT: 'INVALID_AUTH_TOKEN' } }));
    return true;
  });
  await assert.rejects(client.getPower(), /rejected/);
  assert.match(lines.join('\n'), /authentication\/pairing status rejected/);
  assert.match(lines.join('\n'), /INVALID_AUTH_TOKEN/);
  assert.equal(requests.length, 1);
});

test('large debug entries are bounded and cyclic details do not break the logger', () => {
  const { diagnostics, lines } = logger(true);
  diagnostics.debug('Large result', { VALUE: 'x'.repeat(20000) });
  assert.ok(lines[0].length < 16500);
  assert.match(lines[0], /truncated/);
  const cycle = {};
  cycle.value = cycle;
  diagnostics.debug('Recursive result', cycle);
  assert.match(lines[1], /depth limit/);
});

test('power/input observations are logged separately from commands even without verbose logging', async t => {
  const { client, state, options, lines, diagnostics, requests } = await deviceFor(t);
  const controller = new SoundbarController(client, options, () => undefined, diagnostics);
  t.after(() => controller.stop());
  await controller.start(() => undefined);
  await controller.refresh();
  lines.length = 0;
  state.power = 0;
  state.input = 'Optical';
  await controller.refresh();
  assert.equal(lines.length, 2);
  assert.ok(lines.every(line => line.startsWith('[State]')));
  assert.match(lines.join('\n'), /"property":"power","previous":1,"current":0/);
  assert.match(lines.join('\n'), /"property":"input","previous":"HDMI","current":"Optical"/);
  assert.ok(requests.every(request => request.method === 'GET'));
});
