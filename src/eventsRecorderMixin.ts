import sdk, { Camera, EventListenerRegister, MediaObject, MediaStreamDestination, MotionSensor, ObjectDetection, ObjectDetectionModel, ObjectDetectionResult, ObjectDetectionTypes, ObjectDetectionZone, ObjectDetector, ObjectsDetected, ScryptedDevice, ScryptedDeviceBase, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, VideoCamera, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions, VideoFrame, VideoFrameGenerator, WritableDeviceState } from '@scrypted/sdk';
import { SettingsMixinDeviceBase } from "@scrypted/common/src/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import ObjectDetectionPlugin from './main';
import path from 'path';
import fs from 'fs';

const { systemManager } = sdk;

type DeviceType = VideoCamera & Camera & Settings & ScryptedDeviceBase & ScryptedDevice;

export class EventsRecorderMixin extends SettingsMixinDeviceBase<DeviceType> implements Settings, VideoClips {
    cameraDevice: DeviceType;
    killed: boolean;
    rtspUrl: string;
    mainLoopListener: NodeJS.Timeout;
    detectionListener: EventListenerRegister;
    logger: Console;

    storageSettings = new StorageSettings(this, {
        highQualityVideoclips: {
            title: 'High quality clips',
            description: 'Will use the local remote stream.',
            type: 'boolean',
            defaultValue: true,
            onPut: async () => await this.init()
        },
        preEventSeconds: {
            title: 'Pre event seconds',
            description: 'Seconds to keep before an event occurs.',
            type: 'number',
            defaultValue: 15,
        },
        postEventSeconds: {
            title: 'Post event seconds',
            description: 'Seconds to keep after an event occurs.',
            type: 'number',
            defaultValue: 15,
        },
        extensionThreshold: {
            title: 'Extension threshold',
            type: 'number',
            defaultValue: 2,
            hide: true
        },
        debug: {
            title: 'Log debug messages',
            type: 'boolean',
            defaultValue: false,
            immediate: true,
        },
    });

    constructor(
        public plugin: ObjectDetectionPlugin,
        mixinDevice: DeviceType,
        mixinDeviceInterfaces: ScryptedInterface[],
        mixinDeviceState: WritableDeviceState,
        providerNativeId: string,
        group: string,
        groupKey: string,
    ) {
        super({
            mixinDevice, mixinDeviceState,
            mixinProviderNativeId: providerNativeId,
            mixinDeviceInterfaces,
            group,
            groupKey,
        });

        const logger = this.getLogger();
        this.cameraDevice = systemManager.getDeviceById<DeviceType>(this.id);
        setTimeout(async () => {
            !this.killed && this.init().then().catch(logger.log);
        }, 2000);
        this.startCheckInterval().then().catch(logger.log);
    }

    private getLogger() {
        const deviceConsole = this.console;

        if (!this.logger) {
            const log = (debug: boolean, message?: any, ...optionalParams: any[]) => {
                const now = new Date().toLocaleString();
                if (!debug || this.storageSettings.getItem('debug')) {
                    deviceConsole.log(` ${now} - `, message, ...optionalParams);
                }
            };
            this.logger = {
                log: (message?: any, ...optionalParams: any[]) => log(false, message, ...optionalParams),
                debug: (message?: any, ...optionalParams: any[]) => log(true, message, ...optionalParams),
            } as Console
        }

        return this.logger;
    }

    resetListeners() {
        if (this.detectionListener) {
            this.getLogger().log('Resetting listeners.');
        }

        // this.resetTimeouts();
        this.detectionListener?.removeListener && this.detectionListener.removeListener();
        this.detectionListener = undefined;
    }

