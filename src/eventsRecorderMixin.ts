import { SettingsMixinDeviceBase } from "@scrypted/common/src/settings-mixin";
import { sleep } from '@scrypted/common/src/sleep';
import sdk, { EventListenerRegister, MediaObject, ObjectsDetected, RecordedEvent, ScryptedInterface, Setting, Settings, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions, WritableDeviceState } from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import fs from 'fs';
import { sortBy, uniq } from 'lodash';
import path from 'path';
import url from 'url';
import { classnamePrio, DetectionClass, detectionClassesDefaultMap } from '../../scrypted-advanced-notifier/src/detecionClasses';
import ObjectDetectionPlugin from './main';
import { attachProcessEvents, cleanupMemoryThresholderInGb, clipsToCleanup, defaultClasses, detectionClassIndex, detectionClassIndexReversed, DeviceType, getMainDetectionClass, getVideoClipName, VideoclipFileData, videoClipRegex } from './util';
import moment from "moment";

const { systemManager } = sdk;

export class EventsRecorderMixin extends SettingsMixinDeviceBase<DeviceType> implements Settings, VideoClips {
    cameraDevice: DeviceType;
    killed: boolean;
    rtspUrl: string;
    mainLoopListener: NodeJS.Timeout;
    detectionListener: EventListenerRegister;
    motionListener: EventListenerRegister;
    logger: Console;
    saveFfmpegProcess: ChildProcessWithoutNullStreams;
    running = false;
    lastExtendLogged: number;
    ffmpegPath: string;
    shouldIndexFs = false;
    lastIndexFs: number;
    prebuffer: number;
    clipDurationInMs: number;
    lastMotionTrigger: number;

    recording = false;
    lastClipRecordedTime: number;
    saveRecordingListener: NodeJS.Timeout;
    recordingTimeStart: number;
    classesDetected: string[] = [];

    scanData: VideoclipFileData[] = [];
    recordedEvents: RecordedEvent[] = [];
    scanFsListener: NodeJS.Timeout;

    processListenersSet = false;

