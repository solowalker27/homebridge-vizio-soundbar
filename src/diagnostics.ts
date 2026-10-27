import { AsyncLocalStorage } from 'node:async_hooks';

export interface DiagnosticContext {
  source: string;
  operationId?: string;
  characteristic?: string;
  client?: string;
}
interface Log { info(message: string): void }
export interface Diagnostics {
  nextId(): string;
  context(): DiagnosticContext;
  run<T>(context: DiagnosticContext, operation: () => T): T;
  audit(event: string, details?: unknown): void;
  state(event: string, details?: unknown): void;
  debug(event: string, details?: unknown): void;
}

export const silentDiagnostics: Diagnostics = {
  nextId: () => '', context: () => ({ source: 'internal' }),
  run: (_context, operation) => operation(), audit: () => undefined, state: () => undefined, debug: () => undefined,
};

const SECRET_KEY = /auth|token|password|secret|cookie|credential|private.?key|api.?key|passcode|(^|_)pin($|_)/i;
const MAX_LOG_LENGTH = 16_384;

/** Logs commands at normal level and opt-in diagnostics without relying on Homebridge's global -D flag. */
export class SoundbarDiagnostics implements Diagnostics {
  private readonly storage = new AsyncLocalStorage<DiagnosticContext>();
  private sequence = 0;

  constructor(private readonly log: Log, private readonly enabled: boolean, private readonly authToken?: string) {}

  nextId(): string { return `${process.pid}-${++this.sequence}`; }
  context(): DiagnosticContext { return { ...(this.storage.getStore() ?? { source: 'internal' }) }; }
  run<T>(context: DiagnosticContext, operation: () => T): T {
    return this.storage.run({ ...this.context(), ...context }, operation);
  }

  private redact(value: unknown, depth = 0): unknown {
    if (depth > 8) {
      return '[depth limit]';
    }
    if (typeof value === 'string') {
      // Also remove the configured secret if it appears inside an error or another string field.
      return this.authToken ? value.split(this.authToken).join('[REDACTED]') : value;
    }
    if (value instanceof Error) {
      const error = value as NodeJS.ErrnoException;
      return this.redact({ name: error.name, message: error.message, code: error.code }, depth + 1);
    }
    if (Array.isArray(value)) {
      return value.map(item => this.redact(item, depth + 1));
    }
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) =>
        [key, SECRET_KEY.test(key) && typeof item !== 'boolean' ? '[REDACTED]' : this.redact(item, depth + 1)]));
    }
    return value;
  }

  private emit(prefix: string, event: string, details?: unknown): void {
    try {
      const rendered = `${prefix} ${this.redact(event)} ${JSON.stringify(this.redact({ ...this.context(), details }))}`;
      this.log.info(rendered.length > MAX_LOG_LENGTH ? `${rendered.slice(0, MAX_LOG_LENGTH)} [truncated]` : rendered);
    } catch {
      // Diagnostic failures must never prevent or retry device commands.
    }
  }

  audit(event: string, details?: unknown): void { this.emit('[Command]', event, details); }
  state(event: string, details?: unknown): void { this.emit('[State]', event, details); }
  debug(event: string, details?: unknown): void {
    if (this.enabled) {
      this.emit('[Debug]', event, details);
    }
  }
}
