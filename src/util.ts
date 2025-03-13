import { ChildProcessWithoutNullStreams } from "child_process";
import { DetectionClass } from "../../scrypted-advanced-notifier/src/detecionClasses";
import { Camera, ScryptedDevice, ScryptedDeviceBase, Settings, VideoCamera } from "@scrypted/sdk";

export type DeviceType = VideoCamera & Camera & Settings & ScryptedDeviceBase & ScryptedDevice;

export const detectionClassIndex = {
    [DetectionClass.Motion]: 0,
    [DetectionClass.Person]: 1,
    [DetectionClass.Vehicle]: 2,
    [DetectionClass.Animal]: 3,
    [DetectionClass.Face]: 4,
    [DetectionClass.Plate]: 5,
    [DetectionClass.Package]: 6,
}
export const detectionClassIndexReversed = Object.entries(detectionClassIndex)
    .reduce((tot, [detectionClass, index]) => ({ ...tot, [index]: detectionClass }), {});

export const defaultClasses = [
    DetectionClass.Person,
    DetectionClass.Vehicle,
    DetectionClass.Animal,
    DetectionClass.Face,
    DetectionClass.Plate,
    DetectionClass.Package,
]

export const getMainDetectionClass = (detectionClasses: DetectionClass[]) => {
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

export interface VideoclipFileData {
    filename: string;
    videoClipPath: string;
    thumbnailPath: string;
    startTime: number;
    endTime: number;
    size: number;
    detectionClasses: DetectionClass[];
}

export const cleanupMemoryThresholderInGb = 10;
export const clipsToCleanup = 10;
export const videoClipRegex = new RegExp('(.*)_(.*)_(.*).mp4');

export const attachProcessEvents = (props: {
    logger: Console,
    processName: string,
    childProcess: ChildProcessWithoutNullStreams,
    onClose?: () => Promise<void>
}) => {
    const { processName, childProcess, onClose, logger } = props;

    childProcess.stdout.on('data', (data) => {
        logger.debug(`${processName} stdout: ${data.toString()}`);
    });

    childProcess.stderr.on('data', (data) => {
        logger.debug(`${processName} stderr: ${data.toString()}`);
    });

    childProcess.on('close', async (data) => {
        logger.log(`Process ${processName} closed: ${data}`);
        onClose && (onClose().catch(logger.log));
    });
}

export const getVideoClipName = (props: {
    startTime: number,
    endTime: number,
    logger: Console,
    classesDetected: string[]
}) => {
    const { startTime, classesDetected, endTime, logger } = props;
    const detectionsHashComponents = new Array(10).fill(0);
    Object.entries(detectionClassIndex).forEach(([detectionClass, index]) => {
        if (classesDetected.includes(detectionClass) || detectionClass === DetectionClass.Motion) {
            detectionsHashComponents[index] = 1;
        }
    });
    const detectionsHash = detectionsHashComponents.join('');
    const filename = `${startTime}_${endTime}_${detectionsHash}`;

    logger.log(`Filename calculated: ${JSON.stringify({
        filename,
        detectionsHashComponents,
        classesDetected,
        allClasses: Object.entries(detectionClassIndex),
        detectionsHash
    })}`)

    return filename;
}