    storageSettings = new StorageSettings(this, {
        highQualityVideoclips: {
            title: 'High quality clips',
            description: 'Will use the local record stream. If the camera has only one stream it will not have any effect',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
            onPut: async () => await this.init()
        },
        postEventSeconds: {
            title: 'Post event seconds',
            description: 'Seconds to keep after an event occurs.',
            type: 'number',
            defaultValue: 10,
        },
        maxLength: {
            title: 'Max length in seconds',
            type: 'number',
            defaultValue: 60,
        },
        minDelayBetweenClips: {
            title: 'Minimum delay between clips',
            description: 'Define how many seconds to wait, as minumum, between two clips',
            type: 'number',
            defaultValue: 10,
        },
        scoreThreshold: {
            title: 'Score threshold',
            type: 'number',
            defaultValue: 0.7,
        },
        detectionClasses: {
            title: 'Detection classes',
            type: 'string',
            multiple: true,
            choices: Object.keys(detectionClassIndex),
            defaultValue: defaultClasses,
        },
        maxSpaceInGb: {
            title: 'Dedicated memory in GB',
            type: 'number',
            defaultValue: 20,
        },
        occupiedSpaceInGb: {
            title: 'Memory occupancy in GB',
            type: 'number',
            range: [0, 20],
            readonly: true,
            placeholder: 'GB'
        },
        ignoreCameraDetections: {
            title: 'Ingnore camera detections',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        debug: {
            title: 'Log debug messages',
            type: 'boolean',
            defaultValue: false,
            immediate: true,
        },
        processPid: {
            type: 'string',
            hide: true,
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

        if (this.mixinDeviceInterfaces.includes(ScryptedInterface.Battery)) {
            this.storageSettings.settings.maxLength.defaultValue = 30;
            this.storageSettings.settings.postEventSeconds.defaultValue = 5;
        }

        this.plugin.currentMixins[this.id] = this;
        const logger = this.getLogger();
        this.cameraDevice = systemManager.getDeviceById<DeviceType>(this.id);
        setTimeout(async () => {
            try {
                if (!this.killed) {
                    if (!this.processListenersSet) {
                        process.on('exit', this.resetListeners);
                        process.on('SIGINT', this.resetListeners);
                        process.on('SIGTERM', this.resetListeners);
                        process.on('uncaughtException', this.resetListeners);

                        this.processListenersSet = true;
                    }

                    this.ffmpegPath = await sdk.mediaManager.getFFmpegPath();
                    const processPid = this.storageSettings.values.processPid;
                    try {
                        processPid && process.kill(processPid, 'SIGTERM');
                    } finally {
                        this.storageSettings.values.processPid = undefined;
                    }

                    await this.init();
                    this.startCheckInterval().catch(logger.log);
                }
            } catch (e) {
                logger.log(`Error on init flow`, e);
            }
        }, 2000);
    }

    // async getRecordedEvents(options: RecordedEventOptions): Promise<RecordedEvent[]> {
    //     return this.recordedEvents.filter(item =>
    //         item.details.eventTime > options.startTime &&
    //         item.details.eventTime < options.endTime
    //     ).slice(0, options.count);
    // }

    public getLogger() {
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
                error: (message?: any, ...optionalParams: any[]) => log(false, message, ...optionalParams),
                debug: (message?: any, ...optionalParams: any[]) => log(true, message, ...optionalParams),
            } as Console
        }

        return this.logger;
    }

    async resetListeners(props: {
        skipMainLoop?: boolean,
        skipDetectionListener?: boolean
        skipSkan?: boolean
    } = {}) {
        const { skipMainLoop, skipDetectionListener } = props;
        this.running = false;

        if (!skipMainLoop) {
            this.mainLoopListener && clearInterval(this.mainLoopListener);
            this.mainLoopListener = undefined;
            this.scanFsListener && clearInterval(this.scanFsListener);
            this.scanFsListener = undefined;
        }

        if (!skipDetectionListener) {
            this.detectionListener?.removeListener && this.detectionListener.removeListener();
            this.detectionListener = undefined;
            this.motionListener?.removeListener && this.motionListener.removeListener();
            this.motionListener = undefined;
        }

        this.saveRecordingListener && clearInterval(this.saveRecordingListener);
        this.saveRecordingListener = undefined;
    }

    async init() {
        const logger = this.getLogger();
        const { highQualityVideoclips, postEventSeconds } = this.storageSettings.values;
        const destination = highQualityVideoclips ? 'local-recorder' : 'remote-recorder';

        const streamConfigs = await this.cameraDevice.getVideoStreamOptions();
        let streamConfig = streamConfigs.find(config => config.destinations?.includes(destination));

        const streamName = streamConfig?.name;
        this.prebuffer = (streamConfig.prebuffer ?? 10000) / 2;
        this.clipDurationInMs = this.prebuffer + (postEventSeconds * 1000);
        const deviceSettings = await this.cameraDevice.getSettings();
        const rebroadcastConfig = deviceSettings.find(setting => setting.subgroup === `Stream: ${streamName}` && setting.title === 'RTSP Rebroadcast Url');
        this.rtspUrl = rebroadcastConfig?.value as string;

        logger.log(`Rebroadcast URL found: ${JSON.stringify({
            url: this.rtspUrl,
            streamName,
        })}`);

        try {
            const { thumbnailsFolder, videoClipsFolder } = this.getStorageDirs();

            try {
                await fs.promises.access(thumbnailsFolder);
            } catch (err) {
                await fs.promises.mkdir(thumbnailsFolder, { recursive: true });
            }

            try {
                await fs.promises.access(videoClipsFolder);
            } catch (err) {
                await fs.promises.mkdir(videoClipsFolder, { recursive: true });
            }
        } catch (e) {
            logger.log('Error in init', e);
        }
    }

    async startCheckInterval() {
        const logger = this.getLogger();

        const funct = async () => {
            try {
                await this.startListeners();
            } catch (e) {
                logger.log('Error in startCheckInterval funct', e);
            }
        };

        this.mainLoopListener = setInterval(async () => {
            try {
                const { pluginEnabled } = this.plugin.storageSettings.values;
                if (this.killed) {
                    await this.resetListeners({});
                } else if (!pluginEnabled) {
                    await this.resetListeners({ skipMainLoop: true });
                } else {
                    if (!this.running) {
                        await funct();
                    }

                    const now = Date.now();
                    if (this.shouldIndexFs || !this.lastIndexFs || (now - this.lastIndexFs) > (1000 * 60 * 5)) {
                        logger.debug(`Indexing FS: ${JSON.stringify({
                            shouldIndexFs: this.shouldIndexFs,
                            lastIndexFs: this.lastIndexFs,
                        })}`);

                        await this.indexFs();
                        this.lastIndexFs = now;

                        logger.debug(`${this.scanData.length} videoclips found`);
                    }
                }
            } catch (e) {
                logger.log('Error in startCheckInterval', e);
            }
        }, 10000);

        this.scanFsListener = setInterval(async () => await this.scanFs(), 1000 * 60 * 5);
        await this.scanFs();
    }

    async getVideoClips(options?: VideoClipOptions): Promise<VideoClip[]> {
        const getClips = async (startTimeInner: number, endTimeInner: number) => {
            const videoclips: VideoClip[] = [];

            for (const item of this.scanData) {
                const { detectionClasses, endTime, filename, startTime } = item;

                if (startTime >= startTimeInner && startTime <= endTimeInner) {
                    const durationInMs = endTime - startTime;
                    const event = getMainDetectionClass(detectionClasses);

                    const { thumbnailUrl, videoclipUrl } = await this.getVideoclipWebhookUrls(filename);
                    videoclips.push({
                        id: filename,
                        startTime,
                        duration: Math.round(durationInMs),
                        videoId: filename,
                        thumbnailId: filename,
                        detectionClasses,
                        event,
                        description: event,
                        resources: {
                            thumbnail: {
                                href: thumbnailUrl
                            },
                            video: {
                                href: videoclipUrl
                            }
                        }
                    });
                }
            }

            return videoclips;
        }

        let videoclips: VideoClip[] = [];
        let currentTry = 0;
        const maxTries = 1;

        while (!videoclips.length && currentTry < maxTries) {
            currentTry++
            const additionalDays = currentTry - 1;
            const startTry = moment(options.startTime).subtract(additionalDays, 'days');
            const endTry = moment(options.endTime).add(additionalDays, 'days');

            videoclips = await getClips(startTry.toDate().getTime(), endTry.toDate().getTime());
        }

        return videoclips;
    }

    async getVideoClip(videoId: string): Promise<MediaObject> {
        const logger = this.getLogger();
        const { videoClipPath } = this.getStorageDirs(videoId);
        logger.debug('Fetching videoId ', videoId, videoClipPath);
        const fileURLToPath = url.pathToFileURL(videoClipPath).toString();
        const videoclipMo = await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);

        return videoclipMo;
    }

