import { saveTimeout } from './projectSavePipeline.mjs';

// Opening the database can also stall; do not reuse a cached pending/failed
// open promise. Keep the existing database and records intact.
function openDatabase({ signal, openTimeoutMs = 10_000 }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const request = indexedDB.open('keyval-store');
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            callback(value);
        };
        const abort = () => finish(reject, signal.reason || new DOMException('保存已取消。', 'AbortError'));
        const timer = setTimeout(() => finish(reject, saveTimeout('打开工程存储')), openTimeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        request.onupgradeneeded = () => {
            if (settled) { request.transaction.abort(); return; }
            if (!request.result.objectStoreNames.contains('keyval')) request.result.createObjectStore('keyval');
        };
        request.onblocked = () => finish(reject, Object.assign(new Error('工程存储被其他页面占用，请关闭同地址的其他画布页面后重试；当前画布请先导出备份。'), { code: 'project_storage_blocked' }));
        request.onerror = () => finish(reject, request.error);
        request.onsuccess = () => {
            if (settled) { request.result.close(); return; }
            finish(resolve, request.result);
        };
    });
}

// Listing and opening used the old cached idb-keyval connection even after
// writes were fixed. Bound reads too, and close each connection on every path.
async function readProjectStorage(makeRequest, options = {}) {
    const { signal, timeoutMs = 12_000 } = options;
    const database = await openDatabase(options);
    try {
        return await new Promise((resolve, reject) => {
            signal?.throwIfAborted();
            const transaction = database.transaction('keyval', 'readonly');
            let settled = false;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                callback(value);
            };
            const stop = error => {
                try { transaction.abort(); } catch { /* already completed */ }
                finish(reject, error);
            };
            const abort = () => stop(signal.reason || new DOMException('读取已取消。', 'AbortError'));
            const timer = setTimeout(() => stop(Object.assign(new Error('读取本机工程超时，原有工程未删除。请关闭同地址的其他画布页后点击“刷新项目”，不要清除网站数据。'), { code: 'project_read_timeout' })), timeoutMs);
            signal?.addEventListener('abort', abort, { once: true });
            transaction.onerror = transaction.onabort = () => finish(reject, transaction.error || new DOMException('工程读取已中断，请重试。', 'AbortError'));
            try {
                const request = makeRequest(transaction.objectStore('keyval'));
                request.onerror = () => finish(reject, request.error);
                request.onsuccess = () => finish(resolve, request.result);
            } catch (error) { stop(error); }
        });
    } finally { database.close(); }
}

export const getProjectRecord = (key, options) => readProjectStorage(store => store.get(key), options);
export const getProjectKeys = (options) => readProjectStorage(store => store.getAllKeys(), options);

export async function updateProjectRecord(key, updater, options = {}) {
    const { signal, timeoutMs = 60_000 } = options;
    options.onStage?.('正在连接浏览器工程存储');
    const database = await openDatabase(options);
    try {
        return await new Promise((resolve, reject) => {
            signal?.throwIfAborted();
            const transaction = database.transaction('keyval', 'readwrite');
            const objectStore = transaction.objectStore('keyval');
            options.onStage?.('正在等待浏览器写入工程');
            let failure;
            let settled = false;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                callback(value);
            };
            const abort = () => {
                failure = signal?.reason || new DOMException('保存已取消。', 'AbortError');
                try { transaction.abort(); finish(reject, failure); } catch { /* completion event determines the committed result */ }
            };
            const timer = setTimeout(() => {
                failure = saveTimeout('写入工程');
                try { transaction.abort(); }
                catch { /* completion event determines whether the commit won */ }
                // Some browser storage failures never dispatch an abort event.
                finish(reject, failure);
            }, timeoutMs);
            transaction.oncomplete = () => finish(resolve);
            transaction.onerror = transaction.onabort = () => finish(reject, failure || transaction.error || new DOMException('工程存储事务已中断，请重试。', 'AbortError'));
            signal?.addEventListener('abort', abort, { once: true });
            const request = objectStore.get(key);
            request.onerror = () => { failure = request.error; };
            request.onsuccess = () => {
                if (settled || signal?.aborted) return;
                try { objectStore.put(updater(request.result), key); }
                catch (error) {
                    failure = error;
                    transaction.abort();
                }
            };
        });
    } finally { database.close(); }
}
