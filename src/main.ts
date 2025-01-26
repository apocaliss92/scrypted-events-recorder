import sdk, { MixinDeviceBase, MixinProvider, ObjectDetection, ObjectDetectionModel, ScryptedDevice, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, Setting, SettingValue, Settings, VideoCamera, WritableDeviceState } from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { EventsRecorderMixin } from './eventsRecorderMixin';
import fs from 'fs';
import { BasePlugin, getBaseSettings } from '../../scrypted-apocaliss-base/src/basePlugin';

export class EventsRecorderPlugin extends BasePlugin implements Settings {
  currentMixins = new Set<EventsRecorderMixin>();

  storageSettings = new StorageSettings(this, {
    ...getBaseSettings({
      onPluginSwitch: (_, enabled) => this.startStop(enabled),
      hideHa: true,
    }),
    storagePath: {
      title: 'Storage path',
      description: 'Disk path where to save the clips',
      type: 'string',
      onPut: async () => await this.start()
    },
  });

  constructor(nativeId?: ScryptedNativeId) {
    super(nativeId, {
      pluginFriendlyName: 'Events recorder'
    });

    this.start().then().catch(this.getLogger().log);
  }

  async startStop(enabled: boolean) {
    if (enabled) {
      await this.start();
    } else {
      await this.stop();
    }
  }

  async stop() {
    await this.mqttClient?.disconnect();
  }

  async start() {
    const { storagePath } = this.storageSettings.values;

    if (storagePath) {
      if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
      }
    } else {
      this.getLogger().error('Storage path not defined');
    }
  }

  async getSettings(): Promise<Setting[]> {
    const settings: Setting[] = await super.getSettings();

    return settings;
  }

  putSetting(key: string, value: SettingValue): Promise<void> {
    return this.storageSettings.putSetting(key, value);
  }

  async canMixin(type: ScryptedDeviceType, interfaces: string[]): Promise<string[]> {
    if (
      (
        type === ScryptedDeviceType.Camera ||
        type === ScryptedDeviceType.Doorbell
      ) &&
      (
        interfaces.includes(ScryptedInterface.ObjectDetector)
      )
    ) {
      const ret: string[] = [
        ScryptedInterface.VideoClips,
        ScryptedInterface.Settings,
      ];

      return ret;
    }
  }

  async getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: WritableDeviceState) {
    try {
      const ret = new EventsRecorderMixin(
        this,
        mixinDevice,
        mixinDeviceInterfaces,
        mixinDeviceState,
        this.nativeId,
        'Events recorder',
        'eventsRecorder'
      );

      this.currentMixins.add(ret);
      return ret;
    } catch (e) {
      this.getLogger().log('Error on getMixin', e);
    }
  }

  async releaseMixin(id: string, mixinDevice: EventsRecorderMixin) {
    this.currentMixins.delete(mixinDevice);
    return mixinDevice?.release();
  }
}

export default EventsRecorderPlugin;
