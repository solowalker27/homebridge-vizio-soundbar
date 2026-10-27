import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
  API, CharacteristicValue, HAP, IndependentPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service,
} from 'homebridge';
import { SmartCastClient } from './client.js';
import type { SoundbarInput } from './client.js';
import { SoundbarController } from './controller.js';
import type { SoundbarUpdate } from './controller.js';
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
  private readonly controller: SoundbarController;
  private readonly preferences: PreferenceStore;
  public readonly accessory: PlatformAccessory;
  private readonly television: Service;
  private readonly speaker: Service;
  private readonly inputs = new Map<number, SoundbarInput>();
  private stopped = false;
  private published = false;

  constructor(private readonly log: Logger, config: PlatformConfig, private readonly api: API) {
    this.options = parseConfig(config);
    this.hap = api.hap;
    this.controller = new SoundbarController(new SmartCastClient(this.options), this.options, (error, operation) => {
      if (operation === 'discovery') {
        this.log.warn('Soundbar discovery failed; retrying in 30 seconds: %s', error.message);
      } else {
        this.log.debug('Soundbar %s failed: %s', operation, error.message);
      }
    });
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
    this.controller.subscribe(update => this.updateState(update));
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
    await this.controller.start(inputs => this.publish(inputs));
  }

  private publish(inputs: readonly SoundbarInput[]): void {
    if (this.stopped || this.published) {
      return;
    }
    // HomeKit limits and identifiers belong to this adapter, not the device controller.
    const identifiers = new Set(inputs.map(input => inputIdentifier(input.name)));
    if (inputs.length > 90 || identifiers.size !== inputs.length) {
      throw new Error('Soundbar inputs exceed HomeKit limits or their identifiers collide');
    }
    for (const input of inputs) {
      this.prepareInput(input);
    }
    this.api.publishExternalAccessories(PLUGIN_NAME, [this.accessory]);
    this.published = true;
    this.log.info('Published %s with %s inputs. Pair it separately using Add Accessory in Apple Home.',
      this.options.name, inputs.length);
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
      .onGet(() => this.communicate(() => this.controller.getPower()))
      .onSet(async value => {
        if (value !== C.Active.ACTIVE && value !== C.Active.INACTIVE) {
          throw this.invalid();
        }
        await this.communicate(() => this.controller.setPower(value === C.Active.ACTIVE));
      });
    this.television.getCharacteristic(C.ActiveIdentifier)
      .onGet(() => this.communicate(async () => this.resolveInput(await this.controller.getInput())))
      .onSet(async value => {
        const input = typeof value === 'number' ? this.inputs.get(value) : undefined;
        if (!input) {
          throw this.invalid();
        }
        await this.communicate(() => this.controller.setInput(input.name));
      });
    // Only advertise remote commands defined by the existing soundbar protocol.
    this.television.getCharacteristic(C.RemoteKey)
      .setProps({ validValues: [C.RemoteKey.REWIND, C.RemoteKey.FAST_FORWARD] })
      .onSet(async value => {
        if (value !== C.RemoteKey.REWIND && value !== C.RemoteKey.FAST_FORWARD) {
          throw this.invalid();
        }
        await this.communicate(() => this.controller.seek(value === C.RemoteKey.FAST_FORWARD));
      });
    this.speaker.setCharacteristic(C.VolumeControlType, C.VolumeControlType.ABSOLUTE);
    this.speaker.getCharacteristic(C.Active).onGet(() => this.communicate(() => this.controller.getPower()));
    this.speaker.getCharacteristic(C.Volume)
      .onGet(() => this.communicate(() => this.controller.getVolume()))
      .onSet(async value => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
          throw this.invalid();
        }
        await this.communicate(() => this.controller.setVolume(value));
      });
    this.speaker.getCharacteristic(C.Mute)
      .onGet(() => this.communicate(() => this.controller.getMute()))
      .onSet(async value => {
        if (typeof value !== 'boolean') {
          throw this.invalid();
        }
        await this.communicate(() => this.controller.setMute(value));
      });
    this.speaker.getCharacteristic(C.VolumeSelector).onSet(async value => {
      if (value !== C.VolumeSelector.INCREMENT && value !== C.VolumeSelector.DECREMENT) {
        throw this.invalid();
      }
      await this.communicate(() => this.controller.changeVolume(value === C.VolumeSelector.INCREMENT));
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
      const name = this.validName(value);
      await this.communicate(() => this.preferences.update(undefined, {
        key: input.name, preference: { name },
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
    const id = inputIdentifier(name);
    if (!this.inputs.has(id)) {
      throw new Error('Soundbar selected an input that was not discovered');
    }
    return id;
  }

  private updateState(update: Readonly<SoundbarUpdate>): void {
    const C = this.hap.Characteristic;
    const hap = this.hap;
    const value = (state: number | boolean | string | Error) => state instanceof Error
      ? new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE) : state;
    if (update.power !== undefined) {
      this.television.getCharacteristic(C.Active).updateValue(value(update.power));
      this.speaker.getCharacteristic(C.Active).updateValue(value(update.power));
    }
    if (update.volume !== undefined) {
      this.speaker.getCharacteristic(C.Volume).updateValue(value(update.volume));
    }
    if (update.mute !== undefined) {
      this.speaker.getCharacteristic(C.Mute).updateValue(value(update.mute));
    }
    if (update.input !== undefined) {
      this.television.getCharacteristic(C.ActiveIdentifier).updateValue(
        update.input instanceof Error ? value(update.input) : this.resolveInput(update.input),
      );
    }
  }

  private shutdown(): void {
    this.stopped = true;
    this.controller.stop();
  }
}
