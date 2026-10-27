import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
  API, CharacteristicValue, HAP, IndependentPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service,
} from 'homebridge';
import { SmartCastClient } from './client.js';
import type { SoundbarInput } from './client.js';
import { parseConfig } from './config.js';
import type { SoundbarConfig } from './config.js';
import { PreferenceStore } from './preferences.js';
import { PLUGIN_NAME, PLUGIN_VERSION } from './settings.js';

export function inputIdentifier(name: string): number {
  // HomeKit reserves zero for "no input". Device enumeration order can change across boots.
  return createHash('sha256').update(name).digest().readUInt32BE(0) || 1;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HomebridgeVizioSoundbar implements IndependentPlatformPlugin {
  private readonly hap: HAP;
  private readonly options: SoundbarConfig;
  private readonly client: SmartCastClient;
  private readonly preferences: PreferenceStore;
  public readonly accessory: PlatformAccessory;
  private readonly television: Service;
  private readonly speaker: Service;
  private readonly inputs = new Map<number, SoundbarInput>();
  private retryTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;
  private stopped = false;
  private published = false;
  private refreshing = false;
  private revision = 0;

  constructor(private readonly log: Logger, config: PlatformConfig, private readonly api: API) {
    this.options = parseConfig(config);
    this.hap = api.hap;
    this.client = new SmartCastClient(this.options);
    // Preserve the original UUID seed for existing installations with an explicit name.
    const uuid = this.hap.uuid.generate('homebridge:vizio-soundbar:accessory:' + (config.name ?? 'undefined'));
    this.preferences = new PreferenceStore(join(api.user.storagePath(), 'vizio-soundbar', `${uuid}.json`));
    this.accessory = new api.platformAccessory(this.options.name, uuid, api.hap.Categories.AUDIO_RECEIVER);
    const { Characteristic: C, Service: S } = this.hap;
    this.accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Vizio')
      .setCharacteristic(C.Model, 'SmartCast Soundbar')
      .setCharacteristic(C.SerialNumber, uuid)
      .setCharacteristic(C.FirmwareRevision, PLUGIN_VERSION);
    this.television = this.accessory.addService(new S.Television(this.options.name, 'televisionService'));
    this.television.setPrimaryService();
    this.speaker = this.accessory.addService(new S.TelevisionSpeaker(`${this.options.name} Speaker`, 'speakerService'));
    this.television.addLinkedService(this.speaker);
    this.prepareControls();
    api.on('didFinishLaunching', () => { void this.launch(); });
    api.on('shutdown', () => this.shutdown());
  }

  private async launch(): Promise<void> {
    try {
      await this.preferences.load();
    } catch (error) {
      this.log.warn('Could not load Home app preferences: %s', message(error));
    }
    if (this.stopped) {
      return;
    }
    this.television.updateCharacteristic(this.hap.Characteristic.ConfiguredName, this.preferences.name ?? this.options.name);
    await this.discover();
  }

  private async discover(): Promise<void> {
    try {
      const inputs = await this.client.listInputs();
      if (this.stopped) {
        return;
      }
      // Validate all identifiers before adding services so a retry cannot leave partial input services.
      const identifiers = new Set<number>();
      if (inputs.length > 90) {
        throw new Error('Soundbar returned too many inputs for a HomeKit accessory');
      }
      for (const input of inputs) {
        const id = inputIdentifier(input.name);
        if (identifiers.has(id)) {
          throw new Error('Soundbar input identifiers collide');
        }
        identifiers.add(id);
      }
      for (const input of inputs) {
        this.prepareInput(input);
      }
      this.api.publishExternalAccessories(PLUGIN_NAME, [this.accessory]);
      this.published = true;
      this.log.info('Published %s with %s inputs. Pair it separately using Add Accessory in Apple Home.',
        this.options.name, inputs.length);
      void this.refresh();
      if (this.options.pollInterval !== 0) {
        this.pollTimer = setInterval(() => { void this.refresh(); }, this.options.pollInterval * 1000);
        this.pollTimer.unref();
      }
    } catch (error) {
      if (!this.stopped) {
        this.log.warn('Soundbar discovery failed; retrying in 30 seconds: %s', message(error));
        this.retryTimer = setTimeout(() => { void this.discover(); }, 30_000);
        this.retryTimer.unref();
      }
    }
  }

  private invalid(): Error {
    const hap = this.hap;
    return new hap.HapStatusError(hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
  }

  private async communicate<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.log.debug('Soundbar communication failed: %s', message(error));
      const hap = this.hap;
      throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private async write(operation: () => Promise<void>, update?: () => void): Promise<void> {
    this.revision++;
    try {
      await this.communicate(operation);
      update?.();
    } finally {
      this.revision++;
    }
  }

  private prepareControls(): void {
    const C = this.hap.Characteristic;
    this.television
      .setCharacteristic(C.ConfiguredName, this.options.name)
      .setCharacteristic(C.SleepDiscoveryMode, C.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
    this.television.getCharacteristic(C.ConfiguredName).onSet(async value => {
      const name = this.validName(value);
      await this.communicate(() => this.preferences.update(name));
    });
    this.television.getCharacteristic(C.Active)
      .onGet(() => this.communicate(async () => {
        const power = await this.client.getPower();
        this.speaker.updateCharacteristic(C.Active, power);
        return power;
      }))
      .onSet(async value => {
        if (value !== C.Active.ACTIVE && value !== C.Active.INACTIVE) {
          throw this.invalid();
        }
        await this.write(() => this.client.setPower(value === C.Active.ACTIVE), () => {
          this.speaker.updateCharacteristic(C.Active, value);
        });
      });
    this.television.getCharacteristic(C.ActiveIdentifier)
      .onGet(() => this.communicate(async () => this.resolveInput(await this.client.getInput())))
      .onSet(async value => {
        const input = typeof value === 'number' ? this.inputs.get(value) : undefined;
        if (!input) {
          throw this.invalid();
        }
        await this.write(() => this.client.setInput(input.name));
      });
    // Only advertise remote commands defined by the existing soundbar protocol.
    this.television.getCharacteristic(C.RemoteKey)
      .setProps({ validValues: [C.RemoteKey.REWIND, C.RemoteKey.FAST_FORWARD] })
      .onSet(async value => {
        if (value !== C.RemoteKey.REWIND && value !== C.RemoteKey.FAST_FORWARD) {
          throw this.invalid();
        }
        await this.write(() => this.client.key(2, value === C.RemoteKey.REWIND ? 1 : 0));
      });
    this.speaker.setCharacteristic(C.VolumeControlType, C.VolumeControlType.ABSOLUTE);
    this.speaker.getCharacteristic(C.Active).onGet(() => this.communicate(() => this.client.getPower()));
    this.speaker.getCharacteristic(C.Volume)
      .onGet(() => this.communicate(() => this.client.getVolume()))
      .onSet(async value => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
          throw this.invalid();
        }
        await this.write(() => this.client.setVolume(value));
      });
    this.speaker.getCharacteristic(C.Mute)
      .onGet(() => this.communicate(() => this.client.getMute()))
      .onSet(async value => {
        if (typeof value !== 'boolean') {
          throw this.invalid();
        }
        await this.write(() => this.client.setMute(value));
      });
    this.speaker.getCharacteristic(C.VolumeSelector).onSet(async value => {
      if (value !== C.VolumeSelector.INCREMENT && value !== C.VolumeSelector.DECREMENT) {
        throw this.invalid();
      }
      await this.write(() => this.client.changeVolume(value === C.VolumeSelector.INCREMENT));
      void this.refresh();
    });
  }

  private validName(value: CharacteristicValue): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 64) {
      throw this.invalid();
    }
    return value.trim();
  }

  private prepareInput(input: SoundbarInput): void {
    const C = this.hap.Characteristic;
    const id = inputIdentifier(input.name);
    this.inputs.set(id, input);
    const preference = this.preferences.input(input.name);
    const name = (preference.name ?? input.displayName).slice(0, 64);
    const hidden = preference.hidden ? C.CurrentVisibilityState.HIDDEN : C.CurrentVisibilityState.SHOWN;
    const service = this.accessory.getServiceById(this.hap.Service.InputSource, `input:${input.name}`)
      ?? this.accessory.addService(new this.hap.Service.InputSource(name, `input:${input.name}`));
    service
      .setCharacteristic(C.Identifier, id)
      .setCharacteristic(C.ConfiguredName, name)
      .setCharacteristic(C.IsConfigured, C.IsConfigured.CONFIGURED)
      .setCharacteristic(C.InputSourceType, /hdmi|arc/i.test(input.name) ? C.InputSourceType.HDMI
        : /usb/i.test(input.name) ? C.InputSourceType.USB : C.InputSourceType.OTHER)
      .setCharacteristic(C.CurrentVisibilityState, hidden)
      .setCharacteristic(C.TargetVisibilityState, hidden);
    service.getCharacteristic(C.ConfiguredName).onSet(async value => {
      await this.communicate(() => this.preferences.update(undefined, {
        key: input.name, preference: { name: this.validName(value) },
      }));
    });
    service.getCharacteristic(C.TargetVisibilityState).onSet(async value => {
      if (value !== C.TargetVisibilityState.SHOWN && value !== C.TargetVisibilityState.HIDDEN) {
        throw this.invalid();
      }
      await this.communicate(() => this.preferences.update(undefined, {
        key: input.name, preference: { hidden: value === C.TargetVisibilityState.HIDDEN },
      }));
      service.updateCharacteristic(C.CurrentVisibilityState, value);
    });
    this.television.addLinkedService(service);
  }

  private resolveInput(name: string): number {
    for (const [id, input] of this.inputs) {
      if (input.name.toLowerCase() === name.toLowerCase()) {
        return id;
      }
    }
    for (const [id, input] of this.inputs) {
      if (input.displayName.toLowerCase() === name.toLowerCase()) {
        return id;
      }
    }
    throw new Error('Soundbar selected an input that was not discovered');
  }

  private async refresh(): Promise<void> {
    if (this.refreshing || this.stopped || !this.published) {
      return;
    }
    this.refreshing = true;
    const revision = this.revision;
    const C = this.hap.Characteristic;
    try {
      const results = await Promise.allSettled([
        this.client.getPower(), this.client.getVolume(), this.client.getMute(), this.client.getInput(),
      ] as const);
      // A snapshot started before a HomeKit write must not overwrite its newer state.
      if (this.stopped || revision !== this.revision) {
        return;
      }
      const [power, volume, mute, input] = results;
      const hap = this.hap;
      const failed = () => new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      this.television.getCharacteristic(C.Active).updateValue(power.status === 'fulfilled' ? power.value : failed());
      this.speaker.getCharacteristic(C.Active).updateValue(power.status === 'fulfilled' ? power.value : failed());
      this.speaker.getCharacteristic(C.Volume).updateValue(volume.status === 'fulfilled' ? volume.value : failed());
      this.speaker.getCharacteristic(C.Mute).updateValue(mute.status === 'fulfilled' ? mute.value : failed());
      let identifier: number | Error = failed();
      if (input.status === 'fulfilled') {
        try {
          identifier = this.resolveInput(input.value);
        } catch (error) {
          this.log.debug('%s', message(error));
        }
      }
      this.television.getCharacteristic(C.ActiveIdentifier).updateValue(identifier);
      for (const result of results) {
        if (result.status === 'rejected') {
          this.log.debug('Soundbar refresh failed: %s', message(result.reason));
        }
      }
    } catch (error) {
      this.log.debug('Could not update soundbar state: %s', message(error));
    } finally {
      this.refreshing = false;
    }
  }

  private shutdown(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pollTimer);
    this.client.close();
  }
}
