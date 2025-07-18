import { SettingsMixinDeviceBase } from "@scrypted/common/src/settings-mixin";
import { sleep } from '@scrypted/common/src/sleep';
import sdk, { EventDetails, EventListenerRegister, EventRecorder, MediaObject, ObjectsDetected, RecordedEvent, RecordedEventOptions, RecordingStreamThumbnailOptions, RequestRecordingStreamOptions, ResponseMediaStreamOptions, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions, VideoRecorder, WritableDeviceState } from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import fs from 'fs';
import { sortBy, uniq } from 'lodash';
import moment from "moment";
import path from 'path';
import { classnamePrio, DetectionClass, detectionClassesDefaultMap } from '../../scrypted-advanced-notifier/src/detectionClasses';
import ObjectDetectionPlugin from './main';
import { attachProcessEvents, calculateSize, cleanupMemoryThresholderInGb, clipsToCleanup, defaultClasses, detectionClassIndex, detectionClassIndexReversed, DeviceType, getMainDetectionClass, getVideoClipName, pluginId, VideoclipFileData, videoClipRegex } from './util';

const { systemManager } = sdk;

type Codec = 'h264' | 'h265';

export class EventsRecorderMixin extends SettingsMixinDeviceBase<DeviceType> implements Settings, VideoClips, EventRecorder, VideoRecorder {
    cameraDevice: DeviceType;
    killed: boolean;
    rtspUrl: string;
    codec: Codec;
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
            description: 'Leave blank to use object detection thresholds',
            type: 'number',
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
        // transcodeToH264: {
        //     title: 'Transcode to h264',
        //     type: 'boolean',
        //     defaultValue: true,
        //     immediate: true,
        //     hide: true,
        // },
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
        return;
    }
    // async getRecordingStream(options: RequestRecordingStreamOptions, recordingStream?: MediaObject): Promise<MediaObject> {
    //     const logger = this.getLogger();
    //     const foundClip = this.scanData.reduce((closest, obj) =>
    //         Math.abs(obj.startTime - options.startTime) < Math.abs(closest.startTime - options.startTime) ? obj : closest
    //     );
    //     logger.log(`STREAM: ${JSON.stringify({ options, foundClip, recordingStream, startTime: new Date(options.startTime).toISOString() })}`);

    //     if (foundClip) {
    //         this.currentTime = foundClip.startTime;
    //         const kill = new Deferred<void>();

    //         const rtspServer = new RtspServer(client, sdp);
    //         const rtspServer = await listenZeroSingleClient('127.0.0.1');
    //         rtspServer.clientPromise.then(async rtsp => {
    //             kill.promise.finally(() => rtsp.destroy());
    //             rtsp.on('close', () => kill.resolve());
    //             try {
    //                 // const process = spawn(this.ffmpegPath, [
    //                 //     '-re', '-i', foundClip.videoClipPath,
    //                 //     '-c:v', 'copy',
    //                 //     '-an',
    //                 //     '-f', 'rtsp',
    //                 //     `${playbackUrl}`
    //                 // ], {
    //                 //     stdio: ['pipe', 'pipe', 'pipe'],
    //                 //     detached: false
    //                 // });
    //                 const process = await startRtpForwarderProcess(this.console, {
    //                     inputArguments: [
    //                         '-f', 'h264', '-i', 'pipe:4',
    //                         '-f', 'aac', '-i', 'pipe:5',
    //                     ]
    //                 }, {
    //                     video: {
    //                         onRtp: rtp => {
    //                             if (videoTrack)
    //                                 rtsp.sendTrack(videoTrack.control, rtp, false);
    //                         },
    //                         encoderArguments: [
    //                             '-vcodec', 'copy',
    //                         ]
    //                     },
    //                     audio: {
    //                         onRtp: rtp => {
    //                             if (audioTrack)
    //                                 rtsp.sendTrack(audioTrack.control, rtp, false);
    //                         },
    //                         encoderArguments: [
    //                             '-acodec', 'copy',
    //                             '-rtpflags', 'latm',
    //                         ]
    //                     }
    //                 });

    //                 process.killPromise.finally(() => kill.resolve());
    //                 kill.promise.finally(() => process.kill());

    //                 let parsedSdp: ReturnType<typeof parseSdp>;
    //                 let videoTrack: typeof parsedSdp.msections[0]
    //                 let audioTrack: typeof parsedSdp.msections[0]
    //                 process.sdpContents.then(async sdp => {
    //                     sdp = addTrackControls(sdp);
    //                     rtsp.sdp = sdp;
    //                     parsedSdp = parseSdp(sdp);
    //                     videoTrack = parsedSdp.msections.find(msection => msection.type === 'video');
    //                     audioTrack = parsedSdp.msections.find(msection => msection.type === 'audio');
    //                     await rtsp.handlePlayback();
    //                 });

    //                 const proxyStream = await livestreamManager.getLocalLivestream();
    //                 proxyStream.videostream.pipe(process.cp.stdio[4] as Writable);
    //                 proxyStream.audiostream.pipe((process.cp.stdio as any)[5] as Writable);
    //             }
    //             catch (e) {
    //                 rtsp.client.destroy();
    //             }
    //         });

    //         return sdk.mediaManager.createMediaObject(ret, ScryptedMimeTypes.MediaStreamUrl);

    //         // const { server: rtspServer, url, cancel, clientPromise } = await listenZeroSingleClient('127.0.0.1');
    //         // const ffmpegProcess = spawn('ffmpeg', [
    //         //     '-re', // Legge il file in tempo reale
    //         //     '-i', foundClip.videoClipPath, // Percorso del file MP4
    //         //     '-c:v', 'copy', // Copia il codec video senza ricodifica
    //         //     '-f', 'rtsp', // Formato di output RTSP
    //         //     url, // URL del server RTSP
    //         // ]);

    //         // ffmpegProcess.stdout.on('data', (data) => {
    //         //     logger.log(`FFmpeg stdout: ${data}`);
    //         // });

    //         // ffmpegProcess.stderr.on('data', (data) => {
    //         //     logger.error(`FFmpeg stderr: ${data}`);
    //         // });

    //         // ffmpegProcess.on('close', (code) => {
    //         //     logger.log(`FFmpeg process exited with code ${code}`);
    //         //     cancel(); // Chiude il server quando ffmpeg termina
    //         // });


    //         // try {
    //         //     const client = await clientPromise;
    //         //     logger.log('Client connected:', client.remoteAddress);
    //         // } catch (error) {
    //         //     logger.error('Error waiting for client:', error);
    //         // }

    //         return this.createMediaObject(rtspServer, ScryptedMimeTypes.MediaStreamUrl);
    //     }
    // }

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
        const logger = this.getLogger();
        try {

            let events = this.recordedEvents.filter(item => {
                if (!options) {
                    return true
                }
                const startOk = options.startTime ? item.details.eventTime > options.startTime : true;
                const endOk = options.endTime ? item.details.eventTime < options.endTime : true;

                return startOk && endOk;
            });

            if (options?.count) {
                events = events.slice(0, options.count);
            }

            logger.debug(`RecordedEvents: ${JSON.stringify(events)}`);

            return events;
        } catch (e) {
            logger.log('Error in getRecordedEvents', JSON.stringify(this.recordedEvents), e);
            return [];
        }
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
        this.codec = streamConfig.video.codec as Codec;
        this.clipDurationInMs = this.prebuffer + (postEventSeconds * 1000);
        const deviceSettings = await this.cameraDevice.getSettings();
        const rebroadcastConfig = deviceSettings.find(setting => setting.subgroup === `Stream: ${streamName}` && setting.title === 'RTSP Rebroadcast Url');
        this.rtspUrl = rebroadcastConfig?.value as string;

        logger.log(`Rebroadcast URL found: ${JSON.stringify({
            url: this.rtspUrl,
            streamName,
            streamConfig
        })}`);

        try {
            const { thumbnailsFolder, videoClipsFolder } = this.getStorageDirs({});

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
                        detectionClasses: [...detectionClasses],
                        event,
                        description: pluginId,
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

        try {
            const deviceClips = await this.mixinDevice.getVideoClips(options);
            videoclips.push(...deviceClips);
        } catch { }

        const logger = this.getLogger();
        logger.debug(`Videoclips: ${JSON.stringify(videoclips)}`);

        return sortBy(videoclips, 'startTime');;
    }

    async getVideoClip(videoId: string): Promise<MediaObject> {
        const logger = this.getLogger();
        try {
            const { videoClipPath } = this.getStorageDirs({ videoClipNameSrc: videoId });
            logger.log('Fetching videoId ', videoId, videoClipPath);
            await fs.promises.access(videoClipPath);
            const { videoclipUrl } = await this.getVideoclipWebhookUrls(videoId);
            const mo = await sdk.mediaManager.createMediaObject(Buffer.from(videoclipUrl), ScryptedMimeTypes.LocalUrl, {
                sourceId: this.plugin.id
            });

            return mo;
        } catch {
            try {
                return this.mixinDevice.getVideoClip(videoId);
            } catch (e) {
                logger.log(`Error in getVideoclip`, videoId, e);
            }
        }
    }

    async getVideoClipThumbnail(thumbnailId: string, options?: VideoClipThumbnailOptions): Promise<MediaObject> {
        const logger = this.getLogger();
        const { thumbnailPath, videoClipPath } = this.getStorageDirs({ videoClipNameSrc: thumbnailId });
        logger.log('Fetching thumbnailId ', thumbnailId, thumbnailPath);

        let thumbnailMo: MediaObject;
        try {
            try {
                await fs.promises.access(thumbnailPath);

                const jpeg = await fs.promises.readFile(thumbnailPath);
                thumbnailMo = await sdk.mediaManager.createMediaObject(jpeg, 'image/jpeg');
            } catch (e) {
                if (e.message.includes('ENOENT')) {
                    try {
                        await fs.promises.access(videoClipPath);
                        logger.log('Snapshot not found, trying to generate');
                        await this.saveThumbnail(thumbnailId);
                        const jpeg = await fs.promises.readFile(thumbnailPath);
                        thumbnailMo = await sdk.mediaManager.createMediaObject(jpeg, 'image/jpeg');
                    } catch {
                        logger.log('Videoclip probably corrupted, removing')
                        await fs.promises.rm(videoClipPath);
                        await this.indexFs();
                        throw new Error();
                    }
                } else {
                    throw new Error();
                }
            }

            return thumbnailMo;
        } catch {
            try {
                if (this.mixinDevice.interfaces.includes(ScryptedInterface.VideoClips)) {
                    return this.mixinDevice.getVideoClipThumbnail(thumbnailId, options);
                } else {
                    return null
                }
            } catch {}
        }
    }

    async removeVideoClips(...videoClipIds: string[]): Promise<void> {
        const logger = this.getLogger();
        logger.debug('Removing videoclips ', videoClipIds.join(', '));
        for (const videoClipId of videoClipIds) {
            const { videoClipPath, thumbnailPath } = this.getStorageDirs({ videoClipNameSrc: videoClipId });
            await fs.promises.rm(videoClipPath, { force: true, recursive: true, maxRetries: 10 });
            logger.log(`Videoclip ${videoClipId} removed`);

            await fs.promises.rm(thumbnailPath, { force: true, recursive: true, maxRetries: 10 });
            logger.log(`Thumbnail ${thumbnailPath} removed`);
        }

        return;
    }

    async scanFs(newMaxMemory?: number) {
        const logger = this.getLogger();
        logger.log(`Starting FS scan: ${JSON.stringify({ newMaxMemory })}`);

        const { deviceFolder, videoClipsFolder } = this.getStorageDirs({});
        const { maxSpaceInGb: maxSpaceInGbSrc } = this.storageSettings.values;
        const maxSpaceInGb = newMaxMemory ?? maxSpaceInGbSrc;

        const { occupiedSpaceInGb, occupiedSpaceInGbNumber, freeMemory } = await calculateSize({
            currentPath: deviceFolder,
            maxSpaceInGb
        });
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
                        const { videoClipPath } = this.getStorageDirs({ videoClipNameSrc: file });
                        return { file, fullPath: videoClipPath, timeStart: Number(timeStart) };
                    }
                    return null;
                })
                .filter(Boolean);

            fileDetails.sort((a, b) => a.timeStart - b.timeStart);

            const filesToDelete = Math.min(fileDetails.length, clipsToCleanup);

            logger.log(`Deleting ${filesToDelete} oldest files... ${JSON.stringify({ freeMemory, cleanupMemoryThresholderInGb })}`);

            for (let i = 0; i < filesToDelete; i++) {
                const { fullPath, file } = fileDetails[i];
                await fs.promises.rm(fullPath, { force: true, recursive: true, maxRetries: 10 });
                logger.log(`Deleted videoclip: ${file}`);
                const { thumbnailPath } = this.getStorageDirs({ videoClipNameSrc: file });
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
            const { videoClipPath, thumbnailPath, filename, tmpClipFilename } = this.getStorageDirs({ videoClipNameSrc: videoClipName });
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
                detectionClasses: sortedClassnames,
                endTime: endTimeNumber,
                startTime: startTimeNumber,
                size: stats.size,
                filename,
                thumbnailPath,
                videoClipPath
            };

            return { fildeData };
        } catch (e) {
            logger.log(`Error parsing file entry: ${JSON.stringify({ videoClipName })}`, e);
        }
    }

    async indexFs() {
        const logger = this.getLogger();
        const { videoClipsFolder, eventsFolder } = this.getStorageDirs({});
        const filesData: VideoclipFileData[] = [];
        const recordedEvents: RecordedEvent[] = [];

        const entries = (await fs.promises.readdir(videoClipsFolder, { withFileTypes: true })) || [];
        const filteredEntries = entries.filter(entry => entry.name.endsWith('.mp4')) || [];

        for (const entry of filteredEntries) {
            const parsedEntry = await this.parseVideoClipFile(entry.name);

            if (parsedEntry) {
                const { fildeData } = parsedEntry;

                filesData.push(fildeData);
            }
        }

        try {
            await fs.promises.access(eventsFolder);
            const days = (await fs.promises.readdir(eventsFolder, { withFileTypes: true }))
                .filter(dirent => dirent.isDirectory())
                .map(dirent => dirent.name)

            for (const dayFolder of days) {
                const jsonDir = path.join(eventsFolder, dayFolder)
                const files = (await fs.promises.readdir(jsonDir))
                    .filter(file => file.endsWith(".json"))

                for (const file of files) {
                    const fullPath = path.join(jsonDir, file)
                    try {
                        const content = await fs.promises.readFile(fullPath, "utf-8")
                        recordedEvents.push(...(JSON.parse(content) ?? []).map(item => ({
                            ...item,
                            details: {
                                ...item.details,
                                mixinId: this.plugin.id
                            }
                        })));
                    } catch (err) {
                        console.warn(`Error reading file ${fullPath}:`, err)
                    }
                }

            }
        } catch { }

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

    async saveThumbnail(filename: string, ss = (this.prebuffer / (2 * 1000)).toString()) {
        const logger = this.getLogger();
        logger.log(`Generating thumbnail for ${filename}`);
        const { thumbnailPath, videoClipPath } = this.getStorageDirs({ videoClipNameSrc: filename });

        return new Promise<void>((resolve) => {

            const snapshotFfmpeg = spawn(this.ffmpegPath, [
                '-ss', ss,
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
        const { tmpClipPath } = this.getStorageDirs({});

        // const transcodeToH264 = this.codec !== 'h264';
        const transcodeToH264 = true;
        this.saveFfmpegProcess = spawn(this.ffmpegPath, [
            '-rtsp_transport', 'tcp',
            '-i', this.rtspUrl,
            '-c:v', transcodeToH264 ? 'libx264' : 'copy',
            ...(transcodeToH264 ? ['-preset', 'veryfast', '-crf', '23'] : []),
            '-movflags', '+faststart',
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
                    endTime: this.lastClipRecordedTime ?? Date.now(),
                    logger,
                    startTime: this.recordingTimeStart,
                });
                const { videoClipPath } = this.getStorageDirs({ videoClipNameSrc: filename });
                await fs.promises.rename(tmpClipPath, videoClipPath);
                logger.log(`Videoclip stored ${videoClipPath}`);
                await this.saveThumbnail(filename);
                this.classesDetected = [];
                this.saveRecordingListener && clearTimeout(this.saveRecordingListener);
                this.storageSettings.values.processPid = undefined;

                await this.indexFs();
            }
        });
    }

    async stopSaveViddeoClip() {
        const logger = this.getLogger();
        logger.log('Stopping videoclip');

        const endTime = Date.now();
        this.lastClipRecordedTime = endTime;

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
                logger.debug(`Extending recording: ${JSON.stringify({
                    currentDuration,
                    clipDuration,
                    maxLength,
                    triggers
                })}`);

                this.restartTimeout();
            }
        }
    }

    async storeEvent(details: EventDetails, data: ObjectsDetected) {
        const logger = this.getLogger();

        if (data.detectionId) {
            try {
                const mo = await this.cameraDevice.getDetectionInput(data.detectionId);

                if (!mo) {
                    return;
                }

                const eventTimestamp = data.timestamp ?? Date.now();
                const { dayEventsPath, eventsJsonPath, eventImagePath } = this.getStorageDirs({ eventTimestamp })

                try {
                    await fs.promises.access(dayEventsPath);
                } catch {
                    await fs.promises.mkdir(dayEventsPath, { recursive: true });
                }
                let jsonContent: RecordedEvent[] = [];

                if (fs.existsSync(eventsJsonPath)) {
                    const content = await fs.promises.readFile(eventsJsonPath, "utf-8")
                    try {
                        jsonContent = JSON.parse(content)
                    } catch (e) { }
                }

                const newEvent: RecordedEvent = {
                    data, details: {
                        ...details,
                        mixinId: this.plugin.id
                    }
                };
                jsonContent.push(newEvent);

                const jpeg = await sdk.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg');


                logger.log(`Storing image ${eventImagePath}`);
                await fs.promises.writeFile(eventImagePath, jpeg);

                logger.log(`Updating JSON ${eventsJsonPath}`);
                await fs.promises.writeFile(eventsJsonPath, JSON.stringify(jsonContent));

                this.recordedEvents.push(newEvent);
            } catch (e) {
                logger.error(`Error storing detection image ${data.detectionId}`, e);
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

            const classesMap = new Set<string>();
            logger.log(`Starting listener of ${ScryptedInterface.ObjectDetector}`);
            this.detectionListener = systemManager.listenDevice(this.id, ScryptedInterface.ObjectDetector, async (_, details, data: ObjectsDetected) => {
                this.storeEvent(details, data).catch(logger.error);

                const filtered = data.detections.filter(det => {
                    const classname = detectionClassesDefaultMap[det.className];

                    if (ignoreCameraDetections && !det.boundingBox) {
                        return false;
                    }

                    if (det.movement && !det.movement.moving) {
                        return false;
                    }

                    const thresholdValid = scoreThreshold ? det.score >= scoreThreshold : true;
                    const classnameValid = classname && objectDetectionClasses.includes(classname);
                    if (classnameValid && thresholdValid) {
                        classesMap.add(classname);
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

                const classes = Array.from(classesMap);
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
        const thumbnailUrl = `${endpoint}videoclipThumbnail?params=${JSON.stringify(params)}&${parameters}`;

        return { videoclipUrl, thumbnailUrl };
    }

    getStorageDirs(props: { videoClipNameSrc?: string, eventTimestamp?: number }) {
        const { videoClipNameSrc, eventTimestamp } = props;
        const { storagePath } = this.plugin.storageSettings.values;
        if (!storagePath) {
            throw new Error('Storage path not defined on the plugin');
        }
        const date = eventTimestamp ? new Date(eventTimestamp) : undefined;
        const dayStr = date ? moment(date).format('YYYYMMDD') : undefined;

        const deviceFolder = path.join(storagePath, this.cameraDevice.id);
        const videoClipsFolder = path.join(deviceFolder, 'videoclips');
        const thumbnailsFolder = path.join(deviceFolder, 'thumbnails');
        const eventsFolder = path.join(deviceFolder, 'events');

        const filename = videoClipNameSrc?.split('.')?.[0] ?? videoClipNameSrc;
        const filenameWithVideoExtension = `${filename}.mp4`;
        const filenameWithImageExtension = `${filename}.jpg`;
        const videoClipPath = filename ? path.join(videoClipsFolder, `${filenameWithVideoExtension}`) : undefined;
        const thumbnailPath = filename ? path.join(thumbnailsFolder, `${filenameWithImageExtension}`) : undefined;

        const dayEventsPath = dayStr ? path.join(eventsFolder, dayStr) : undefined;
        const eventsJsonPath = dayEventsPath ? path.join(dayEventsPath, `events.json`) : undefined;
        const eventImagePath = dayEventsPath ? path.join(dayEventsPath, `${eventTimestamp}.jpg`) : undefined;

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
            eventsFolder,
            dayEventsPath,
            eventsJsonPath,
            eventImagePath,
        }
    }
}
