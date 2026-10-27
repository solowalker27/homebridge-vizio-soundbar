import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface InputPreference { name?: string; hidden?: boolean }
interface Preferences { name?: string; inputs: Record<string, InputPreference> }

/** External accessories aren't restored through configureAccessory, so persist Home app settings explicitly. */
export class PreferenceStore {
  private state: Preferences = { inputs: Object.create(null) as Record<string, InputPreference> };
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (typeof value !== 'object' || value === null) {
        throw new Error('Invalid soundbar preferences');
      }
      const data = value as Record<string, unknown>;
      if (typeof data.name === 'string' && data.name.trim()) {
        this.state.name = data.name;
      }
      if (typeof data.inputs === 'object' && data.inputs !== null) {
        for (const [key, input] of Object.entries(data.inputs)) {
          if (typeof input === 'object' && input !== null) {
            const pref = input as Record<string, unknown>;
            this.state.inputs[key] = {
              name: typeof pref.name === 'string' && pref.name.trim() ? pref.name : undefined,
              hidden: typeof pref.hidden === 'boolean' ? pref.hidden : undefined,
            };
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  get name(): string | undefined { return this.state.name; }
  input(name: string): InputPreference {
    return Object.hasOwn(this.state.inputs, name) ? { ...this.state.inputs[name] } : {};
  }

  update(name: string | undefined, input?: { key: string; preference: InputPreference }): Promise<void> {
    const result = this.writes.then(async () => {
      const next: Preferences = { ...this.state, inputs: { ...this.state.inputs } };
      if (name !== undefined) {
        next.name = name;
      }
      if (input) {
        next.inputs = { ...next.inputs, [input.key]: { ...this.input(input.key), ...input.preference } };
      }
      const serialized = JSON.stringify(next);
      if (serialized === JSON.stringify(this.state)) {
        return;
      }
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, this.path);
      this.state = next;
    });
    this.writes = result.catch(() => undefined);
    return result;
  }
}
