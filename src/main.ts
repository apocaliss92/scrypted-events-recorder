import sdk, { HttpRequest, HttpRequestHandler, HttpResponse, ScryptedDeviceType, ScryptedInterface, ScryptedNativeId, Setting, SettingValue, Settings, WritableDeviceState } from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { EventsRecorderMixin } from './eventsRecorderMixin';
import fs from 'fs';
import { BasePlugin, getBaseSettings } from '../../scrypted-apocaliss-base/src/basePlugin';

export class EventsRecorderPlugin extends BasePlugin implements Settings, HttpRequestHandler {
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


  async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
    const url = new URL(`http://localhost${request.url}`);
    const params = url.searchParams.get('params') ?? '{}';

    try {
      const [_, __, ___, ____, _____, webhook] = url.pathname.split('/');
      // const [_, __, ___, ____, webhook] = url.pathname.split('/');
      const { deviceId, filename, parameters } = JSON.parse(params);
      const dev: EventsRecorderMixin = this.currentMixins[deviceId];
      const devConsole = dev.console;
      devConsole.log(`Request with parameters: ${JSON.stringify({
        webhook,
        deviceId,
        filename,
        parameters
      })}`);

      try {
        if (webhook === 'videoclip') {

          const { videoClipPath } = dev.getStorageDirs(filename);
          const stat = fs.statSync(videoClipPath);
          const fileSize = stat.size;
          const range = request.headers.range;

          devConsole.log(`Videoclip requested: ${JSON.stringify({
            videoClipPath,
            filename,
            deviceId,
          })}`);

          if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(videoClipPath, { start, end });


            const sendVideo = async () => {
              return new Promise<void>((resolve, reject) => {
                try {
                  response.sendStream((async function* () {
                    for await (const chunk of file) {
                      yield chunk;
                    }
                  })(), {
                    code: 206,
                    headers: {
                      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                      'Accept-Ranges': 'bytes',
                      'Content-Length': chunksize,
                      'Content-Type': 'video/mp4',
                    }
                  });

                  resolve();
                } catch (err) {
                  reject(err);
                }
              });
            };

            try {
              await sendVideo();
              return;
            } catch (e) {
              devConsole.log('Error fetching videoclip', e);
            }
          } else {
            response.sendFile(videoClipPath, {
              code: 200,
              headers: {
                'Content-Length': fileSize,
                'Content-Type': 'video/mp4',
              }
            });
          }

          return;
        } else
          if (webhook === 'thumbnail') {
            devConsole.log(`Thumbnail requested: ${JSON.stringify({
              filename,
              deviceId,
            })}`);
            const thumbnailMo = await dev.getVideoClipThumbnail(filename);
            const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(thumbnailMo, 'image/jpeg');
            response.send(jpeg, {
              headers: {
                'Content-Type': 'image/jpeg',
              }
            });
            return;
          }
      } catch (e) {
        devConsole.log(`Error in webhook`, e);
        response.send(`${JSON.stringify(e)}, ${e.message}`, {
          code: 400,
        });

        return;
      }

      response.send(`Webhook not found: ${url.pathname}`, {
        code: 404,
      });

      return;
    } catch (e) {
      this.console.log('Error in data parsing for webhook', e);
      response.send(`Error in data parsing for webhook: ${JSON.stringify({
        params,
        url: request.url
      })}`, {
        code: 500,
      });
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
