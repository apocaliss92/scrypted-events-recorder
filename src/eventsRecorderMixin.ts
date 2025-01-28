import sdk, { Camera, EventListenerRegister, MediaObject, ObjectsDetected, ScryptedDevice, ScryptedDeviceBase, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, VideoCamera, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions, VideoFrame, VideoFrameGenerator, WritableDeviceState } from '@scrypted/sdk';
import { SettingsMixinDeviceBase } from "@scrypted/common/src/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import ObjectDetectionPlugin from './main';
import path from 'path';
import fs from 'fs';
import url from 'url';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { uniq } from 'lodash';
import { DetectionClass, detectionClassesDefaultMap } from '../../scrypted-advanced-notifier/src/detecionClasses';
import { sleep } from '@scrypted/common/src/sleep';

const { systemManager } = sdk;

type DeviceType = VideoCamera & Camera & Settings & ScryptedDeviceBase & ScryptedDevice;

const detectionClassIndex = {
    [DetectionClass.Motion]: 0,
    [DetectionClass.Person]: 1,
    [DetectionClass.Vehicle]: 2,
    [DetectionClass.Animal]: 3,
    [DetectionClass.Face]: 4,
    [DetectionClass.Plate]: 5,
    [DetectionClass.Package]: 6,
}
const detectionClassIndexReversed = Object.entries(detectionClassIndex)
    .reduce((tot, [detectionClass, index]) => ({ ...tot, [index]: detectionClass }), {});

const defaultClasses = [
    DetectionClass.Person,
    DetectionClass.Vehicle,
    DetectionClass.Animal,
    DetectionClass.Face,
    DetectionClass.Plate,
    DetectionClass.Package,
]

const getMainDetectionClass = (detectionClasses: DetectionClass[]) => {
    if (detectionClasses.includes(DetectionClass.Face)) {
        return DetectionClass.Face;
    }
    if (detectionClasses.includes(DetectionClass.Plate)) {
        return DetectionClass.Plate;
    }
    if (detectionClasses.includes(DetectionClass.Package)) {
        return DetectionClass.Package;
    }
    if (detectionClasses.includes(DetectionClass.Person)) {
        return DetectionClass.Person;
    }
    if (detectionClasses.includes(DetectionClass.Animal)) {
        return DetectionClass.Animal;
    }
    if (detectionClasses.includes(DetectionClass.Vehicle)) {
        return DetectionClass.Vehicle;
    }
    if (detectionClasses.includes(DetectionClass.Motion)) {
        return DetectionClass.Motion;
    }
}

interface VideoclipFileData {
    filename: string;
    videoClipPath: string;
    thumbnailPath: string;
    startTime: number;
    endTime: number;
    size: number;
    detectionClasses: DetectionClass[];
}

const cleanupMemoryThresholderInGb = 10;
const clipsToCleanup = 10;
const videoClipRegex = new RegExp('(.*)_(.*)_(.*).mp4');

export class EventsRecorderMixin extends SettingsMixinDeviceBase<DeviceType> implements Settings, VideoClips {
    cameraDevice: DeviceType;
    killed: boolean;
    rtspUrl: string;
    mainLoopListener: NodeJS.Timeout;
    detectionListener: EventListenerRegister;
    logger: Console;
    segmentsListener: NodeJS.Timeout;
    segmentsFfmpegProcess: ChildProcessWithoutNullStreams;
    videoSegments: string[] = [];
    running = false;
    forceClosedCapture = false;
    lastRunStart: number;
    lastExtendLogged: number;
    ffmpegPath: string;
    shouldIndexFs = false;
    lastIndexFs;

    recording = false;
    saveRecordingListener: NodeJS.Timeout;
    recordingTimeStart: number;
    eventSegment: number;
    currentSegment: number;
    saveSegment: number;
    classesDetected: string[] = [];

