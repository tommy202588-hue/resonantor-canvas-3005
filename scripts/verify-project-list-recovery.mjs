import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/api/**', route => {
        const endpoint = new URL(route.request().url()).pathname;
        if (endpoint === '/api/auth/me') return route.fulfill({ json: { user: { id: 'list-recovery', username: 'list-recovery', role: 'user' } } });
        if (endpoint === '/api/model-settings') return route.fulfill({ json: { revision: 1, settings: { imageProviders: [], videoProviders: [], textProviders: [], audioProviders: [], concurrencyLimit: 15 } } });
        if (endpoint === '/api/auth/wechat/config') return route.fulfill({ json: { enabled: false } });
        return route.fulfill({ status: 503, json: { error: { message: 'Isolated project test, no model requests' } } });
    });
    await context.addInitScript(() => localStorage.setItem('welcome_notice_seen', 'true'));
    const page = await context.newPage();
    page.on('dialog', dialog => dialog.accept());
    await page.goto(process.env.CANVAS_VERIFY_URL || 'http://192.168.0.228:3005/');
    await page.getByRole('button', { name: 'list-recovery', exact: true }).waitFor();
    await page.getByRole('button', { name: '刷新项目 ↻', exact: true }).waitFor();
    const seed = await page.evaluate(async () => {
        const { getProjectRecord, getProjectKeys, updateProjectRecord } = await import('/services/projectStorageUpdate.mjs');
        const { createBrowserProjectLocalStore } = await import('/services/browserProjectLocalStore.mjs');
        const store = createBrowserProjectLocalStore('list-recovery', { storage: { get: getProjectRecord, keys: getProjectKeys, update: updateProjectRecord } });
        const data = { version: 1, nodes: [{ id: 'existing-text', type: 'text', content: '旧工程必须保留', position: { x: 10, y: 10 }, width: 300, height: 200 }], connections: [] };
        return (await store.create('原有工程', data)).project.id;
    });
    await page.getByRole('button', { name: '刷新项目 ↻', exact: true }).click();
    await page.getByRole('button', { name: '打开工程：原有工程', exact: true }).waitFor();

    const blockList = () => page.evaluate(() => {
        window.__realGetAllKeys = IDBObjectStore.prototype.getAllKeys;
        IDBObjectStore.prototype.getAllKeys = function () { return {}; };
    });
    const unblockList = () => page.evaluate(() => { IDBObjectStore.prototype.getAllKeys = window.__realGetAllKeys; });
    await blockList();
    await page.getByRole('button', { name: '刷新项目 ↻', exact: true }).click();
    await page.getByRole('button', { name: '正在读取…', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '新建工程', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: '导入工程', exact: true }).isEnabled(), true);
    await page.getByRole('alert').filter({ hasText: '读取工程列表超时' }).waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: '刷新项目 ↻', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '打开工程：原有工程', exact: true }).count(), 1);
    await unblockList();
    await page.getByRole('button', { name: '刷新项目 ↻', exact: true }).click();
    await page.getByRole('alert').waitFor({ state: 'hidden' });
    console.log('PASS hung list exits loading, preserves existing cards and allows refresh retry');

    await blockList();
    await page.getByRole('button', { name: '刷新项目 ↻', exact: true }).click();
    await page.getByRole('button', { name: '正在读取…', exact: true }).waitFor();
    await page.getByRole('button', { name: '新建工程', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建工程', exact: true });
    await dialog.getByLabel('工程名称').fill('列表卡住仍可新建');
    await dialog.getByRole('button', { name: '创建并打开', exact: true }).click();
    await page.locator('[data-project-auto-save]').waitFor();
    await unblockList();
    await page.getByTitle('保存工程并返回首页').click();
    await page.getByRole('button', { name: '打开工程：列表卡住仍可新建', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: '打开工程：列表卡住仍可新建', exact: true }).waitFor();
    await page.getByRole('button', { name: '打开工程：原有工程', exact: true }).click();
    await page.locator('[data-node-id="existing-text"]').waitFor();
    const original = await page.evaluate(async id => {
        const { getProjectRecord } = await import('/services/projectStorageUpdate.mjs');
        return (await getProjectRecord('gzt-browser-projects-v1:list-recovery:' + id)).snapshots.at(-1).data.nodes[0].content;
    }, seed);
    assert.equal(original, '旧工程必须保留');
    console.log('PASS new project commits while old listing is stalled; reload shows both new and original project intact');

    const failures = await page.evaluate(async () => {
        const { getProjectRecord } = await import('/services/projectStorageUpdate.mjs');
        const originalOpen = IDBFactory.prototype.open;
        IDBFactory.prototype.open = () => ({});
        let timeout;
        try { await getProjectRecord('fixture', { openTimeoutMs: 25 }); } catch (error) { timeout = error.code; }
        finally { IDBFactory.prototype.open = originalOpen; }
        const originalGet = IDBObjectStore.prototype.get;
        IDBObjectStore.prototype.get = function (key) {
            const request = originalGet.call(this, key);
            request.addEventListener('error', event => event.preventDefault());
            this.transaction.abort();
            return request;
        };
        let aborted;
        try { await getProjectRecord('fixture'); } catch (error) { aborted = error.name; }
        finally { IDBObjectStore.prototype.get = originalGet; }
        return { timeout, aborted };
    });
    assert.equal(failures.timeout, 'project_save_timeout');
    assert.equal(failures.aborted, 'AbortError');
    console.log('PASS database open stall and aborted reads reject instead of poisoning future reads');
} finally { await browser.close(); }
