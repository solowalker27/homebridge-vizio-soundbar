import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../dist/config.js';

const config = overrides => parseConfig({ platform: 'HomebridgeVizioSoundbar', ip: '192.168.1.2', ...overrides });

test('keeps old ip/name config and accepts explicit ports and IPv6', () => {
  assert.equal(config().endpoint.href, 'https://192.168.1.2:9000/');
  assert.equal(config({ ip: 'soundbar.local:7345' }).endpoint.port, '7345');
  assert.equal(config({ ip: '[::1]' }).endpoint.href, 'https://[::1]:9000/');
  assert.equal(config({ ip: 'localhost:443' }).endpoint.href, 'https://localhost/');
  assert.equal(config({ name: '  Living Room  ' }).name, 'Living Room');
  assert.equal(config().pollInterval, 30);
});

test('rejects missing hosts, URLs, credentials, paths, and invalid tuning options', () => {
  for (const ip of [undefined, '', 'http://localhost', 'localhost/path', 'user:pass@localhost', 'localhost?x', 'localhost#x']) {
    assert.throws(() => config({ ip }));
  }
  for (const pollInterval of [-1, 1, 9, 3601, '30', NaN]) {
    assert.throws(() => config({ pollInterval }));
  }
  for (const requestTimeout of [0, 499, 4001, 500.5, '1000']) {
    assert.throws(() => config({ requestTimeout }));
  }
  for (const name of ['', ' ', 5, 'a'.repeat(65)]) {
    assert.throws(() => config({ name }));
  }
  assert.throws(() => config({ authToken: 'x\r\ny' }));
  assert.equal(config({ pollInterval: 0 }).pollInterval, 0);
});
