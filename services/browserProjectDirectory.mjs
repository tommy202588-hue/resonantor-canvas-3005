import { createBrowserProjectDirectoryStore, directoryError, PROJECT_DIRECTORY_NAME } from './browserProjectDirectoryStore.mjs';
import { createRandomId } from './randomId.mjs';
import { createBrowserProjectLocalStore } from './browserProjectLocalStore.mjs';

export const isProjectStorageReady = status => status === 'ready' || status === 'browser';

export function browserDirectoryError(failure) {
    if (failure?.code && typeof failure.code === 'string') return failure;
    if (['NotAllowedError', 'SecurityError'].includes(failure?.name)) return directoryError('directory_permission_required', '浏览器未允许读写工程文件夹，请点击“重新授权文件夹”；原有备份不会被改动。');
    if (failure?.name === 'AbortError') return directoryError('directory_cancelled', '已取消选择文件夹，未更改保存位置。');
    if (failure?.name === 'QuotaExceededError') return directoryError('directory_full', '磁盘或浏览器存储空间不足；保存未完成，原有备份仍保留。');
    if (failure?.name === 'NotFoundError') return directoryError('directory_not_found', '工程文件夹或文件已移动、删除。请检查原目录，或在首页更换工程文件夹。');
    return failure instanceof Error ? failure : new Error('工程文件夹操作失败。');
}

export function createBrowserProjectDirectory(accountId, { storage = undefined, environment = globalThis, locks = environment.navigator?.locks } = {}) {
    const supported = Boolean(environment.isSecureContext && environment.showDirectoryPicker && environment.crypto?.subtle);
    if (!supported) return createBrowserProjectLocalStore(accountId, { storage });
    const accountKey = 'gzt-browser-project-directory-v1:' + accountId;
    let record = null;
    let store = null;
    let state = supported ? 'unselected' : 'unsupported';
    let choosing = false;
    let storageWarning = '';
    const attach = saved => {
        record = saved;
        store = createBrowserProjectDirectoryStore(saved.handle, { label: saved.label, locks });
    };
    const requireReady = () => {
        if (!accountId) throw directoryError('login_required', '请先登录，再授权此电脑的工程文件夹。');
        if (!supported) throw directoryError('directory_unsupported', '请选择 Chrome 或 Edge，通过 HTTPS 打开网站（本机可使用 localhost）。Safari、Firefox 和局域网 HTTP 不支持文件夹自动保存。');
        if (!store || state !== 'ready') throw directoryError('directory_permission_required', record ? '请点击“重新授权文件夹”，恢复自动保存。' : '请先选择桌面上的工程文件夹；工程只写入你自己的电脑。');
    };
    const run = async (method, ...args) => {
        try { requireReady(); return await store[method](...args); }
        catch (failure) {
            const error = browserDirectoryError(failure);
            if (error.code === 'directory_permission_required') state = record ? 'permission' : 'unselected';
            throw error;
        }
    };
    return {
        get state() { return state; },
        get directory() { return record?.label || ''; },
        get scope() { return accountKey + ':' + (record?.identity || 'unselected'); },
        async restore() {
            if (!supported || !accountId || record) return;
            try {
                const saved = await storage.get(accountKey);
                if (!saved?.handle || saved.handle.kind !== 'directory' || typeof saved.identity !== 'string' || typeof saved.label !== 'string') return;
                attach(saved);
                state = await record.handle.queryPermission({ mode: 'readwrite' }) === 'granted' ? 'ready' : 'permission';
            } catch { state = record ? 'permission' : 'unselected'; storageWarning = '浏览器未能恢复文件夹授权，请重新选择原文件夹；磁盘上的工程仍保留。'; }
        },
        async authorize({ change = false, beforeSwitch = async () => {} } = {}) {
            if (choosing) return false;
            if (!accountId || !supported) { requireReady(); return false; }
            choosing = true;
            try {
                if (record && !change) {
                    const permission = await record.handle.requestPermission({ mode: 'readwrite' });
                    if (permission !== 'granted') throw directoryError('directory_permission_required', '未取得文件夹读写权限，请再次点击授权并选择“允许”。');
                    state = 'ready';
                    return true;
                }
                const selected = await environment.showDirectoryPicker({ id: 'resonantor-canvas-projects', mode: 'readwrite', startIn: 'desktop' });
                await beforeSwitch();
                const digest = await environment.crypto.subtle.digest('SHA-256', new TextEncoder().encode(accountId));
                const accountFolder = '账户-' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
                const root = selected.name === PROJECT_DIRECTORY_NAME ? selected : await selected.getDirectoryHandle(PROJECT_DIRECTORY_NAME, { create: true });
                const handle = await root.getDirectoryHandle(accountFolder, { create: true });
                if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw directoryError('directory_permission_required', '请选择允许读写的文件夹。');
                const same = record && await handle.isSameEntry(record.handle);
                const saved = { handle, label: root.name + '/' + accountFolder, identity: same ? record.identity : createRandomId() };
                await storage.set(accountKey, saved).catch(() => { storageWarning = '本次可直接保存文件，但浏览器无法记住授权目录；下次打开需要重新选择同一文件夹。'; });
                attach(saved);
                state = 'ready';
                return true;
            } catch (failure) {
                const error = browserDirectoryError(failure);
                if (error.code === 'directory_permission_required') state = record ? 'permission' : 'unselected';
                throw error;
            } finally { choosing = false; }
        },
        async list() {
            const result = await run('list');
            if (storageWarning) result.warnings.push(storageWarning);
            return result;
        },
        create: (...args) => run('create', ...args),
        open: (...args) => run('open', ...args),
        save: (...args) => run('save', ...args),
        configure: (...args) => run('configure', ...args),
        rename: (...args) => run('rename', ...args),
        remove: (...args) => run('remove', ...args),
    };
}
