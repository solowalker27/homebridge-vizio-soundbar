import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
// Test harness only: instantiate Homebridge's real API and HAP objects without starting mDNS.
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';

export const INPUT = '/menu_native/dynamic/audio_settings/input';
export const AUDIO = '/menu_native/dynamic/audio_settings/audio';
export const success = (ITEMS = []) => ({ STATUS: { RESULT: 'SUCCESS' }, ITEMS });

export async function fakeSoundbar(t, handler) {
  const [key, cert] = await Promise.all([
    readFile(new URL('./fixtures/key.pem', import.meta.url)),
    readFile(new URL('./fixtures/cert.pem', import.meta.url)),
  ]);
  const requests = [];
  const state = { volume: 20, power: 1, muted: false, input: 'HDMI', hash: 1 };
  const sockets = new Set();
  const server = createServer({ key, cert }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    const entry = { method: req.method, path: req.url, headers: req.headers, body };
    requests.push(entry);
    if (handler && await handler(entry, res, state)) {
      return;
    }
    let response = success();
    if (req.method === 'GET') {
      const value = req.url === `${AUDIO}/volume` ? state.volume
        : req.url === `${AUDIO}/mute` ? (state.muted ? 'On' : 'Off')
          : req.url === `${INPUT}/current_input` ? state.input : state.power;
      response = req.url === INPUT ? success([
        { NAME: 'Current Input', VALUE: state.input },
        { NAME: 'HDMI', VALUE: { NAME: 'TV Audio' } },
        { NAME: 'Optical', VALUE: { NAME: 'Optical' } },
        { NAME: 'Bluetooth', VALUE: { NAME: 'Bluetooth' } },
      ]) : success([{ VALUE: value, HASHVAL: state.hash }]);
    } else if (req.url === '/key_command/') {
      const { CODESET, CODE } = body.KEYLIST[0];
      if (CODESET === 11) {
        state.power = CODE;
      } else if (CODESET === 5) {
        if (CODE < 2) {
          state.volume += CODE === 1 ? 1 : -1;
        } else {
          state.muted = CODE === 3;
        }
      }
    } else {
      if (body.HASHVAL !== state.hash) {
        response = { STATUS: { RESULT: 'HASHVAL_MISMATCH' } };
      } else {
        state.hash++;
        if (req.url === `${AUDIO}/volume`) {
          state.volume = body.VALUE;
        } else if (req.url === `${INPUT}/current_input`) {
          state.input = body.VALUE;
        }
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise(resolve => server.close(resolve));
  });
  return { ip: `127.0.0.1:${server.address().port}`, requests, state, server };
}

export function apiFor(storage) {
  const api = new HomebridgeAPI();
  api.user = { storagePath: () => storage };
  const logs = [];
  const log = Object.assign((...args) => logs.push(args), Object.fromEntries(
    ['debug', 'info', 'warn', 'error', 'success', 'log'].map(key => [key, (...args) => logs.push(args)]),
  ));
  return { api, log, logs };
}

export async function until(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for test condition');
    }
    await delay(5);
  }
}