    async getVideoClipThumbnail(thumbnailId: string, options?: VideoClipThumbnailOptions): Promise<MediaObject> {
        const logger = this.getLogger();
        const { thumbnailPath } = this.getStorageDirs(thumbnailId);
        logger.debug('Fetching thumbnailId ', thumbnailId, thumbnailPath);
        const fileURLToPath = url.pathToFileURL(thumbnailPath).toString();
        let thumbnailMo: MediaObject;

        try {
            await fs.promises.access(thumbnailPath);
            thumbnailMo = await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);
        } catch (e) {
            if (e.toString().includes('ENOENT')) {
                await this.saveThumbnail(thumbnailId);
                thumbnailMo = await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);
            }
        }

        return thumbnailMo;
    }

    async removeVideoClips(...videoClipIds: string[]): Promise<void> {
        const logger = this.getLogger();
        logger.debug('Removing videoclips ', videoClipIds.join(', '));
        for (const videoClipId of videoClipIds) {
            const { videoClipPath, thumbnailPath } = this.getStorageDirs(videoClipId);
            await fs.promises.rm(videoClipPath);
            logger.log(`Videoclip ${videoClipId} removed`);

            await fs.promises.rm(thumbnailPath);
            logger.log(`Thumbnail ${thumbnailPath} removed`);
        }

        return;
    }

    async scanFs() {
        const logger = this.getLogger();
        const { deviceFolder, videoClipsFolder } = this.getStorageDirs();
        let occupiedSizeInBytes = 0;

        const calculateSize = async (currentPath: string) => {
            const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);
                if (entry.isDirectory()) {
                    await calculateSize(fullPath);
                } else if (entry.isFile()) {
                    const stats = await fs.promises.stat(fullPath);
                    occupiedSizeInBytes += stats.size;
                }
            }
        }

        await calculateSize(deviceFolder);
        const occupiedSpaceInGbNumber = (occupiedSizeInBytes / (1024 * 1024 * 1024));
        const occupiedSpaceInGb = occupiedSpaceInGbNumber.toFixed(2);
        const { maxSpaceInGb } = this.storageSettings.values;
        const freeMemory = maxSpaceInGb - occupiedSpaceInGbNumber;
        this.storageSettings.settings.occupiedSpaceInGb.range = [0, maxSpaceInGb]
        this.putMixinSetting('occupiedSpaceInGb', occupiedSpaceInGb);
        logger.debug(`Occupied space: ${occupiedSpaceInGb} GB`);

        this.plugin.setMixinOccupancy(this.id, {
            free: freeMemory,
            occupied: occupiedSpaceInGbNumber,
            total: maxSpaceInGb
        });

        if (freeMemory <= cleanupMemoryThresholderInGb) {
            const files = await fs.promises.readdir(videoClipsFolder);

            const fileDetails = files
                .map((file) => {
                    const match = file.match(videoClipRegex);
                    if (match) {
                        const timeStart = match[1];
                        const { videoClipPath } = this.getStorageDirs(file);
                        return { file, fullPath: videoClipPath, timeStart: Number(timeStart) };
                    }
                    return null;
                })
                .filter(Boolean);

            fileDetails.sort((a, b) => a.timeStart - b.timeStart);

            logger.log(`Deleting ${clipsToCleanup} oldest files...`);

            for (let i = 0; i < clipsToCleanup; i++) {
                const { fullPath, file } = fileDetails[i];
                await fs.promises.rm(fullPath);
                logger.log(`Deleted videoclip: ${file}`);
                const { thumbnailPath } = this.getStorageDirs(file);
                await fs.promises.rm(thumbnailPath);
                logger.log(`Deleted thumbnail: ${thumbnailPath}`);
            }
        }
    }

    async indexFs() {
        const logger = this.getLogger();
        const { videoClipsFolder } = this.getStorageDirs();
        const filesData: VideoclipFileData[] = [];
        const recordedEvents: RecordedEvent[] = [];

        const entries = (await fs.promises.readdir(videoClipsFolder, { withFileTypes: true })) || [];
        const filteredEntries = entries.filter(entry => entry.name.endsWith('.mp4')) || [];

        for (const entry of filteredEntries) {
            try {
                const { videoClipPath, thumbnailPath, filename, tmpClipFilename } = this.getStorageDirs(entry.name);
                const stats = await fs.promises.stat(videoClipPath);

                if (entry.name === tmpClipFilename) {
                    continue;
                }

                const [_, startTime, endTime, detectionsHash] = entry.name.match(videoClipRegex);

                const detectionClasses: DetectionClass[] = [];
                const detectionFlags = detectionsHash.split('');
                detectionFlags.forEach((flag, index) => flag === '1' && detectionClasses.push(detectionClassIndexReversed[index]));
                const sortedClassnames = sortBy(detectionClasses,
                    (classname) => classnamePrio[classname] ?? 100,
                );
                const startTimeNumber = Number(startTime);
                const endTimeNumber = Number(endTime);

                filesData.push({
                    detectionClasses,
                    endTime: endTimeNumber,
                    startTime: startTimeNumber,
                    size: stats.size,
                    filename,
                    thumbnailPath,
                    videoClipPath
                });
                recordedEvents.push({
                    data: {},
                    details: {
                        eventId: filename,
                        eventTime: startTimeNumber,
                        eventInterface: sortedClassnames[0],
                        mixinId: this.id,
                    }
                })
            } catch (e) {
                logger.log(`Error parsing file entry: ${JSON.stringify({ entry })}`, e);
            }
        }

        this.scanData = filesData;
        this.recordedEvents = recordedEvents;
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
        await this.resetListeners({});
    }

    async saveThumbnail(filename: string) {
        const logger = this.getLogger();
        logger.log(`Generating thumbnail for ${filename}`);
        return new Promise<void>((resolve) => {
            const { thumbnailPath, videoClipPath } = this.getStorageDirs(filename);

            const snapshotFfmpeg = spawn(this.ffmpegPath, [
                '-ss', (this.prebuffer / (2 * 1000)).toString(),
                '-i', `${videoClipPath}`,
                thumbnailPath
            ], {
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: false
            });

            attachProcessEvents({
                processName: 'Thumbnail generator',
                childProcess: snapshotFfmpeg,
                logger,
                onClose: async () => {
                    logger.log(`Snapshot stored ${thumbnailPath}`);
                    resolve();
                }
            });
        });
    }

    async startSaveVideoClip() {
        this.recordingTimeStart = Date.now();
        const logger = this.getLogger();
        const now = Date.now();
        const { tmpClipPath } = this.getStorageDirs();

        logger.log(`Start saving videoclip: ${now}`);
        this.saveFfmpegProcess = spawn(this.ffmpegPath, [
            '-rtsp_transport', 'tcp',
            '-i', this.rtspUrl,
            '-c:v', 'copy',
            '-f', 'mp4',
            tmpClipPath,
        ], {
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: false
        });

        this.storageSettings.values.processPid = this.saveFfmpegProcess.pid;

        attachProcessEvents({
            processName: 'Videoclip generator',
            childProcess: this.saveFfmpegProcess,
            logger,
            onClose: async () => {
                this.recording = false;
                const endTime = Date.now();
                this.lastClipRecordedTime = endTime;

                let currentChecks = 0;
                let found = false;
                while (currentChecks < 5 && !found) {
                    try {
                        await fs.promises.access(tmpClipPath);
                        found = true;
                    } catch {
                        logger.log(`Waiting for the file to be available. Current check ${currentChecks + 1}`);
                        currentChecks += 1;
                        await sleep(2000);
                    }
                }

                const filename = getVideoClipName({
                    classesDetected: uniq(this.classesDetected),
                    endTime,
                    logger,
                    startTime: this.recordingTimeStart,
                });
                const { videoClipPath } = this.getStorageDirs(filename);
                await fs.promises.rename(tmpClipPath, videoClipPath);
                logger.log(`Videoclip stored ${videoClipPath}`);
                await this.saveThumbnail(filename);
                this.classesDetected = [];
                this.saveRecordingListener && clearTimeout(this.saveRecordingListener);
                this.shouldIndexFs = true;
                this.lastIndexFs = Date.now();
                this.storageSettings.values.processPid = undefined;
            }
        });
    }

    async stopSaveViddeoClip() {
        const logger = this.getLogger();
        logger.log('Stopping videoclip');
        this.saveFfmpegProcess.kill('SIGINT');
    }

    restartTimeout() {
        this.saveRecordingListener && clearTimeout(this.saveRecordingListener);
        this.saveRecordingListener = setTimeout(async () => {
            await this.stopSaveViddeoClip();
        }, this.clipDurationInMs);
    }

    async triggerMotionRecording() {
        const logger = this.getLogger();
        const now = Date.now();
        const { maxLength, minDelayBetweenClips } = this.storageSettings.values;

        if (!this.recording) {
            if (this.lastClipRecordedTime && (now - this.lastClipRecordedTime) < minDelayBetweenClips * 1000) {
                return;
            }

            this.lastClipRecordedTime = undefined;
            this.recordingTimeStart = now;
            this.recording = true;
            logger.log(`Starting new recording: ${JSON.stringify({
                recordingTimeStart: this.recordingTimeStart,
            })}`);
            await this.startSaveVideoClip();
            this.restartTimeout();
        } else {
            const currentDuration = (now - this.recordingTimeStart) / 1000;
            const clipDuration = this.clipDurationInMs / 1000;
            const shouldExtend = currentDuration < (maxLength - clipDuration);

            logger.debug(`Log extension check: ${JSON.stringify({
                shouldExtend,
                currentDuration,
                maxLength,
                clipDuration
            })}`)
            if (shouldExtend) {
                if (!this.lastExtendLogged || (now - this.lastExtendLogged > 1000)) {
                    this.lastExtendLogged = now;
                    logger.debug(`Extending recording: ${now}`);
                    this.restartTimeout();
                }
            }
        }
    }

    async startListeners() {
        const logger = this.getLogger();
        try {
            await this.resetListeners({ skipMainLoop: true });
            this.running = true;
            const { scoreThreshold, detectionClasses, ignoreCameraDetections } = this.storageSettings.values;

            const objectDetectionClasses = detectionClasses.filter(detClass => detClass !== DetectionClass.Motion);

            logger.log(`Starting listener of ${ScryptedInterface.ObjectDetector}`);
            const classes: string[] = [];
            this.detectionListener = systemManager.listenDevice(this.id, ScryptedInterface.ObjectDetector, async (_, __, data: ObjectsDetected) => {
                const filtered = data.detections.filter(det => {
                    const classname = detectionClassesDefaultMap[det.className];

                    if (ignoreCameraDetections && !det.boundingBox) {
                        return false;
                    }

                    if (classname && objectDetectionClasses.includes(classname) && det.score >= scoreThreshold) {
                        classes.push(det.className);
                        return true;
                    } else {
                        return false;
                    }
                });

                const now = Date.now();

                if (!filtered.length) {
                    return;
                }

                this.classesDetected.push(...classes);
                this.lastMotionTrigger = now;
                this.triggerMotionRecording().catch(logger.log);
            });

            if (defaultClasses.includes(DetectionClass.Motion)) {
                this.motionListener = systemManager.listenDevice(this.id, ScryptedInterface.MotionSensor, async (_, __, data: boolean) => {
                    const now = Date.now();

                    if (this.lastMotionTrigger && (now - this.lastMotionTrigger) < 1 * 1000) {
                        return;
                    }

                    this.classesDetected.push(DetectionClass.Motion);
                    this.lastMotionTrigger = now;
                    this.triggerMotionRecording().catch(logger.log);
                });
            }
        } catch (e) {
            logger.log('Error in startListeners', e);
        }
    }

    async getVideoclipWebhookUrls(filename: string) {
        const cloudEndpoint = await sdk.endpointManager.getCloudEndpoint(undefined, { public: true });
        const [endpoint, parameters] = cloudEndpoint.split('?') ?? '';
        const params = {
            deviceId: this.id,
            filename,
        }

        const videoclipUrl = `${endpoint}videoclip?params=${JSON.stringify(params)}&${parameters}`;
        const thumbnailUrl = `${endpoint}thumbnail?params=${JSON.stringify(params)}&${parameters}`;

        return { videoclipUrl, thumbnailUrl };
    }

    getStorageDirs(videoClipNameSrc?: string) {
        const { storagePath } = this.plugin.storageSettings.values;
        if (!storagePath) {
            throw new Error('Storage path not defined on the plugin');
        }

        const deviceFolder = path.join(storagePath, this.cameraDevice.id);
        const videoClipsFolder = path.join(deviceFolder, 'videoclips');
        const thumbnailsFolder = path.join(deviceFolder, 'thumbnails');

        const filename = videoClipNameSrc?.split('.')?.[0] ?? videoClipNameSrc;
        const videoClipPath = filename ? path.join(videoClipsFolder, `${filename}.mp4`) : undefined;
        const thumbnailPath = filename ? path.join(thumbnailsFolder, `${filename}.jpg`) : undefined;

        const tmpClipFilename = 'tmp_clip.mp4';
        const tmpClipPath = path.join(videoClipsFolder, tmpClipFilename);

        return {
            deviceFolder,
            videoClipsFolder,
            thumbnailsFolder,
            videoClipPath,
            thumbnailPath,
            tmpClipFilename,
            filename,
            tmpClipPath
        }
    }
}