import { createRandomId } from './randomId.mjs';
import { apiPath } from './apiClient';

export type LocalSaveDirectory = { id: string; name: string; path: string };

export const supportsLocalSaveDirectory = () => import.meta.env.DEV
    && ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
    && window.location.port === '3004';

async function request(endpoint: string, init: RequestInit = {}) {
    const key = 'canvas-save-client-v1';
    let owner = localStorage.getItem(key);
    if (!owner || !/^[0-9a-f-]{36}$/.test(owner)) {
        owner = createRandomId();
        localStorage.setItem(key, owner);
    }
    const response = await fetch(apiPath('/api/local-save' + endpoint), {
        ...init,
        signal: AbortSignal.timeout(endpoint === '/directory' && init.method === 'POST' ? 130_000 : 30_000),
        headers: { 'x-canvas-save-client': owner, ...init.headers },
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || '本机文件夹服务不可用。');
    return payload;
}

export const readLocalSaveDirectory = async (): Promise<{ available: boolean; directory: LocalSaveDirectory | null }> => request('/directory');
export const chooseLocalSaveDirectory = async (): Promise<{ cancelled?: boolean; directory?: LocalSaveDirectory }> => request('/directory', { method: 'POST' });
export const writeLocalSaveImage = async (directoryId: string, filename: string, blob: Blob) => {
    await request('/image?filename=' + encodeURIComponent(filename), {
        method: 'POST', body: blob,
        headers: { 'content-type': blob.type || 'image/png', 'x-canvas-save-directory': directoryId },
    });
};