    scanData: VideoclipFileData[] = [];
    scanFsListener: NodeJS.Timeout;

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
            defaultValue: 5,
        },
        postEventSeconds: {
            title: 'Post event seconds',
            description: 'Seconds to keep after an event occurs.',
            type: 'number',
            defaultValue: 15,
        },
        maxLength: {
            title: 'Max length in seconds',
            type: 'number',
            defaultValue: 60,
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
            defaultValue: defaultClasses
        },
        maxSpaceInGb: {
            title: 'Dedicated memory in GB',
            type: 'number',
            defaultValue: 250,
            onPut: async () => this.storageSettings.settings.occupiedSpaceInGb.range = [0, this.storageSettings.values.maxSpaceInGb]
        },
        occupiedSpaceInGb: {
            title: 'Memory occupancy in GB',
            type: 'number',
            range: [0, 250],
            readonly: true,
            placeholder: 'GB'
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


        this.plugin.currentMixins[this.id] = this;
        const logger = this.getLogger();
        this.cameraDevice = systemManager.getDeviceById<DeviceType>(this.id);
        setTimeout(async () => {
            try {
                if (!this.killed) {
                    try {
                        process.on('exit', this.stopCapture);
                        process.on('SIGINT', this.stopCapture);
                        process.on('SIGTERM', this.stopCapture);
                        process.on('uncaughtException', this.stopCapture);

                        this.ffmpegPath = await sdk.mediaManager.getFFmpegPath();
                        const processPid = this.storageSettings.values.processPid;
                        processPid && process.kill(processPid, 'SIGTERM');
                        await sleep(5000);
                    } catch (e) {
                        logger.log('Error killing process', e);
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
    }) {
        const { skipMainLoop, skipDetectionListener } = props;
        const logger = this.getLogger();
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
        }

        await this.stopCapture();

        this.segmentsListener && clearInterval(this.segmentsListener);
        this.segmentsListener = undefined;
    }

    cleanupTmpFiles() {
        const { tmpFolder } = this.getStorageDirs();
        if (fs.existsSync(tmpFolder)) {
            fs.rmSync(tmpFolder, { recursive: true, force: true });
        }
        fs.mkdirSync(tmpFolder, { recursive: true });
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

            this.cleanupTmpFiles();
        } catch (e) {
            logger.log('Error in init', e);
        }
    }

    async startCheckInterval() {
        const logger = this.getLogger();

        const funct = async () => {
            try {
                this.forceClosedCapture = false;
                this.running = true;
                this.lastRunStart = Date.now();
                await this.startCapture();
                await this.startListeners();
                this.watchSegments();
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
                    const shouldRestartCapture = (this.lastRunStart && (Date.now() - this.lastRunStart)) >= 1000 * 60 * 60 * 2;

                    if (shouldRestartCapture && this.segmentsFfmpegProcess) {
                        logger.log(`Restarting capture process. ${JSON.stringify({ shouldRestartCapture })}`);
                        await this.resetListeners({ skipDetectionListener: true, skipMainLoop: true });
                        this.cleanupTmpFiles();
                    }

                    if (!this.running || !this.lastRunStart || this.forceClosedCapture) {
                        await funct();
                    }

                    const now = Date.now();
                    if (this.shouldIndexFs || !this.lastIndexFs || (now - this.lastIndexFs) > (1000 * 60 * 5)) {
                        logger.log(`Indexing FS: ${JSON.stringify({
                            shouldIndexFs: this.shouldIndexFs,
                            lastIndexFs: this.lastIndexFs,
                        })}`);

                        this.indexFs();
                        this.lastIndexFs = now;

                        logger.log(`${this.scanData.length} videoclips found`);
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
        const videoclips: VideoClip[] = [];

        for (const item of this.scanData) {
            const { detectionClasses, endTime, filename, startTime } = item;
            if (startTime >= options.startTime && startTime <= options.endTime) {
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

    async getVideoClip(videoId: string): Promise<MediaObject> {
        const { videoClipPath } = await this.getStorageDirs(videoId);
        this.console.log('Fetching videoId ', videoId, videoClipPath);
        const fileURLToPath = url.pathToFileURL(videoClipPath).toString();
        const videoclipMo = await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);

        return videoclipMo;
    }

    async getVideoClipThumbnail(thumbnailId: string, options?: VideoClipThumbnailOptions): Promise<MediaObject> {
        const { thumbnailPath } = await this.getStorageDirs(thumbnailId);
        this.console.log('Fetching thumbnailId ', thumbnailId, thumbnailPath);
        const fileURLToPath = url.pathToFileURL(thumbnailPath).toString();
        const thumbnailMo = await sdk.mediaManager.createMediaObjectFromUrl(fileURLToPath);

        return thumbnailMo;
    }

    removeVideoClips(...videoClipIds: string[]): Promise<void> {
        this.console.log('Removing videoclips ', videoClipIds.join(', '));
        const logger = this.getLogger();
        for (const videoClipId of videoClipIds) {
            const { videoClipPath, thumbnailPath } = this.getStorageDirs(videoClipId);
            fs.rmSync(videoClipPath);
            logger.log(`Videoclip ${videoClipId} removed`);

            fs.rmSync(thumbnailPath);
            logger.log(`Thumbnail ${thumbnailPath} removed`);
        }

        return;
    }

    async scanFs() {
        const logger = this.getLogger();
        const { deviceFolder, videoClipsFolder } = this.getStorageDirs();
        let occupiedSizeInBytes = 0;

        function calculateSize(currentPath: string) {
            const entries = fs.readdirSync(currentPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);
                if (entry.isDirectory()) {
                    calculateSize(fullPath);
                } else if (entry.isFile()) {
                    const stats = fs.statSync(fullPath);
                    occupiedSizeInBytes += stats.size;
                }
            }
        }

        calculateSize(deviceFolder);
        const occupiedSpaceInGbNumber = (occupiedSizeInBytes / (1024 * 1024 * 1024));
        const occupiedSpaceInGb = occupiedSpaceInGbNumber.toFixed(2);
        this.putMixinSetting('occupiedSpaceInGb', occupiedSpaceInGb);
        logger.log(`Occupied space: ${occupiedSpaceInGb} GB`);

        const freeMemory = this.storageSettings.values.maxSpaceInGb - occupiedSpaceInGbNumber;
        if (freeMemory <= cleanupMemoryThresholderInGb) {
            const files = fs.readdirSync(videoClipsFolder);

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
                fs.rmSync(fullPath);
                logger.log(`Deleted videoclip: ${file}`);
                const { thumbnailPath } = this.getStorageDirs(file);
                fs.rmSync(thumbnailPath);
                logger.log(`Deleted thumbnail: ${thumbnailPath}`);
            }
        }
    }

    indexFs() {
        const { videoClipsFolder } = this.getStorageDirs();
        const filesData: VideoclipFileData[] = [];

        const entries = fs.readdirSync(videoClipsFolder, { withFileTypes: true });
        const filteredEntries = entries.filter(entry => entry.name.endsWith('.mp4'));

        for (const entry of filteredEntries) {
            const { videoClipPath, thumbnailPath, filename } = this.getStorageDirs(entry.name);
            const stats = fs.statSync(videoClipPath);

            const [_, startTime, endTime, detectionsHash] = entry.name.match(videoClipRegex);

            const detectionClasses: DetectionClass[] = [];
            const detectionFlags = detectionsHash.split('');
            detectionFlags.forEach((flag, index) => flag === '1' && detectionClasses.push(detectionClassIndexReversed[index]));

            filesData.push({
                detectionClasses,
                endTime: Number(endTime),
                startTime: Number(startTime),
                size: stats.size,
                filename,
                thumbnailPath,
                videoClipPath
            })
        }

        this.scanData = filesData;
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

    async triggerMotionRecording() {
        if (!this.recording) {
            this.startNewRecording();
        } else {
            const logger = this.getLogger();
            const { postEventSeconds, maxLength } = this.storageSettings.values;
            const currentDuration = Date.now() - this.recordingTimeStart;
            const shouldExtend = currentDuration <= (postEventSeconds * 1000) && currentDuration < (maxLength * 1000);

            logger.debug(`Log extension check: ${JSON.stringify({
                shouldExtend,
                currentDuration,
                postEventSeconds,
                maxLength
            })}`)
            if (shouldExtend) {
                this.extendRecording();
            }
        }
    }

    getVideoClipName(endTime: number) {
        const logger = this.getLogger();
        const detectionsHashComponents = new Array(10).fill(0);
        Object.entries(detectionClassIndex).forEach(([detectionClass, index]) => {
            if (this.classesDetected.includes(detectionClass) || detectionClass === DetectionClass.Motion) {
                detectionsHashComponents[index] = 1;
            }
        });
        const detectionsHash = detectionsHashComponents.join('');
        const filename = `${this.recordingTimeStart}_${endTime}_${detectionsHash}`;

        logger.log(`Filename calculated: ${JSON.stringify({
            filename,
            detectionsHashComponents,
            classesDetected: this.classesDetected,
            allClasses: Object.entries(detectionClassIndex),
            detectionsHash
        })}`)

        return filename;
    }

    async saveThumbnail(filename: string) {
        const logger = this.getLogger();
        return new Promise<void>((resolve) => {
            const { preEventSeconds } = this.storageSettings.values;
            const { thumbnailPath, videoClipPath } = this.getStorageDirs(filename);

            const snapshotFfmpeg = spawn(this.ffmpegPath, [
                '-ss', (preEventSeconds + 1).toString(),
                // '-ss', '00:00:05',
                '-i', `${videoClipPath}`,
                thumbnailPath
            ]);

            snapshotFfmpeg.stdout.on('data', (data) => {
                logger.debug('Snapshot stdout:', data.toString());
            });

            snapshotFfmpeg.stderr.on('data', (data) => {
                logger.debug('Snapshot nstderr:', data.toString());
            });

            snapshotFfmpeg.on('close', () => {
                logger.log(`Snapshot stored ${thumbnailPath}`);
                resolve();
            });
        });
    }

    async saveVideoClip() {
        await this.stopCapture();
        const { preEventSeconds } = this.storageSettings.values;
        const logger = this.getLogger();
        const endTime = Date.now();

        const filename = this.getVideoClipName(endTime);
        const { tmpFolder, videoClipPath } = this.getStorageDirs(filename);

        const allSegments = fs.readdirSync(tmpFolder);
        const segments = allSegments
            .sort((a, b) => {
                const numA = parseInt(a.match(/\d+/)[0]);
                const numB = parseInt(b.match(/\d+/)[0]);
                return numA - numB;
            })
            .filter(segment => {
                const segmentIndex = parseInt(segment.match(/\d+/)[0]);
                const lowOk = this.eventSegment ? segmentIndex >= (this.eventSegment - preEventSeconds) : true;
                const highOk = this.saveSegment ? segmentIndex <= this.saveSegment : true;

                const matches = lowOk && highOk;

                logger.log(`Filtering segment: ${JSON.stringify({
                    segment,
                    segmentIndex,
                    lowOk,
                    highOk,
                    matches,
                })}`);

                return matches;
            })
            .map(file => path.join(tmpFolder, file));

        logger.log(`Saving videoclip. ${JSON.stringify({
            currentSegment: this.currentSegment,
            eventSegment: this.eventSegment,
            saveSegment: this.saveSegment,
            segments: segments.length
        })}`);

        const concatFfmpeg = spawn(this.ffmpegPath, [
            '-i', `concat:${segments.join('|')}`,
            '-c', 'copy',
            videoClipPath
        ]);

        concatFfmpeg.stdout.on('data', (data) => {
            logger.debug('Generation stdout:', data.toString());
        });

        concatFfmpeg.stderr.on('data', (data) => {
            logger.debug('Generatio nstderr:', data.toString());
        });

        concatFfmpeg.on('close', async () => {
            logger.log(`Videoclip stored ${videoClipPath}`);
            await this.saveThumbnail(filename);
            this.recording = false;
            this.saveSegment = undefined;
            this.eventSegment = undefined;
            this.classesDetected = [];
            this.saveRecordingListener && clearTimeout(this.saveRecordingListener);
            this.cleanupTmpFiles();
            await this.startCapture();
            this.shouldIndexFs = true;
            this.lastIndexFs = Date.now();
        });
    }

    restartTimeout() {
        const logger = this.getLogger();
        this.saveRecordingListener && clearTimeout(this.saveRecordingListener);
        this.saveRecordingListener = setTimeout(async () => {
            this.saveSegment = this.currentSegment;
            this.saveVideoClip().catch(logger.log);
        }, this.storageSettings.values.postEventSeconds * 1000);
    }

    async extendRecording() {
        const logger = this.getLogger();
        const now = Date.now();
        if (!this.lastExtendLogged || (now - this.lastExtendLogged > 1000)) {
            this.lastExtendLogged = now;
            logger.log(`Extending recording: ${now}`);
            this.restartTimeout();
        }
    }

    startNewRecording() {
        const logger = this.getLogger();
        this.recordingTimeStart = Date.now();
        this.recording = true;
        this.eventSegment = this.currentSegment;
        logger.log(`Starting new recording: ${JSON.stringify({
            recordingTimeStart: this.recordingTimeStart,
            currentSegment: this.currentSegment,
            eventSegment: this.eventSegment,
        })}`);
        this.restartTimeout();
    }

    async startListeners() {
        const logger = this.getLogger();
        try {
            const { scoreThreshold, detectionClasses } = this.storageSettings.values;
            logger.log(`Starting listener of ${ScryptedInterface.ObjectDetector}`);
            this.detectionListener = systemManager.listenDevice(this.id, ScryptedInterface.ObjectDetector, async (_, __, data: ObjectsDetected) => {
                const filtered = data.detections.filter(det => {
                    const classname = detectionClassesDefaultMap[det.className];

                    return classname && detectionClasses.includes(classname) && det.score >= scoreThreshold;
                });

                if (filtered.length) {
                    const classes = uniq(filtered.map(detect => detect.className));
                    this.classesDetected.push(...classes);
                    this.triggerMotionRecording().catch(logger.log);
                }
            });
        } catch (e) {
            logger.log('Error in startListeners', e);
        }
    }

    async stopCapture() {
        const logger = this.getLogger();
        if (this.segmentsFfmpegProcess && !this.segmentsFfmpegProcess.killed) {
            await new Promise<void>((resolve, reject) => {
                try {
                    this.segmentsFfmpegProcess.kill('SIGTERM');

                    const forceKillTimeout = setTimeout(() => {
                        this.segmentsFfmpegProcess.kill('SIGKILL');
                        resolve();
                    }, 5000);

                    this.segmentsFfmpegProcess.on('exit', () => {
                        clearTimeout(forceKillTimeout);
                        resolve();
                    });
                } catch (error) {
                    logger.log('Error stopping FFmpeg:', error);
                    reject();
                }
            });
        }
        try {
            process.kill(this.segmentsFfmpegProcess.pid, 'SIGTERM');
        } catch (e) { }
    }

    async startCapture() {
        const logger = this.getLogger();

        const { tmpFolder } = this.getStorageDirs();
        logger.log(`Starting prebuffer capture in folder${tmpFolder}`);
        try {
            this.segmentsFfmpegProcess = spawn(this.ffmpegPath, [
                '-rtsp_transport', 'tcp',
                '-i', this.rtspUrl,
                '-c:v', 'libx264',
                '-f', 'segment',
                '-segment_time', '1',
                '-segment_format', 'mpegts',
                '-reset_timestamps', '1',
                '-force_key_frames', 'expr:gte(t,n_forced*1)',
                `${tmpFolder}/segment%03d.ts`,
            ], {
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: false
            });
            this.storageSettings.values.processPid = this.segmentsFfmpegProcess.pid;

            this.segmentsFfmpegProcess.stderr.on('data', (data) => {
                const output = data.toString();

                if (output.includes('Error') || output.includes('error')) {
                    logger.debug('FFmpeg error:', output);
                }

                const match = output.match(/Opening '(.+?)' for writing/);
                if (match) {
                    const lastSegment = match[1]; // Nome completo del segmento
                    const segmentNumber = lastSegment.match(/segment(\d+)\.ts/)[1];
                    this.currentSegment = parseInt(segmentNumber);
                }
            });

            this.segmentsFfmpegProcess.on('error', (error) => {
                logger.log('FFmpeg error:', error);
            });

            this.segmentsFfmpegProcess.stdout.on('data', (data) => {
                logger.log('Capture stdout:', data.toString());
            });

            this.segmentsFfmpegProcess.stdout.on('exit', (code, signal) => {
                if (code !== 0) {
                    logger.log(`FFmpeg exited with code ${code}, signal: ${signal}`);
                    this.forceClosedCapture = true;
                }
            });

        } catch (e) {
            logger.log('Error in startCapture', e);
        }
    }

    watchSegments() {
        const logger = this.getLogger();
        logger.log('Starting segments watcher');
        const { tmpFolder } = this.getStorageDirs();

        this.segmentsListener = setInterval(async () => {
            try {
                if (!fs.existsSync(tmpFolder)) {
                    return;
                }

                const { maxLength } = this.storageSettings.values;
                const segmentsToKeep = maxLength * 2;
                const files = fs.readdirSync(tmpFolder)
                    .filter(file => {
                        const fullPath = path.join(tmpFolder, file);
                        return fs.statSync(fullPath).isFile();
                    }).sort((a, b) => {
                        return fs.statSync(path.join(tmpFolder, b)).mtime.getTime() -
                            fs.statSync(path.join(tmpFolder, a)).mtime.getTime();
                    });

                if (files.length > segmentsToKeep) {
                    const filesToRemove = files.slice(segmentsToKeep);

                    filesToRemove.forEach(file => {
                        const fullPath = path.join(tmpFolder, file);
                        try {
                            fs.unlinkSync(fullPath);
                        } catch (error) {
                            logger.log(`Error in removing segment: ${file}`);
                        }
                    });
                }

            } catch (err) {
                logger.log(`Segment management error: ${err.message}`, 'error');
            }
        }, 10000);
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
        const tmpFolder = path.join(deviceFolder, 'tmp');
        const videoClipsFolder = path.join(deviceFolder, 'videoclips');
        const thumbnailsFolder = path.join(deviceFolder, 'thumbnails');

        const filename = videoClipNameSrc?.split('.')?.[0] ?? videoClipNameSrc;
        const videoClipPath = filename ? path.join(videoClipsFolder, `${filename}.mp4`) : undefined;
        const thumbnailPath = filename ? path.join(thumbnailsFolder, `${filename}.jpg`) : undefined;

        const tmpClipFilename = 'tmp_clip.mp4';

        return {
            deviceFolder,
            tmpFolder,
            videoClipsFolder,
            thumbnailsFolder,
            videoClipPath,
            thumbnailPath,
            tmpClipFilename,
            filename
        }
    }
}