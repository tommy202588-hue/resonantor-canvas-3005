import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/api/**', route => {
        const endpoint = new URL(route.request().url()).pathname;
        if (endpoint === '/api/auth/me') return route.fulfill({ json: { user: { id: 'save-recovery', username: 'save-recovery', role: 'user' } } });
        if (endpoint === '/api/model-settings') return route.fulfill({ json: { revision: 1, settings: { imageProviders: [], videoProviders: [], textProviders: [], audioProviders: [], concurrencyLimit: 15 } } });
        if (endpoint === '/api/auth/wechat/config') return route.fulfill({ json: { enabled: false } });
        return route.fulfill({ status: 503, json: { error: { message: 'isolated storage verification' } } });
    });
    await context.addInitScript(() => localStorage.setItem('welcome_notice_seen', 'true'));
    const page = await context.newPage();
    await page.goto(process.env.CANVAS_VERIFY_URL || 'http://192.168.0.228:3005/');
    const result = await page.evaluate(async () => {
        const storage = await import('/node_modules/.vite/deps/idb-keyval.js');
        const { updateProjectRecord } = await import('/services/projectStorageUpdate.mjs');
        const { createBrowserProjectLocalStore } = await import('/services/browserProjectLocalStore.mjs');
        const { createBrowserProjectData, createSerializableProjectData, restoreProjectData } = await import('/services/storageService.ts');
        const key = 'save-recovery-fixture';
        await storage.set(key, { content: 'previous complete document' });
        const originalGet = IDBObjectStore.prototype.get;
        const interruptRead = () => {
            IDBObjectStore.prototype.get = function (...args) {
                const request = originalGet.apply(this, args);
                request.addEventListener('error', event => event.preventDefault());
                this.transaction.abort();
                return request;
            };
        };
        const outcome = promise => Promise.race([
            promise.then(() => 'saved', error => error?.name || 'rejected'),
            new Promise(resolve => setTimeout(() => resolve('pending'), 400)),
        ]);
        interruptRead();
        const oldOutcome = await outcome(storage.update(key, () => ({ content: 'interrupted' })));
        IDBObjectStore.prototype.get = originalGet;
        interruptRead();
        const fixedOutcome = await outcome(updateProjectRecord(key, () => ({ content: 'interrupted' })));
        IDBObjectStore.prototype.get = originalGet;
        const preserved = await storage.get(key);
        await updateProjectRecord(key, () => ({ content: 'retry succeeded' }));
        const retried = await storage.get(key);

        const store = createBrowserProjectLocalStore('save-recovery', { storage: { ...storage, update: updateProjectRecord } });
        const data = label => ({ version: 1, nodes: [{ id: 'media', type: 'image', position: { x: 0, y: 0 }, width: 300, height: 200, title: label, blob: new Blob(['image bytes'], { type: 'image/png' }) }], connections: [] });
        let { project } = await store.create('isolated document', data('first'));
        ({ project } = await store.save(project, data('second')));
        const originalPut = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (value, ...args) {
            if (value?.snapshots?.length > 2) throw new DOMException('Simulated browser storage quota', 'QuotaExceededError');
            return originalPut.call(this, value, ...args);
        };
        let saved;
        try { saved = await store.save(project, data('latest')); }
        finally { IDBObjectStore.prototype.put = originalPut; }
        const reopened = await store.open(project.id);
        const url = URL.createObjectURL(new Blob(['original image data'], { type: 'image/png' }));
        const source = [{ id: 'ephemeral-image', type: 'image', position: { x: 0, y: 0 }, width: 10, height: 10, content: url, allImages: [url] }];
        const binary = await createBrowserProjectData(source, []);
        const exported = await createSerializableProjectData(source, []);
        URL.revokeObjectURL(url);
        const restored = restoreProjectData(JSON.parse(JSON.stringify(exported)));
        const restoredMedia = await (await fetch(restored.nodes[0].content)).text();
        const restoredGallery = await (await fetch(restored.nodes[0].allImages[0])).text();
        await storage.del(key);
        return { oldOutcome, fixedOutcome, preserved, retried, snapshotCount: saved.project.snapshotCount, warning: saved.project.warning, title: reopened.data.nodes[0].title, media: await reopened.data.nodes[0].blob.text(), binaryMedia: await (binary.nodes[0].blob || binary.nodes[0].allBlobs[0]).text(), restoredMedia, restoredGallery };
    });
    assert.equal(result.oldOutcome, 'pending');
    assert.equal(result.fixedOutcome, 'AbortError');
    assert.equal(result.preserved.content, 'previous complete document');
    assert.equal(result.retried.content, 'retry succeeded');
    assert.equal(result.snapshotCount, 1);
    assert.match(result.warning, /仅保留最新快照/);
    assert.equal(result.title, 'latest');
    assert.equal(result.media, 'image bytes');
    assert.equal(result.binaryMedia, 'original image data');
    assert.equal(result.restoredMedia, 'original image data');
    assert.equal(result.restoredGallery, 'original image data');
    console.log('PASS reproduced old stalled save; fixed transaction rejects, preserves the document and allows retry');
    console.log('PASS quota recovery saves latest document and binary media atomically in real IndexedDB');
    console.log('PASS media with missing Blob companions survives save/export after its original object URL is revoked');

    // Exercise the actual Save button, error display and retry state as well.
    await page.reload();
    page.on('dialog', dialog => dialog.accept());
    await page.getByRole('heading', { name: '最近项目', exact: true }).waitFor();
    await page.getByRole('button', { name: '新建工程', exact: true }).click();
    const create = page.getByRole('dialog', { name: '新建工程', exact: true });
    await create.getByLabel('工程名称').fill('保存重试验收');
    await create.getByRole('button', { name: '创建并打开' }).click();
    await page.locator('[data-project-auto-save]').waitFor();
    await page.getByTitle('Add Image Node', { exact: true }).click();
    await page.locator('[data-node-id]').waitFor();
    await page.getByRole('button', { name: 'Auto save', exact: true }).click();
    const settings = page.getByRole('region', { name: '自动保存设置' });
    await page.evaluate(() => {
        const get = IDBObjectStore.prototype.get;
        IDBObjectStore.prototype.get = function (...args) {
            const request = get.apply(this, args);
            if (String(args[0]).startsWith('gzt-browser-projects-v1:')) {
                IDBObjectStore.prototype.get = get;
                request.addEventListener('error', event => event.preventDefault());
                this.transaction.abort();
            }
            return request;
        };
    });
    await settings.getByRole('button', { name: '立即保存', exact: true }).click();
    await settings.getByRole('alert').waitFor();
    await settings.getByRole('button', { name: '立即保存', exact: true }).click();
    await settings.getByText('工程已保存到当前浏览器；可通过“导出项目”下载文件备份。', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByTitle('保存工程并返回首页').click();
    await page.getByRole('heading', { name: '最近项目', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: '打开工程：保存重试验收', exact: true }).click();
    await page.locator('[data-node-id]').waitFor();
    console.log('PASS actual Save button exits failed read state, retries and reopens the saved document after reload');

    const waiting = await page.evaluate(async () => {
        const { prepareProjectSave } = await import('/services/projectSavePipeline.mjs');
        const { updateProjectRecord } = await import('/services/projectStorageUpdate.mjs');
        const storage = await import('/node_modules/.vite/deps/idb-keyval.js');
        const data = { nodes: [], connections: [], version: 1 };
        const prepared = await prepareProjectSave(data, {
            serialize: async () => data, thumbnail: () => new Promise(() => {}),
            previousThumbnail: 'previous cover', thumbnailTimeoutMs: 30,
        });
        let serializationError;
        try {
            await prepareProjectSave(data, { serialize: () => new Promise(() => {}), thumbnail: async () => '', preparationTimeoutMs: 30 });
        } catch (error) { serializationError = error.code; }
        const key = 'save-open-timeout-fixture';
        await storage.set(key, { content: 'saved before interruption' });
        const open = IDBFactory.prototype.open;
        let openError;
        IDBFactory.prototype.open = function () { return {}; };
        try { await updateProjectRecord(key, () => ({ content: 'must not be written' }), { openTimeoutMs: 30 }); }
        catch (error) { openError = error.code; }
        finally { IDBFactory.prototype.open = open; }
        const afterOpenFailure = await storage.get(key);
        const get = IDBObjectStore.prototype.get;
        let transactionError;
        let aborted = false;
        IDBObjectStore.prototype.get = function (requested) {
            if (requested !== key) return get.call(this, requested);
            const objectStore = this;
            objectStore.transaction.addEventListener('abort', () => { aborted = true; });
            const keepAlive = () => {
                if (aborted) return;
                const request = get.call(objectStore, 'save-read-keepalive');
                request.addEventListener('success', keepAlive);
                request.addEventListener('error', event => event.preventDefault());
            };
            keepAlive();
            // Simulate a read request that never calls the saving code back.
            return {};
        };
        try { await updateProjectRecord(key, () => ({ content: 'must not be committed' }), { timeoutMs: 50 }); }
        catch (error) { transactionError = error.code; }
        finally { IDBObjectStore.prototype.get = get; }
        const afterTransactionFailure = await storage.get(key);
        await updateProjectRecord(key, () => ({ content: 'retry saved' }));
        const afterRetry = await storage.get(key);
        await storage.del(key);
        return { cover: prepared.thumbnail, serializationError, openError, transactionError, aborted, afterOpenFailure, afterTransactionFailure, afterRetry };
    });
    assert.equal(waiting.cover, 'previous cover');
    assert.equal(waiting.serializationError, 'project_save_timeout');
    assert.equal(waiting.openError, 'project_save_timeout');
    assert.equal(waiting.transactionError, 'project_save_timeout');
    assert.equal(waiting.aborted, true);
    assert.equal(waiting.afterOpenFailure.content, 'saved before interruption');
    assert.equal(waiting.afterTransactionFailure.content, 'saved before interruption');
    assert.equal(waiting.afterRetry.content, 'retry saved');
    console.log('PASS hung preparation/open/read stop waiting; timed-out transaction aborts, previous document survives and retry commits');

    const image = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
        canvas.getContext('2d').fillRect(0, 0, 64, 64);
        return canvas.toDataURL('image/png');
    });
    await page.keyboard.press('Escape');
    await page.getByTitle('保存工程并返回首页').click();
    await page.getByRole('heading', { name: '最近项目', exact: true }).waitFor();
    await page.locator('input[type=file][accept=".json,.js"]').setInputFiles({ name: '封面卡住验收.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, nodes: [{ id: 'cover-image', type: 'image', title: '图片原件', position: { x: 260, y: 180 }, width: 300, height: 250, content: image, blobData: image }], connections: [], groups: [] })) });
    await page.locator('[data-node-id="cover-image"]').waitFor();
    await page.evaluate(() => {
        window.__realCreateImageBitmap = window.createImageBitmap;
        window.createImageBitmap = () => new Promise(() => {});
    });
    await page.getByRole('button', { name: 'Auto save', exact: true }).click();
    await settings.getByRole('button', { name: '立即保存', exact: true }).click();
    await page.getByRole('button', { name: 'Auto save', exact: true }).waitFor();
    await settings.getByText('工程已保存到当前浏览器；可通过“导出项目”下载文件备份。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Auto save', exact: true }).count(), 1);
    await page.evaluate(() => { window.createImageBitmap = window.__realCreateImageBitmap; });
    await page.keyboard.press('Escape');
    await page.getByTitle('保存工程并返回首页').click();
    await page.getByRole('heading', { name: '最近项目', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: '打开工程：封面卡住验收', exact: true }).click();
    await page.waitForFunction(() => {
        const image = document.querySelector('[data-node-id="cover-image"] img');
        return image?.complete && image.naturalWidth === 64;
    });
    console.log('PASS actual image document saves and reopens with its original image even when thumbnail decoding never completes');

    const refreshRecovery = await page.evaluate(async () => {
        const { default: React } = await import('/node_modules/.vite/deps/react.js');
        const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
        const { createRoot } = ReactDOM;
        const Refresh = await import('/@react-refresh');
        const { useCanvasProjects } = await import('/services/useCanvasProjects.ts');
        const storage = await import('/node_modules/.vite/deps/idb-keyval.js');
        const data = { version: 1, nodes: [{ id: 'retained-text', type: 'text', content: '热更新前未保存的内容', position: { x: 0, y: 0 }, width: 300, height: 200 }], connections: [] };
        let workspace;
        const noop = () => {};
        const snapshot = () => data;
        function HarnessBefore() {
            workspace = useCanvasProjects(data, snapshot, noop, noop, noop, true, 'save-hmr-fixture');
            return React.createElement('span', null, workspace.saving ? 'Saving' : 'Idle');
        }
        function HarnessAfter() {
            workspace = useCanvasProjects(data, snapshot, noop, noop, noop, true, 'save-hmr-fixture');
            return React.createElement('span', null, workspace.saving ? 'Saving' : 'Idle');
        }
        const until = async predicate => {
            for (let index = 0; index < 400; index++) {
                if (predicate()) return;
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            throw new Error('Timed out waiting for Fast Refresh save recovery');
        };
        const container = document.createElement('div'); document.body.append(container);
        const root = createRoot(container);
        const family = 'save-recovery-browser-harness';
        Refresh.register(HarnessBefore, family);
        root.render(React.createElement(HarnessBefore));
        await until(() => workspace && !workspace.loading);
        await workspace.create('热更新保存验收');
        await until(() => workspace.active);
        const id = workspace.active.id;
        const get = IDBObjectStore.prototype.get;
        let reading = false;
        let aborted = false;
        IDBObjectStore.prototype.get = function (key) {
            if (key !== 'gzt-browser-projects-v1:save-hmr-fixture:' + id) return get.call(this, key);
            IDBObjectStore.prototype.get = get;
            reading = true;
            const objectStore = this;
            objectStore.transaction.addEventListener('abort', () => { aborted = true; });
            const keepAlive = () => {
                if (aborted) return;
                const request = get.call(objectStore, 'hmr-read-keepalive');
                request.addEventListener('success', keepAlive);
                request.addEventListener('error', event => event.preventDefault());
            };
            keepAlive();
            return {};
        };
        const pending = workspace.saveNow().catch(error => error.name);
        try {
            await until(() => reading && workspace.saving);
            Refresh.register(HarnessAfter, family);
            Refresh.validateRefreshBoundaryAndEnqueueUpdate(family, { Harness: HarnessBefore }, { Harness: HarnessAfter });
            await until(() => !workspace.saving && workspace.active?.revision > 1);
            const saved = await storage.get('gzt-browser-projects-v1:save-hmr-fixture:' + id);
            return { aborted, oldAttempt: await pending, content: saved.snapshots.at(-1).data.nodes[0].content, activeId: workspace.active.id, originalId: id };
        } finally {
            IDBObjectStore.prototype.get = get;
            root.unmount(); container.remove();
        }
    });
    assert.equal(refreshRecovery.aborted, true);
    assert.equal(refreshRecovery.oldAttempt, 'AbortError');
    assert.equal(refreshRecovery.activeId, refreshRecovery.originalId);
    assert.equal(refreshRecovery.content, '热更新前未保存的内容');
    console.log('PASS real React Fast Refresh aborts the obsolete save, keeps the active canvas and saves its unsaved content');
} finally { await browser.close(); }
