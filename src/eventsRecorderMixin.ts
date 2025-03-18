import { SettingsMixinDeviceBase } from "@scrypted/common/src/settings-mixin";
import { sleep } from '@scrypted/common/src/sleep';
import sdk, { EventListenerRegister, EventRecorder, FFmpegInput, MediaObject, MediaStreamUrl, ObjectsDetected, RecordedEvent, RecordedEventOptions, RecordingStreamThumbnailOptions, RequestRecordingStreamOptions, ResponseMediaStreamOptions, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions, VideoRecorder, WritableDeviceState } from '@scrypted/sdk';
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
import { listenZeroSingleClient } from '@scrypted/common/src/listen-cluster';
import { Deferred } from '@scrypted/common/src/deferred';

const { systemManager } = sdk;

export class EventsRecorderMixin extends SettingsMixinDeviceBase<DeviceType> implements Settings, VideoClips, EventRecorder, VideoRecorder {
    cameraDevice: DeviceType;
    killed: boolean;
    rtspUrl: string;
    mainLoopListener: NodeJS.Timeout;
    detectionListener: EventListenerRegister;
    motionListener: EventListenerRegister;
    logger: Console;
    saveFfmpegProcess: ChildProcessWithoutNullStreams;
    running = false;
    ffmpegPath: string;
    lastIndexFs: number;
    lastScanFs: number;
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

