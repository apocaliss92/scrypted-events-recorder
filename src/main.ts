import sdk, { HttpRequest, HttpRequestHandler, HttpResponse, Image, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, ScryptedNativeId, Setting, SettingValue, Settings, WritableDeviceState } from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { EventsRecorderMixin } from './eventsRecorderMixin';
import fs from 'fs';
import { BasePlugin, getBaseSettings } from '../../scrypted-apocaliss-base/src/basePlugin';
import moment from 'moment';

interface MixinStorage {
  total: number;
  occupied: number;
  free: number;
}

export class EventsRecorderPlugin extends BasePlugin implements Settings, HttpRequestHandler {
  currentMixins = new Set<EventsRecorderMixin>();
  mixinStorage: Record<string, MixinStorage> = {};

  storageSettings = new StorageSettings(this, {
    ...getBaseSettings({
      onPluginSwitch: (_, enabled) => this.startStop(enabled),
      hideHa: true,
      hideMqtt: true,
    }),
    storagePath: {
      title: 'Storage path',
      description: 'Disk path where to save the clips',
      type: 'string',
      onPut: async () => await this.start()
    },
    occupiedSpaceInGb: {
      title: 'Memory allocated',
      type: 'number',
      range: [0, 250],
      readonly: true,
      placeholder: 'GB'
    },
  });

  constructor(nativeId?: ScryptedNativeId) {
    super(nativeId, {
      pluginFriendlyName: 'Events recorder'
    });

    this.start().then().catch(this.getLogger().log);
  }

  getLogger() {
    return super.getLoggerInternal({});
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
      try {
        await fs.promises.access(storagePath);
      } catch {
        await fs.promises.mkdir(storagePath, { recursive: true });
      }
    } else {
      this.getLogger().error('Storage path not defined');
    }

    process.on('exit', this.cleanAllListeners);
    process.on('SIGINT', this.cleanAllListeners);
    process.on('SIGTERM', this.cleanAllListeners);
    process.on('uncaughtException', this.cleanAllListeners);
  }

  cleanAllListeners() {
    this.currentMixins.forEach(mixin => mixin.resetListeners());
  }

  setMixinOccupancy(deviceId: string, data: MixinStorage) {
    this.mixinStorage[deviceId] = data;
    const totalData: MixinStorage = {
      free: 0,
      occupied: 0,
      total: 0
    };

    Object.values(this.mixinStorage).forEach(data => {
      totalData.free += data.free;
      totalData.occupied += data.occupied;
      totalData.total += data.total;
    });

    this.putSetting('occupiedSpaceInGb', totalData.occupied.toFixed(2));
    this.storageSettings.settings.occupiedSpaceInGb.range = [0, Number(totalData.total.toFixed(2))];
  }


  async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
    const url = new URL(`http://localhost${request.url}`);
    const params = url.searchParams.get('params') ?? '{}';
    const logger = this.getLogger();

    try {
      const [_, __, ___, ____, privateWebhook, ...rest] = url.pathname.split('/');

      try {
        // Since no API is available, needs to mimic NVR
        if (privateWebhook === 'thumbnail') {
          const [deviceId, filename] = rest;
          const dev: EventsRecorderMixin = this.currentMixins[deviceId];
          const devConsole = dev.getLogger();
          const height = url.searchParams.get('height');
          devConsole.debug(`Thumbnail requested: ${JSON.stringify({
            filename,
            deviceId,
            height,
          })}`);
          const eventTimestamp = Number(filename.split('.')[0]);
          const { eventImagePath } = dev.getStorageDirs({ eventTimestamp });

          let jpeg = await fs.promises.readFile(eventImagePath);

          if (height) {
            const mo = await sdk.mediaManager.createMediaObject(jpeg, 'image/jpeg');
            const convertedImage = await sdk.mediaManager.convertMediaObject<Image>(mo, ScryptedMimeTypes.Image);
            const resizedImage = await convertedImage.toImage({
              resize: {
                height: Number(height),
              },
            });
            jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(resizedImage, 'image/jpeg');
          }

          response.send(jpeg, {
            headers: {
              'Content-Type': 'image/jpeg',
            }
          });
          return;
        } else {
          const [webhook] = rest;
          const { deviceId, filename, parameters } = JSON.parse(params);
          const dev: EventsRecorderMixin = this.currentMixins[deviceId];
          const devConsole = dev.getLogger();
          devConsole.debug(`Request with parameters: ${JSON.stringify({
            webhook,
            deviceId,
            filename,
            parameters
          })}`);

          if (webhook === 'videoclip') {
            const { videoClipPath } = dev.getStorageDirs({ videoClipNameSrc: filename });
            const stat = await fs.promises.stat(videoClipPath);
            const fileSize = stat.size;
            const range = request.headers.range;

            devConsole.debug(`Videoclip requested: ${JSON.stringify({
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
          } else if (webhook === 'videoclipThumbnail') {
            devConsole.debug(`Thumbnail requested: ${JSON.stringify({
              filename,
              deviceId,
            })}`);
            const mo = await dev.getVideoClipThumbnail(filename);
            const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');
            // const { thumbnailPath } = dev.getStorageDirs({ videoClipNameSrc: filename });

            // const jpeg = await fs.promises.readFile(thumbnailPath);

            response.send(jpeg, {
              headers: {
                'Content-Type': 'image/jpeg',
              }
            });
            return;
          }
        }
      } catch (e) {
        logger.log(`Error in webhook`, e);
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
        // ScryptedInterface.EventRecorder,
        // ScryptedInterface.VideoRecorder,
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
