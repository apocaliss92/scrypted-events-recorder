import sdk, { Camera, EventListenerRegister, MediaObject, ObjectsDetected, ScryptedDevice, ScryptedDeviceBase, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, VideoCamera, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions, VideoFrame, VideoFrameGenerator, WritableDeviceState } from '@scrypted/sdk';
import { SettingsMixinDeviceBase } from "@scrypted/common/src/settings-mixin";
import { StorageSettings } from "@scrypted/sdk/storage-settings";
import ObjectDetectionPlugin from './main';
import path from 'path';
import fs from 'fs';
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

const defaultClasses = [
    DetectionClass.Motion,
    DetectionClass.Person,
    DetectionClass.Vehicle,
    DetectionClass.Animal,
    DetectionClass.Face,
    DetectionClass.Plate,
    DetectionClass.Package,
]


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

    recording = false;
    saveRecordingListener: NodeJS.Timeout;
    recordingTimeStart: number;
    eventSegment: number;
    currentSegment: number;
    saveSegment: number;
    classesDetected: string[] = [];

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

        const logger = this.getLogger();
        this.cameraDevice = systemManager.getDeviceById<DeviceType>(this.id);
        setTimeout(async () => {
            try {
                if (!this.killed) {
                    try {
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
    }) {
        const { skipMainLoop, skipDetectionListener } = props;
        const logger = this.getLogger();
        this.running = false;

        if (!skipMainLoop) {
            this.mainLoopListener && clearInterval(this.mainLoopListener);
            this.mainLoopListener = undefined;
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
                }
            } catch (e) {
                logger.log('Error in startCheckInterval', e);
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

            process.on('exit', this.stopCapture);
            process.on('SIGINT', this.stopCapture);
            process.on('SIGTERM', this.stopCapture);
            process.on('uncaughtException', this.stopCapture);
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

        const tmpClipFilename = 'tmp_clip.mp4';

        return {
            deviceFolder,
            tmpFolder,
            videoClipsFolder,
            thumbnailsFolder,
            videoClipPath,
            thumbnailPath,
            tmpClipFilename
        }
    }
}