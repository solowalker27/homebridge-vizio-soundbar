import { Agent, request } from 'node:https';
import type { ClientRequest } from 'node:http';
import type { SoundbarConfig } from './config.js';
import { silentDiagnostics } from './diagnostics.js';
import type { Diagnostics } from './diagnostics.js';

const AUDIO = '/menu_native/dynamic/audio_settings/audio';
const INPUT = '/menu_native/dynamic/audio_settings/input';
const MAX_RESPONSE_BYTES = 1024 * 1024;

type JsonObject = Record<string, unknown>;
export interface SoundbarInput { name: string; displayName: string }

function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class SmartCastClient {
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 5, maxFreeSockets: 5, rejectUnauthorized: false });
  private readonly pending = new Set<ClientRequest>();
  private closed = false;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: SoundbarConfig, private readonly diagnostics: Diagnostics = silentDiagnostics) {
    this.diagnostics.debug('SmartCast client initialized', {
      endpoint: config.endpoint.origin, requestTimeout: config.requestTimeout,
      hasAuthToken: Boolean(config.authToken),
      automaticAuthRefresh: false,
    });
  }

  close(): void {
    this.diagnostics.debug('SmartCast client shutdown', { pendingRequests: this.pending.size });
    this.closed = true;
    for (const req of this.pending) {
      req.destroy(new Error('Soundbar client shut down'));
    }
    this.agent.destroy();
  }

  private async request(method: 'GET' | 'PUT', path: string, body?: JsonObject, deadline?: number): Promise<JsonObject> {
    if (this.closed) {
      return Promise.reject(new Error('Soundbar client is closed'));
    }
    const timeout = Math.min(this.config.requestTimeout, (deadline ?? Infinity) - Date.now());
    if (timeout <= 0) {
      return Promise.reject(new Error('Soundbar command timed out while waiting for earlier commands'));
    }
    const requestId = this.diagnostics.nextId();
    const started = performance.now();
    const command = method === 'PUT' ? this.commandName(path, body) : undefined;
    const details = { requestId, method, path, command, endpoint: this.config.endpoint.origin };
    if (command) {
      this.diagnostics.audit('Sending soundbar command', { ...details, body });
    }
    this.diagnostics.debug('SmartCast HTTP request', {
      ...details, timeout, hasAuthToken: Boolean(this.config.authToken), body,
    });
    try {
      const result = await new Promise<JsonObject>((resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const headers: Record<string, string | number> = { Accept: 'application/json' };
        if (this.config.authToken) {
          headers.AUTH = this.config.authToken;
        }
        if (data !== undefined) {
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(data);
        }
        const req = request(new URL(path, this.config.endpoint), { method, headers, agent: this.agent }, res => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy(new Error('Soundbar response exceeded 1 MiB'));
            } else {
              chunks.push(chunk);
            }
          });
          res.on('error', reject);
          res.on('aborted', () => reject(new Error('Soundbar response was interrupted')));
          res.on('end', () => {
            let result: unknown;
            let validJson = true;
            try {
              result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              validJson = false;
            }
            this.diagnostics.debug('SmartCast HTTP response', {
              ...details, statusCode: res.statusCode, durationMs: Math.round(performance.now() - started),
              bytes: size, body: validJson ? result : '[non-JSON body omitted]',
            });
            if (res.statusCode === 401 || res.statusCode === 403) {
              this.diagnostics.debug('SmartCast authentication rejected; automatic token refresh is not supported', {
                requestId, statusCode: res.statusCode,
              });
            }
            if (res.statusCode === undefined || res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`Soundbar HTTP error ${res.statusCode ?? 'unknown'}`));
              return;
            }
            if (!validJson) {
              // Never log arbitrary non-JSON responses or JSON.parse errors, which can contain secrets.
              reject(new Error('Soundbar returned invalid JSON'));
              return;
            }
            if (!object(result) || !object(result.STATUS) || result.STATUS.RESULT !== 'SUCCESS') {
              if (object(result) && object(result.STATUS) && typeof result.STATUS.RESULT === 'string'
                && /AUTH|TOKEN|PAIR/i.test(result.STATUS.RESULT)) {
                this.diagnostics.debug('SmartCast authentication/pairing status rejected; automatic token refresh is not supported', {
                  requestId, status: result.STATUS,
                });
              }
              reject(new Error('Soundbar rejected the request or returned an invalid status'));
              return;
            }
            resolve(result);
          });
        });
        // A wall-clock deadline also covers DNS/TLS and peers that never finish their response.
        const timer = setTimeout(() => req.destroy(new Error(`Soundbar request timed out after ${timeout} ms`)), timeout);
        this.pending.add(req);
        req.on('error', reject);
        req.on('close', () => {
          clearTimeout(timer);
          this.pending.delete(req);
        });
        req.end(data);
      });
      if (command) {
        this.diagnostics.audit('Soundbar command acknowledged', {
          ...details, durationMs: Math.round(performance.now() - started),
        });
      }
      return result;
    } catch (error) {
      const failure = { ...details, durationMs: Math.round(performance.now() - started), error };
      this.diagnostics.debug('SmartCast HTTP request failed', failure);
      if (command) {
        this.diagnostics.audit('Soundbar command failed', failure);
      }
      throw error;
    }
  }

  private commandName(path: string, body?: JsonObject): string {
    if (path === `${AUDIO}/volume`) {
      return 'volume.set';
    }
    if (path === `${INPUT}/current_input`) {
      return 'input.set';
    }
    const keys = body?.KEYLIST;
    const key: unknown = Array.isArray(keys) ? keys[0] : undefined;
    if (object(key)) {
      const names: Record<string, string> = {
        '11:0': 'power.off', '11:1': 'power.on', '5:0': 'volume.down', '5:1': 'volume.up',
        '5:2': 'mute.off', '5:3': 'mute.on', '2:0': 'remote.fastForward', '2:1': 'remote.rewind',
      };
      return names[`${key.CODESET}:${key.CODE}`] ?? `key.${key.CODESET}.${key.CODE}`;
    }
    return 'unknown';
  }

  private async item(path: string, deadline?: number): Promise<JsonObject> {
    const result = await this.request('GET', path, undefined, deadline);
    const first: unknown = Array.isArray(result.ITEMS) ? result.ITEMS[0] : undefined;
    if (!object(first) || !Object.hasOwn(first, 'VALUE')) {
      throw new Error('Soundbar response is missing ITEMS[0].VALUE');
    }
    return first;
  }

  async listInputs(): Promise<SoundbarInput[]> {
    const result = await this.request('GET', INPUT);
    if (!Array.isArray(result.ITEMS)) {
      throw new Error('Soundbar response is missing its input list');
    }
    const inputs = new Map<string, SoundbarInput>();
    for (const item of result.ITEMS as unknown[]) {
      if (!object(item) || typeof item.NAME !== 'string' || !item.NAME.trim()) {
        throw new Error('Soundbar returned an invalid input name');
      }
      const name = item.NAME;
      if (name.toLowerCase().replaceAll('_', ' ').trim() === 'current input') {
        continue;
      }
      const displayName = object(item.VALUE) && typeof item.VALUE.NAME === 'string' && item.VALUE.NAME.trim()
        ? item.VALUE.NAME.trim() : name;
      inputs.set(name, { name, displayName });
    }
    if (inputs.size === 0) {
      throw new Error('Soundbar returned no selectable inputs');
    }
    return [...inputs.values()];
  }

  async getPower(): Promise<number> {
    const { VALUE } = await this.item('/state/device/power_mode');
    if (VALUE !== 0 && VALUE !== 1 && VALUE !== '0' && VALUE !== '1') {
      throw new Error('Soundbar returned an invalid power mode');
    }
    return Number(VALUE);
  }

  async getInput(): Promise<string> {
    const { VALUE } = await this.item(`${INPUT}/current_input`);
    if (typeof VALUE !== 'string' || !VALUE.trim()) {
      throw new Error('Soundbar returned an invalid current input');
    }
    return VALUE;
  }

  async getVolume(): Promise<number> {
    const { VALUE } = await this.item(`${AUDIO}/volume`);
    const volume = typeof VALUE === 'string' && VALUE.trim() ? Number(VALUE) : VALUE;
    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 100) {
      throw new Error('Soundbar returned an invalid volume');
    }
    return Math.round(volume);
  }

  async getMute(): Promise<boolean> {
    const { VALUE } = await this.item(`${AUDIO}/mute`);
    if (VALUE === 'On' || VALUE === 1 || VALUE === true) {
      return true;
    }
    if (VALUE === 'Off' || VALUE === 0 || VALUE === false) {
      return false;
    }
    throw new Error('Soundbar returned an invalid mute state');
  }

  // Serialize writes so hash-based read/modify/write operations cannot race each other.
  // Expire queued commands as well as network requests to stay within HomeKit's response window.
  private write(command: string, operation: (deadline: number) => Promise<unknown>): Promise<void> {
    const queued = performance.now();
    this.diagnostics.debug('SmartCast command queued', { command });
    const deadline = Date.now() + this.config.requestTimeout * 2;
    const result = this.writes.then(async () => {
      if (this.closed || Date.now() >= deadline) {
        this.diagnostics.audit('Soundbar command not sent: expired in queue or client shut down', { command });
        throw new Error('Soundbar command expired or client shut down');
      }
      this.diagnostics.debug('SmartCast command dequeued', { command, waitMs: Math.round(performance.now() - queued) });
      await operation(deadline);
    });
    this.writes = result.catch(() => undefined);
    return result;
  }

  private async modify(path: string, value: string | number, deadline: number): Promise<void> {
    const current = await this.item(path, deadline);
    if (typeof current.HASHVAL !== 'number' && typeof current.HASHVAL !== 'string') {
      throw new Error('Soundbar response is missing HASHVAL');
    }
    await this.request('PUT', path, { REQUEST: 'MODIFY', HASHVAL: current.HASHVAL, VALUE: value }, deadline);
  }

  setInput(name: string): Promise<void> {
    return this.write('input.set', deadline => this.modify(`${INPUT}/current_input`, name, deadline));
  }

  setVolume(volume: number): Promise<void> {
    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
      return Promise.reject(new Error('Volume must be between 0 and 100'));
    }
    return this.write('volume.set', deadline => this.modify(`${AUDIO}/volume`, Math.round(volume), deadline));
  }

  key(codeset: number, code: number): Promise<void> {
    return this.write(`key.${codeset}.${code}`, deadline => this.request('PUT', '/key_command/', {
      KEYLIST: [{ CODESET: codeset, CODE: code, ACTION: 'KEYPRESS' }],
    }, deadline));
  }

  setPower(active: boolean): Promise<void> { return this.key(11, active ? 1 : 0); }
  setMute(muted: boolean): Promise<void> { return this.key(5, muted ? 3 : 2); }
  changeVolume(up: boolean): Promise<void> { return this.key(5, up ? 1 : 0); }
}
