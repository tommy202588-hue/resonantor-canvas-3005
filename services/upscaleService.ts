import { createRandomId } from './randomId.mjs';
import { apiPath } from './apiClient';
import { getSessionVersion, reportLoginRequired } from './sessionEvents.mjs';

export type UpscaleOptions = { mode: 'faithful'; scale: 2 | 4 } | { mode: 'remove-background'; scale: 1 };

export interface UpscaleRuntime {
    running: boolean;
    starting: boolean;
    startSupported?: boolean;
    gpuServer?: { id: string; name: string; kind: 'local' | 'remote'; managed: boolean };
    faithfulReady: boolean;
    missingFaithful: string[];
    backgroundReady: boolean;
    missingBackground: string[];
    imageProcessorReady?: boolean;
    imageProcessorError?: string;
    backgroundError?: { code: string; message: string };
    error?: { code: string; message: string };
}

export interface UpscaleJob {
    id: string;
    engine?: string;
    seed?: number;
    gpuServer?: { id: string; name: string; kind: 'local' | 'remote'; managed: boolean };
    state: 'preparing' | 'submitting' | 'queued' | 'running' | 'success' | 'error' | 'cancelled';
    options: Omit<UpscaleOptions, 'mode'> & { mode: 'faithful' | 'creative' | 'remove-background' };
    download?: { path?: string; filename?: string; error?: string };
    dimensions?: { width: number; height: number; outputWidth: number; outputHeight: number };
    createdAt: number;
    finishedAt?: number;
    warning?: string;
    error?: { code: string; message: string };
}

export const UPSCALE_STAGES: Record<string, string> = {
    preparing: '准备图片', submitting: '提交任务', queued: '排队中', running: '处理中',
    success: '已完成', error: '失败', cancelled: '已取消', reconnecting: '等待连接恢复',
};

export const imageTaskLabel = (mode?: string) => mode === 'remove-background' ? '去背景' : '高清放大';

function clientId() {
    const key = 'canvas-upscale-client-v1';
    let value = localStorage.getItem(key);
    if (!value || !/^[0-9a-f-]{36}$/.test(value)) {
        value = createRandomId();
        localStorage.setItem(key, value);
    }
    return value;
}

async function request(path: string, init: RequestInit = {}) {
    const requestVersion = getSessionVersion();
    const response = await fetch(apiPath('/api/upscale' + path), {
        ...init,
        credentials: 'same-origin',
        headers: { 'x-upscale-client': clientId(), ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
    if (!response.ok) {
        const payload = await response.json().catch(() => null);
        reportLoginRequired(response.status, payload, requestVersion);
        const error = new Error(payload?.error?.message || (response.status === 404
            ? '发布服务缺少图像处理接口，请管理员更新并重启画布服务。'
            : '图像处理服务不可用（' + response.status + '）。')) as Error & { status: number };
        error.status = response.status;
        throw error;
    }
    return response;
}

export const getUpscaleRuntime = async (): Promise<UpscaleRuntime> => (await request('/runtime', { signal: AbortSignal.timeout(35_000) })).json();
export const startUpscaleRuntime = async (): Promise<UpscaleRuntime> => (await request('/runtime/start', { method: 'POST', signal: AbortSignal.timeout(155_000) })).json();
export const getUpscaleJob = async (id: string, signal?: AbortSignal): Promise<UpscaleJob> => (await request('/jobs/' + id, { signal })).json();
export const cancelUpscaleJob = async (id: string): Promise<UpscaleJob> => (await request('/jobs/' + id + '/cancel', { method: 'POST', signal: AbortSignal.timeout(65_000) })).json();
export const getUpscaleImage = async (id: string, signal?: AbortSignal) => (await request('/jobs/' + id + '/image', { signal })).blob();

export function upscaleSizeError(width: number, height: number, scale: number, mode: UpscaleOptions['mode'] = 'faithful') {
    if (!width || !height) return '正在读取图片尺寸…';
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) return '图片尺寸无效。';
    if (mode === 'remove-background' ? scale !== 1 : mode !== 'faithful' || ![2, 4].includes(scale)) return '处理模式或倍率无效。';
    if (![width * scale, height * scale, width * height * scale * scale].every(Number.isSafeInteger)) return '图片尺寸无效。';
    return '';
}

export async function readUpscaleSource(source: Blob | string) {
    let blob: Blob;
    if (source instanceof Blob) blob = source;
    else {
        const response = await fetch(source);
        if (!response.ok) throw new Error('原图读取失败，请重新上传后再试。');
        blob = await response.blob();
    }
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return { blob, ...size };
}

export async function upscaleLocally(source: Blob | string, scale: 2 | 4) {
    const image = await readUpscaleSource(source);
    const canvas = document.createElement('canvas');
    canvas.width = image.width * scale;
    canvas.height = image.height * scale;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法创建高清放大画布。');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    const bitmap = await createImageBitmap(image.blob, { imageOrientation: 'from-image' });
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('高清图片导出失败。')), 'image/png', 1));
    return { blob, width: canvas.width, height: canvas.height };
}

export async function submitUpscaleJob(id: string, source: Blob, options: UpscaleOptions): Promise<UpscaleJob> {
    const query = new URLSearchParams({ jobId: id, mode: options.mode, scale: String(options.scale) });
    return (await request('/jobs?' + query, {
        method: 'POST', body: source, headers: { 'content-type': 'application/octet-stream' }, signal: AbortSignal.timeout(300_000),
    })).json();
}
