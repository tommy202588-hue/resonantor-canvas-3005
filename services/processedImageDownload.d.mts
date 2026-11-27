export interface ImageSaveResult {
    browserState: 'saved' | 'requested';
    browserMessage: string;
}
export function downloadImageBlob(blob: Blob, filename: string): void;
export function saveImageToUserComputer<Directory extends { name: string; __download?: boolean }>(
    blob: Blob,
    filename: string,
    directory: Directory | null,
    options: {
        checkPermission: (directory: Directory, request: boolean) => Promise<boolean>;
        writeFile: (directory: Directory, filename: string, blob: Blob) => Promise<void>;
        download?: (blob: Blob, filename: string) => void | Promise<void>;
    }
): Promise<ImageSaveResult>;
export function deliverProcessedImageOnce(
    taskId: string,
    save: () => Promise<ImageSaveResult>,
    storage?: Pick<Storage, 'getItem' | 'setItem'>
): Promise<ImageSaveResult | { browserState: 'failed'; browserMessage: string }>;
