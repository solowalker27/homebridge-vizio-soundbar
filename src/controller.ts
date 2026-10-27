import type { SmartCastClient, SoundbarInput } from './client.js';

export interface SoundbarState {
  power: number;
  volume: number;
  mute: boolean;
  input: string;
}
export type SoundbarUpdate = { [K in keyof SoundbarState]?: SoundbarState[K] | Error };
type Property = keyof SoundbarState;
type Listener = (update: Readonly<SoundbarUpdate>) => void;
type Device = Pick<SmartCastClient,
  'listInputs' | 'getPower' | 'getVolume' | 'getMute' | 'getInput' |
  'setPower' | 'setVolume' | 'setMute' | 'setInput' | 'changeVolume' | 'key' | 'close'>;
interface Options { pollInterval: number; requestTimeout: number; retryInterval?: number }
const properties: Property[] = ['power', 'volume', 'mute', 'input'];

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Shared device lifecycle and state. Protocol adapters only translate controls and notifications. */
export class SoundbarController {
  private readonly listeners = new Set<Listener>();
  private readonly cancelReads = new Set<() => void>();
  private readonly revisions: Record<Property, number> = { power: 0, volume: 0, mute: 0, input: 0 };
  private readonly writes = new Map<Property, Promise<void>>();
  private readonly reads = new Map<Property, { revision: number; promise: Promise<SoundbarState[Property]> }>();
  private readonly getters: { [K in Property]: () => Promise<SoundbarState[K]> };
  private readonly current: SoundbarUpdate = {};
  private readonly inputNames = new Map<string, string>();
  private readonly inputAliases = new Map<string, string>();
  private starting?: Promise<void>;
  private retryTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly device: Device,
    private readonly options: Options,
    private readonly onError: (error: Error, operation: string) => void = () => undefined,
  ) {
    this.getters = {
      power: () => device.getPower(), volume: () => device.getVolume(), mute: () => device.getMute(),
      input: async () => this.resolveInput(await device.getInput()),
    };
  }

  get state(): Readonly<SoundbarUpdate> { return { ...this.current }; }

  subscribe(listener: Listener): () => void {
    this.ensureOpen();
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(ready: (inputs: readonly SoundbarInput[]) => void | Promise<void>): Promise<void> {
    this.ensureOpen();
    this.starting ??= this.discover(ready);
    return this.starting;
  }

  private async discover(ready: (inputs: readonly SoundbarInput[]) => void | Promise<void>): Promise<void> {
    try {
      const inputs = await this.device.listInputs();
      this.ensureOpen();
      this.inputNames.clear();
      this.inputAliases.clear();
      for (const input of inputs) {
        this.inputNames.set(input.name.toLowerCase(), input.name);
        const alias = input.displayName.toLowerCase();
        if (!this.inputAliases.has(alias)) {
          this.inputAliases.set(alias, input.name);
        }
      }
      // Await adapter setup so no partially configured accessory starts polling.
      await ready(inputs);
      this.ensureOpen();
      void this.poll();
    } catch (error) {
      if (!this.stopped) {
        this.onError(asError(error), 'discovery');
        this.retryTimer = setTimeout(() => { void this.discover(ready); }, this.options.retryInterval ?? 30_000);
        this.retryTimer.unref();
      }
    }
  }

  private resolveInput(name: string): string {
    const key = name.toLowerCase();
    const canonical = this.inputNames.get(key) ?? this.inputAliases.get(key);
    if (canonical === undefined) {
      throw new Error('Soundbar selected an input that was not discovered');
    }
    return canonical;
  }

  private ensureOpen(): void {
    if (this.stopped) {
      throw new Error('Soundbar controller is closed');
    }
  }

  private publish<K extends Property>(key: K, value: SoundbarState[K] | Error): void {
    if (this.stopped) {
      return;
    }
    const previous = this.current[key];
    if (Object.is(previous, value) || (previous instanceof Error && value instanceof Error && previous.message === value.message)) {
      return;
    }
    this.current[key] = value;
    if (value instanceof Error) {
      this.onError(value, key);
    }
    for (const listener of this.listeners) {
      try {
        listener({ [key]: value });
      } catch (error) {
        this.onError(asError(error), 'subscriber');
      }
    }
  }

  private read<K extends Property>(key: K): Promise<SoundbarState[K]> {
    if (this.stopped) {
      return Promise.reject(new Error('Soundbar controller is closed'));
    }
    const revision = this.revisions[key];
    const existing = this.reads.get(key);
    if (existing?.revision === revision) {
      return existing.promise as Promise<SoundbarState[K]>;
    }
    const deadline = Date.now() + this.options.requestTimeout * 2;
    let expired = false;
    const checkDeadline = () => {
      this.ensureOpen();
      if (expired || Date.now() >= deadline) {
        throw new Error('Soundbar state read timed out');
      }
    };
    const barrier = this.writes.get(key);
    const work = (async () => {
      // Reads requested during a write wait for its acknowledgement, including failed writes.
      await barrier?.catch(() => undefined);
      checkDeadline();
      if (revision !== this.revisions[key]) {
        return this.read(key);
      }
      let value: SoundbarState[K];
      try {
        value = await this.getters[key]();
      } catch (error) {
        checkDeadline();
        if (revision !== this.revisions[key]) {
          return this.read(key);
        }
        throw error;
      }
      checkDeadline();
      // Re-read rather than returning an obsolete value to the adapter's own GET handler.
      if (revision !== this.revisions[key]) {
        return this.read(key);
      }
      this.publish(key, value);
      return value;
    })();
    let timer: NodeJS.Timeout;
    let cancel: () => void;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error('Soundbar state read timed out'));
      }, this.options.requestTimeout * 2);
      cancel = () => reject(new Error('Soundbar controller is closed'));
      this.cancelReads.add(cancel);
    });
    const promise = Promise.race([work, timeout]).catch(error => {
      if (revision === this.revisions[key]) {
        this.publish(key, asError(error));
      }
      throw error;
    }).finally(() => {
      clearTimeout(timer);
      this.cancelReads.delete(cancel);
      if (this.reads.get(key)?.promise === promise) {
        this.reads.delete(key);
      }
    });
    this.reads.set(key, { revision, promise });
    return promise;
  }

  getPower(): Promise<number> { return this.read('power'); }
  getVolume(): Promise<number> { return this.read('volume'); }
  getMute(): Promise<boolean> { return this.read('mute'); }
  getInput(): Promise<string> { return this.read('input'); }

  private write<K extends Property>(key: K, operation: () => Promise<void>, value?: SoundbarState[K]): Promise<void> {
    this.ensureOpen();
    const revision = ++this.revisions[key];
    const result = (async () => {
      try {
        await operation();
        this.ensureOpen();
        if (revision === this.revisions[key] && value !== undefined) {
          this.publish(key, value);
        }
      } catch (error) {
        if (revision === this.revisions[key]) {
          this.publish(key, asError(error));
        }
        throw error;
      }
    })();
    this.writes.set(key, result);
    return result;
  }

  setPower(active: boolean): Promise<void> { return this.write('power', () => this.device.setPower(active), active ? 1 : 0); }
  setVolume(volume: number): Promise<void> { return this.write('volume', () => this.device.setVolume(volume), Math.round(volume)); }
  setMute(muted: boolean): Promise<void> { return this.write('mute', () => this.device.setMute(muted), muted); }
  setInput(name: string): Promise<void> {
    const canonical = this.resolveInput(name);
    return this.write('input', () => this.device.setInput(canonical), canonical);
  }

  async changeVolume(up: boolean): Promise<void> {
    await this.write('volume', () => this.device.changeVolume(up));
    // Relative commands do not return the resulting volume. Refresh only that property,
    // even if an older full refresh is still pending; failures remain visible in state.
    void this.getVolume().catch(() => undefined);
  }

  async seek(forward: boolean): Promise<void> {
    this.ensureOpen();
    await this.device.key(2, forward ? 0 : 1);
    this.ensureOpen();
  }

  async refresh(): Promise<void> {
    if (!this.stopped) {
      await Promise.allSettled(properties.map(key => this.read(key)));
    }
  }

  private async poll(): Promise<void> {
    await this.refresh();
    // Schedule from completion so slow devices cannot build up overlapping polls.
    if (!this.stopped && this.options.pollInterval !== 0) {
      this.pollTimer = setTimeout(() => { void this.poll(); }, this.options.pollInterval * 1000);
      this.pollTimer.unref();
    }
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.pollTimer);
    this.listeners.clear();
    for (const cancel of this.cancelReads) {
      cancel();
    }
    this.cancelReads.clear();
    this.reads.clear();
    this.writes.clear();
    this.device.close();
  }
}
