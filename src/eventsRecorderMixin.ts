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
    streamFps: number;
    mainLoopListener: NodeJS.Timeout;
    detectionListener: EventListenerRegister;
    logger: Console;
    prebufferFfmpegProcess: ChildProcessWithoutNullStreams;
    currentRecordingProcess: ChildProcessWithoutNullStreams;
    running = false;
    forceClosedCapture = false;
    lastRunStart: number;
    frameBuffer: any[] = [];
    ffmpegPath: string;
    recording = false;
    recordingTimeStart: number;
    postEventFrames: number;
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

    async detectFPS(rtspUrl: string) {
        const logger = this.getLogger();
        return new Promise<number>((resolve, reject) => {
            const ffmpeg = spawn(this.ffmpegPath, [
                '-i', rtspUrl,
                '-t', '5',
                '-filter:v',
                '-f', 'null',
                '-'
            ]);

            let output = '';

            ffmpeg.stderr.on('data', (data) => {
                output += data.toString();
            });

            ffmpeg.on('close', (code) => {
                try {
                    const fpsMatch = output.match(/(\d+\.?\d*) fps/);
                    if (fpsMatch) {
                        resolve(parseFloat(fpsMatch[1]));
                    } else {
                        reject(new Error('Could not determine FPS'));
                    }
                } catch (error) {
                    reject(error);
                }
            });

            ffmpeg.on('error', reject);
        });
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

        if (this.prebufferFfmpegProcess && !this.prebufferFfmpegProcess.killed) {
            await new Promise<void>((resolve, reject) => {
                try {
                    this.prebufferFfmpegProcess.kill('SIGTERM');

                    const forceKillTimeout = setTimeout(() => {
                        this.prebufferFfmpegProcess.kill('SIGKILL');
                        resolve();
                    }, 5000);

                    this.prebufferFfmpegProcess.on('exit', () => {
                        clearTimeout(forceKillTimeout);
                        resolve();
                    });
                } catch (error) {
                    logger.log('Error stopping FFmpeg:', error);
                    reject();
                }
            });
        }
    }

    cleanupTmpFiles() {
        const { tmpFolder } = this.getStorageDirs();
        if (fs.existsSync(tmpFolder)) {
            fs.rmSync(tmpFolder, { recursive: true, force: true });
        }
    }

    async init() {
        const logger = this.getLogger();
        this.ffmpegPath = await sdk.mediaManager.getFFmpegPath();

        const { highQualityVideoclips } = this.storageSettings.values;
        const destination = highQualityVideoclips ? 'local-recorder' : 'remote-recorder';

        const streamConfigs = await this.cameraDevice.getVideoStreamOptions();
        const streamConfig = streamConfigs.find(config => config.destinations.includes(destination));
        const streamName = streamConfig.name;
        const deviceSettings = await this.cameraDevice.getSettings();
        const rebroadcastConfig = deviceSettings.find(setting => setting.subgroup === `Stream: ${streamName}` && setting.title === 'RTSP Rebroadcast Url');
        this.rtspUrl = rebroadcastConfig?.value as string;

        try {
            this.streamFps = await this.detectFPS(this.rtspUrl);
        } catch (e) {
            logger.log(`Error while probing FPS`, e);
        }

        logger.log(`Rebroadcast URL found: ${JSON.stringify({
            url: this.rtspUrl,
            fps: this.streamFps,
            streamName,
            streamConfig,
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
            fs.mkdirSync(tmpFolder, { recursive: true });
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
                    const shouldRestartCapture = (this.lastRunStart && (Date.now() - this.lastRunStart)) >= 1000 * 60 * 5;


                    if (shouldRestartCapture && this.prebufferFfmpegProcess) {
                        logger.log(`Restarting capture process. ${JSON.stringify({ shouldRestartCapture })}`);
                        await this.resetListeners({ skipDetectionListener: true, skipMainLoop: true });
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

    async writeFrame(frame) {
        this.currentRecordingProcess.stdin.write(frame);
    }

    finishRecording() {
        const logger = this.getLogger();
        // const filename = this.getVideoClipName(endTime);
        // const outputFile = path.join(videoClipsFolder, `${filename}.mp4`);
        this.recording = false;
        this.currentRecordingProcess.stdin.end();
        this.currentRecordingProcess = null;

        logger.log('Stopping videoclip recording');
    }

    async triggerMotionRecording() {
        const logger = this.getLogger();
        try {
            const { postEventSeconds, maxLength } = this.storageSettings.values;
            const now = Date.now();
            const currentDuration = now - this.recordingTimeStart;

            if (this.recording && (currentDuration < (maxLength * 1000))) {
                logger.log('Extending recording');
                this.postEventFrames = 0;
                return;
            }

            logger.log('Starting videoclip recording');

            const { videoClipsFolder } = this.getStorageDirs();

            this.recording = true;
            this.postEventFrames = 0;
            this.recordingTimeStart = now;

            const outputFile = path.join(videoClipsFolder, `tmp_clip.mp4`);

            this.currentRecordingProcess = spawn(this.ffmpegPath, [
                '-rtsp_transport', 'tcp',
                '-ss', '-5',
                '-i', this.rtspUrl,
                // '-pix_fmt', 'yuv420p',
                '-t', '15',
                '-c:v', 'copy',
                outputFile
            ]);

            this.currentRecordingProcess.stderr.on('data', (data) => {
                logger.log('Recording stderr: ', data.toString());
            });

            this.currentRecordingProcess.stdout.on('data', (data) => {
                logger.log('Recording stdout:', data.toString());
            });

            this.currentRecordingProcess.on('error', (err) => {
                logger.log('FFmpeg process error:', err);
                // this.finishRecording();
            });

            // this.currentRecordingProcess.stdout.on('exit', (code, signal) => {
            //     if (code !== 0) {
            //         logger.log(`FFmpeg exited with code ${code}, signal: ${signal}`);
            //         this.forceClosedCapture = true;
            //     }
            // });

            // try {
            //     for (const frame of this.frameBuffer) {
            //         await this.writeFrame(frame);
            //     }
            // } catch (err) {
            //     console.error('Error processing frames:', err);
            //     this.finishRecording();
            // }
        } catch (e) {
            logger.log('Error in triggerMotionRecording', e);
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

        logger.debug(`Filename calculated: ${JSON.stringify({
            filename,
            detectionsHashComponents,
            classesDetected: this.classesDetected,
            allClasses: Object.entries(detectionClassIndex),
            detectionsHash
        })}`)

        return filename;
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

    async startCapture() {
        const logger = this.getLogger();

        const { preEventSeconds, postEventSeconds } = this.storageSettings.values;
        logger.log(`Starting prebuffer capture`);
        try {
            this.prebufferFfmpegProcess = spawn(this.ffmpegPath, [
                '-rtsp_transport', 'tcp',
                '-i', this.rtspUrl,
                '-f', 'image2pipe',
                '-pix_fmt', 'yuv420p',
                '-vcodec', 'rawvideo',
                '-'
            ], {
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: false
            });
            this.storageSettings.values.processPid = this.prebufferFfmpegProcess.pid;

            this.prebufferFfmpegProcess.stdout.on('data', async (data) => {
                this.frameBuffer.push(data);
                if (this.frameBuffer.length > preEventSeconds * this.streamFps) {
                    this.frameBuffer.shift();
                }

                // if (this.recording) {
                //     const maxPostEventFrames = postEventSeconds * this.streamFps;
                //     try {
                //         await this.writeFrame(data);
                //         this.postEventFrames++;
                //         logger.log(`Current frames: ${JSON.stringify({
                //             postEventFramse: this.postEventFrames,
                //             streamFps: this.streamFps,
                //             maxPostEventFrames,
                //         })}`);

                //         if (this.postEventFrames >= maxPostEventFrames) {
                //             this.finishRecording();
                //         }
                //     } catch (err) {
                //         console.error('Error writing frame:', err);
                //         this.finishRecording();
                //     }
                // }
            });


            this.prebufferFfmpegProcess.stderr.on('data', (data) => {
                const output = data.toString();

                if (output.includes('Error') || output.includes('error')) {
                    logger.debug('FFmpeg error:', output);
                }
            });

            this.prebufferFfmpegProcess.on('error', (error) => {
                logger.log('FFmpeg error:', error);
            });

            this.prebufferFfmpegProcess.stdout.on('data', (data) => {
                logger.debug('Capture stdout:', data.toString());
            });

            this.prebufferFfmpegProcess.stdout.on('exit', (code, signal) => {
                if (code !== 0) {
                    logger.log(`FFmpeg exited with code ${code}, signal: ${signal}`);
                    this.forceClosedCapture = true;
                }
            });

            const killFFmpeg = () => {
                try {
                    process.kill(this.prebufferFfmpegProcess.pid, 'SIGTERM');
                } catch (e) { }
            };

            process.on('exit', killFFmpeg);
            process.on('SIGINT', killFFmpeg);
            process.on('SIGTERM', killFFmpeg);
            process.on('uncaughtException', killFFmpeg);
        } catch (e) {
            logger.log('Error in startCapture', e);
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