    async init() {
        const logger = this.getLogger();
        const { highQualityVideoclips } = this.storageSettings.values;
        const destination = highQualityVideoclips ? 'local-recorder' : 'remote-recorder';

        const streamConfigs = await this.cameraDevice.getVideoStreamOptions();
        const streamName = streamConfigs.find(config => config.destinations.includes(destination))?.name;
        const deviceSettings = await this.cameraDevice.getSettings();
        const rebroadcastConfig = deviceSettings.find(setting => setting.subgroup === `Stream: ${streamName}` && setting.title === 'RTSP Rebroadcast Url');
        this.rtspUrl = rebroadcastConfig?.value as string;

        logger.log(`Rebroadcast URL found: ${JSON.stringify({
            url: this.rtspUrl,
            streamName,
        })}`);

        try {
            const { thumbnailsFolder, videoClipsFolder, tmpFolder } = this.getStorageDirs();

            if (!fs.existsSync(thumbnailsFolder)) {
                fs.mkdirSync(thumbnailsFolder, { recursive: true });
            }
            if (!fs.existsSync(videoClipsFolder)) {
                fs.mkdirSync(videoClipsFolder, { recursive: true });
            }
            if (!fs.existsSync(tmpFolder)) {
                fs.mkdirSync(tmpFolder, { recursive: true });
            }
        } catch (e) {
            this.console.error('Error in init', e);
        }
    }

    async startCheckInterval() {
        const logger = this.getLogger();

        const funct = async () => {
            try {
            } catch (e) {
                logger.error('Error in startCheckInterval funct', e);
            }
        };

        this.mainLoopListener = setInterval(async () => {
            try {
                if (this.killed) {
                    await this.release();
                } else {
                    await funct();
                }
            } catch (e) {
                logger.error('Error in startCheckInterval', e);
            }
        }, 10000);
    }

    getVideoClips(options?: VideoClipOptions): Promise<VideoClip[]> {
        throw new Error('Method not implemented.');
    }
    getVideoClip(videoId: string): Promise<MediaObject> {
        throw new Error('Method not implemented.');
    }
    getVideoClipThumbnail(thumbnailId: string, options?: VideoClipThumbnailOptions): Promise<MediaObject> {
        throw new Error('Method not implemented.');
    }
    removeVideoClips(...videoClipIds: string[]): Promise<void> {
        throw new Error('Method not implemented.');
    }

    async getMixinSettings(): Promise<Setting[]> {
        const settings = await this.storageSettings.getSettings();


        return settings;
    }

    async putMixinSetting(key: string, value: string | number | boolean | string[] | number[]): Promise<void> {
        this.storage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    }

    async release() {
        this.killed = true;
        this.resetListeners();
        this.mainLoopListener && clearInterval(this.mainLoopListener);
        this.mainLoopListener = undefined;
    }

    async startListeners() {
        try {
            this.detectionListener = systemManager.listenDevice(this.id, ScryptedInterface.ObjectDetector, async (_, __, data) => {
                const detection: ObjectsDetected = data;

                const { timestamp } = detection;

                // this.processDetections({ detections: detection.detections, triggerTime: timestamp, isFromNvr: false })
            });
        } catch (e) {
            this.console.error('Error in startListeners', e);
        }
    }

    getStorageDirs(videoClipName?: string) {
        const { storagePath } = this.plugin.storageSettings.values;
        if (!storagePath) {
            throw new Error('Storage path not defined on the plugin');
        }

        const deviceFolder = path.join(storagePath, this.cameraDevice.id);
        const tmpFolder = path.join(deviceFolder, 'tmp');
        const videoClipsFolder = path.join(deviceFolder, 'videoclips');
        const thumbnailsFolder = path.join(deviceFolder, 'thumbnails');

        const videoClipPath = videoClipName ? path.join(videoClipsFolder, `${videoClipName}.mp4`) : undefined;
        const thumbnailPath = videoClipName ? path.join(thumbnailsFolder, `${videoClipName}.jpg`) : undefined;

        return {
            deviceFolder,
            tmpFolder,
            videoClipsFolder,
            thumbnailsFolder,
            videoClipPath,
            thumbnailPath,
        }
    }
}