    currentTime: number;

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
            onPut: async (_, newValue) => await this.scanFs(newValue)
        },
        occupiedSpaceInGb: {
            title: 'Memory occupancy in GB',
            type: 'number',
            range: [0, 20],
            readonly: true,
            placeholder: 'GB'
        },
        ignoreCameraDetections: {
            title: 'Ignore camera detections',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        transcodeToH264: {
            title: 'Transcode to h264',
            type: 'boolean',
            defaultValue: true,
            immediate: true,
        },
        prolongClipOnMotion: {
            title: 'Prolong the clip on motion',
            description: 'If checked, the clip will be prolonged for any motion received, otherwise will use the detection classes configured.',
            type: 'boolean',
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
                    this.ffmpegPath = await sdk.mediaManager.getFFmpegPath();
                    const processPid = this.storageSettings.values.processPid;
                    try {
                        processPid && process.kill(processPid, 'SIGTERM');
                    } catch {
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

    async getRecordingStream(options: RequestRecordingStreamOptions, recordingStream?: MediaObject): Promise<MediaObject> {
        const logger = this.getLogger();
        const foundClip = this.scanData.reduce((closest, obj) =>
            Math.abs(obj.startTime - options.startTime) < Math.abs(closest.startTime - options.startTime) ? obj : closest
        );
        logger.log(`STREAM: ${JSON.stringify({ options, foundClip, recordingStream, startTime: new Date(options.startTime).toISOString() })}`);

        if (foundClip) {
            this.currentTime = foundClip.startTime;

            const kill = new Deferred<void>();

            const rtspServer = await listenZeroSingleClient('127.0.0.1');
            // rtspServer.clientPromise.then(async rtsp => {
            //     kill.promise.finally(() => rtsp.destroy());
            //     rtsp.on('close', () => kill.resolve());
            //     try {
            //         // const process = spawn(this.ffmpegPath, [
            //         //     '-re', '-i', foundClip.videoClipPath,
            //         //     '-c:v', 'copy',
            //         //     '-an',
            //         //     '-f', 'rtsp',
            //         //     `${playbackUrl}`
            //         // ], {
            //         //     stdio: ['pipe', 'pipe', 'pipe'],
            //         //     detached: false
            //         // });
            //         const process = await startRtpForwarderProcess(this.console, {
            //             inputArguments: [
            //                 '-f', 'h264', '-i', 'pipe:4',
            //                 '-f', 'aac', '-i', 'pipe:5',
            //             ]
            //         }, {
            //             video: {
            //                 onRtp: rtp => {
            //                     if (videoTrack)
            //                         rtsp.sendTrack(videoTrack.control, rtp, false);
            //                 },
            //                 encoderArguments: [
            //                     '-vcodec', 'copy',
            //                 ]
            //             },
            //             audio: {
            //                 onRtp: rtp => {
            //                     if (audioTrack)
            //                         rtsp.sendTrack(audioTrack.control, rtp, false);
            //                 },
            //                 encoderArguments: [
            //                     '-acodec', 'copy',
            //                     '-rtpflags', 'latm',
            //                 ]
            //             }
            //         });

            //         process.killPromise.finally(() => kill.resolve());
            //         kill.promise.finally(() => process.kill());

            //         let parsedSdp: ReturnType<typeof parseSdp>;
            //         let videoTrack: typeof parsedSdp.msections[0]
            //         let audioTrack: typeof parsedSdp.msections[0]
            //         process.sdpContents.then(async sdp => {
            //             sdp = addTrackControls(sdp);
            //             rtsp.sdp = sdp;
            //             parsedSdp = parseSdp(sdp);
            //             videoTrack = parsedSdp.msections.find(msection => msection.type === 'video');
            //             audioTrack = parsedSdp.msections.find(msection => msection.type === 'audio');
            //             await rtsp.handlePlayback();
            //         });

            //         const proxyStream = await livestreamManager.getLocalLivestream();
            //         proxyStream.videostream.pipe(process.cp.stdio[4] as Writable);
            //         proxyStream.audiostream.pipe((process.cp.stdio as any)[5] as Writable);
            //     }
            //     catch (e) {
            //         rtsp.client.destroy();
            //     }
            // });

            // return sdk.mediaManager.createMediaObject(ret, ScryptedMimeTypes.MediaStreamUrl);
            // const videoclipFfmpeg = spawn(this.ffmpegPath, [
            //     '-re', '-i', foundClip.videoClipPath,
            //     '-c:v', 'copy',
            //     '-an',
            //     '-f', 'rtsp',
            //     `${playbackUrl}`
            // ], {
            //     stdio: ['pipe', 'pipe', 'pipe'],
            //     detached: false
            // });

            // attachProcessEvents({
            //     processName: 'Videoclip serving',
            //     childProcess: videoclipFfmpeg,
            //     logger,
            //     onClose: async () => {
            //         // logger.log(`Snapshot stored ${thumbnailPath}`);
            //         // resolve();
            //     }
            // });

            return this.createMediaObject(rtspServer, ScryptedMimeTypes.MediaStreamUrl);
        }
    }

    async getRecordingStreamCurrentTime(recordingStream: MediaObject): Promise<number> {
        const logger = this.getLogger();
        logger.log(`CURRENT TIME: ${JSON.stringify({ recordingStream })}`);
        this.currentTime += 1000;
        return this.currentTime;
    }

    getRecordingStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        const logger = this.getLogger();
        logger.log(`OPTIONS`);
        throw new Error("Method not implemented.");
    }
    getRecordingStreamThumbnail(time: number, options?: RecordingStreamThumbnailOptions): Promise<MediaObject> {
        const logger = this.getLogger();
        logger.log(`THUMBNAIL: ${JSON.stringify({ options, time })}`);
        throw new Error("Method not implemented.");
    }

    async getRecordedEvents(options: RecordedEventOptions): Promise<RecordedEvent[]> {
        return this.recordedEvents.filter(item =>
            item.details.eventTime > options.startTime &&
            item.details.eventTime < options.endTime
        ).slice(0, options.count);
    }

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

                    // Every 3 hours force a re-indexing of the videoclips
                    if (!this.lastIndexFs || (now - this.lastIndexFs) > (1000 * 60 * 60 * 3)) {
                        await this.indexFs();
                    }

                    // Every 1 hour
                    if (!this.lastScanFs || (now - this.lastScanFs) > (1000 * 60 * 60)) {
                        await this.scanFs();
                    }
                }
            } catch (e) {
                logger.log('Error in startCheckInterval', e);
            }
        }, 10000);

        await this.scanFs();
        await this.indexFs();
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
            await fs.promises.rm(videoClipPath, { force: true, recursive: true, maxRetries: 10 });
            logger.log(`Videoclip ${videoClipId} removed`);

            await fs.promises.rm(thumbnailPath, { force: true, recursive: true, maxRetries: 10 });
            logger.log(`Thumbnail ${thumbnailPath} removed`);
        }

        return;
    }

    async scanFs(newMaxMemory?: number) {
        const logger = this.getLogger();
        const { deviceFolder, videoClipsFolder } = this.getStorageDirs();
        let occupiedSizeInBytes = 0;
        logger.log(`Starting FS scan: ${JSON.stringify({ newMaxMemory })}`);

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
        const { maxSpaceInGb: maxSpaceInGbSrc } = this.storageSettings.values;
        const maxSpaceInGb = newMaxMemory ?? maxSpaceInGbSrc;
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
                await fs.promises.rm(fullPath, { force: true, recursive: true, maxRetries: 10 });
                logger.log(`Deleted videoclip: ${file}`);
                const { thumbnailPath } = this.getStorageDirs(file);
                await fs.promises.rm(thumbnailPath, { force: true, recursive: true, maxRetries: 10 });
                logger.log(`Deleted thumbnail: ${thumbnailPath}`);
            }
        }

        this.lastScanFs = Date.now();
        logger.log(`FS scan executed: ${JSON.stringify({
            freeMemory,
            occupiedSpaceInGbNumber,
            maxSpaceInGb,
            cleanupMemoryThresholderInGb
        })}`);
    }

    async parseVideoClipFile(videoClipName: string) {
        const logger = this.getLogger();

        try {
            const { videoClipPath, thumbnailPath, filename, tmpClipFilename } = this.getStorageDirs(videoClipName);
            const stats = await fs.promises.stat(videoClipPath);

            if (videoClipName === tmpClipFilename) {
                return;
            }

            const [_, startTime, endTime, detectionsHash] = videoClipName.match(videoClipRegex);

            const detectionClasses: DetectionClass[] = [];
            const detectionFlags = detectionsHash.split('');
            detectionFlags.forEach((flag, index) => flag === '1' && detectionClasses.push(detectionClassIndexReversed[index]));
            const sortedClassnames = sortBy(detectionClasses,
                (classname) => classnamePrio[classname] ?? 100,
            );
            const startTimeNumber = Number(startTime);
            const endTimeNumber = Number(endTime);

            const fildeData: VideoclipFileData = {
                detectionClasses,
                endTime: endTimeNumber,
                startTime: startTimeNumber,
                size: stats.size,
                filename,
                thumbnailPath,
                videoClipPath
            };

            const recordedEvent: RecordedEvent = {
                data: {},
                details: {
                    eventId: filename,
                    eventTime: startTimeNumber,
                    eventInterface: sortedClassnames[0],
                    mixinId: this.id,
                }
            };

            return { fildeData, recordedEvent };
        } catch (e) {
            logger.log(`Error parsing file entry: ${JSON.stringify({ videoClipName })}`, e);
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
            const parsedEntry = await this.parseVideoClipFile(entry.name);

            if (parsedEntry) {
                const { fildeData, recordedEvent } = parsedEntry;

                filesData.push(fildeData);
                recordedEvents.push(recordedEvent);
            }
        }

        this.scanData = filesData;
        this.recordedEvents = recordedEvents;
        this.lastIndexFs = Date.now();

        logger.log(`FS indexed: ${JSON.stringify({
            videoclipsFound: filesData.length,
            recordedEventsFound: recordedEvents.length,
        })}`);
    }

    async getMixinSettings(): Promise<Setting[]> {
        const settings = await this.storageSettings.getSettings();

        return settings;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        const [group, ...rest] = key.split(':');
        if (group === this.settingsGroupKey) {
            this.storageSettings.putSetting(rest.join(':'), value);
        } else {
            super.putSetting(key, value);
        }
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

    async startVideoclipRecording() {
        this.recordingTimeStart = Date.now();
        const logger = this.getLogger();
        const { tmpClipPath } = this.getStorageDirs();

        const { transcodeToH264 } = this.storageSettings.values;
        this.saveFfmpegProcess = spawn(this.ffmpegPath, [
            '-rtsp_transport', 'tcp',
            '-i', this.rtspUrl,
            '-c:v', transcodeToH264 ? 'libx264' : 'copy',
            // '-c:a', 'aac',
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
                while (currentChecks < 10 && !found) {
                    try {
                        await fs.promises.access(tmpClipPath);
                        found = true;
                    } catch {
                        logger.log(`Waiting for the file to be available. Current check ${currentChecks + 1}`);
                        currentChecks += 1;
                        await sleep(5000);
                    }
                }

                if (!found) {
                    logger.log(`File ${tmpClipPath} not found, probably lost somewhere`);
                    return;
                }

                const filename = getVideoClipName({
                    classesDetected: uniq(this.classesDetected),
                    endTime,
                    logger,
                    startTime: this.recordingTimeStart,
                });
                const { videoClipPath, filenameWithVideoExtension } = this.getStorageDirs(filename);
                await fs.promises.rename(tmpClipPath, videoClipPath);
                logger.log(`Videoclip stored ${videoClipPath}`);
                await this.saveThumbnail(filename);
                this.classesDetected = [];
                this.saveRecordingListener && clearTimeout(this.saveRecordingListener);
                this.storageSettings.values.processPid = undefined;

                const parsedEntry = await this.parseVideoClipFile(filenameWithVideoExtension);
                if (parsedEntry) {
                    const { fildeData, recordedEvent } = parsedEntry;

                    this.scanData.push(fildeData);
                    this.recordedEvents.push(recordedEvent);
                }
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

    async triggerMotionRecording(triggers: string[]) {
        const logger = this.getLogger();
        const now = Date.now();
        const { maxLength, minDelayBetweenClips } = this.storageSettings.values;

        logger.debug(`Recording starting attempt: ${JSON.stringify({
            recording: this.recording,
            lastClipRecordedTime: this.lastClipRecordedTime,
            timePassed: this.lastClipRecordedTime && (now - this.lastClipRecordedTime) < minDelayBetweenClips * 1000,
            triggers
        })}`);

        if (!this.recording) {
            if (this.lastClipRecordedTime && (now - this.lastClipRecordedTime) < minDelayBetweenClips * 1000) {
                return;
            }

            this.lastClipRecordedTime = undefined;
            this.recordingTimeStart = now;
            this.recording = true;
            logger.log(`Starting new recording: ${JSON.stringify({
                recordingTimeStart: this.recordingTimeStart,
                classTriggers: triggers
            })}`);
            await this.startVideoclipRecording();
            this.restartTimeout();
        } else {
            const currentDuration = (now - this.recordingTimeStart) / 1000;
            const clipDuration = this.clipDurationInMs / 1000;
            const shouldExtend = currentDuration + clipDuration < maxLength;

            logger.debug(`Log extension check: ${JSON.stringify({
                shouldExtend,
                currentDuration,
                maxLength,
                clipDuration
            })}`);

            if (shouldExtend) {
                logger.log(`Extending recording: ${JSON.stringify({
                    currentDuration,
                    clipDuration,
                    maxLength,
                    triggers
                })}`);

                this.restartTimeout();
            }
        }
    }

    async startListeners() {
        const logger = this.getLogger();
        try {
            await this.resetListeners({ skipMainLoop: true });
            this.running = true;
            const { scoreThreshold, detectionClasses, ignoreCameraDetections, prolongClipOnMotion } = this.storageSettings.values;

            const objectDetectionClasses = detectionClasses.filter(detClass => detClass !== DetectionClass.Motion);
            const isMotionIncluded = detectionClasses.includes(DetectionClass.Motion);

            const classesMap = new Map<string, boolean>();
            logger.log(`Starting listener of ${ScryptedInterface.ObjectDetector}`);
            this.detectionListener = systemManager.listenDevice(this.id, ScryptedInterface.ObjectDetector, async (_, __, data: ObjectsDetected) => {
                const filtered = data.detections.filter(det => {
                    const classname = detectionClassesDefaultMap[det.className];

                    if (ignoreCameraDetections && !det.boundingBox) {
                        return false;
                    }

                    if (classname && objectDetectionClasses.includes(classname) && det.score >= scoreThreshold) {
                        classesMap.set(classname, true);
                        return true;
                    } else {
                        return false;
                    }
                });

                logger.debug(`Object detections received: ${JSON.stringify({
                    filtered,
                    data,
                    scoreThreshold
                })}`);

                if (!filtered.length) {
                    return;
                }

                const now = Date.now();

                const classes = Array.from(classesMap.keys());
                this.classesDetected.push(...classes);
                this.lastMotionTrigger = now;
                this.triggerMotionRecording(classes).catch(logger.log);
            });

            logger.log(`Starting listener of ${ScryptedInterface.MotionSensor}`);
            this.motionListener = systemManager.listenDevice(this.id, ScryptedInterface.MotionSensor, async (_, __, data: boolean) => {
                const now = Date.now();

                if (data) {
                    logger.debug(`Motion received: ${JSON.stringify({
                        lastMotion: this.lastMotionTrigger,
                    })}`);

                    if (this.lastMotionTrigger && (now - this.lastMotionTrigger) < 1 * 1000) {
                        return;
                    }

                    this.classesDetected.push(DetectionClass.Motion);
                    this.lastMotionTrigger = now;

                    if (isMotionIncluded || (prolongClipOnMotion && this.recording)) {
                        this.triggerMotionRecording([DetectionClass.Motion]).catch(logger.log);
                    }
                }
            });
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
        const filenameWithVideoExtension = `${filename}.mp4`;
        const filenameWithImageExtension = `${filename}.jpg`;
        const videoClipPath = filename ? path.join(videoClipsFolder, `${filenameWithVideoExtension}`) : undefined;
        const thumbnailPath = filename ? path.join(thumbnailsFolder, `${filenameWithImageExtension}`) : undefined;

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
            tmpClipPath,
            filenameWithVideoExtension,
        }
    }
}
