import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const url = process.env.CANVAS_VERIFY_URL || 'http://192.168.0.228:3005/';
const browser = await chromium.launch({ channel: process.env.CANVAS_VERIFY_BROWSER || 'msedge', headless: true });
let username = 'lan_project_alice';
const requests = [];
const errors = [];

try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await context.route('**/api/**', route => {
        const endpoint = new URL(route.request().url()).pathname;
        requests.push(endpoint);
        if (endpoint === '/api/auth/me') return route.fulfill({ json: { user: { id: username, username, role: 'user' } } });
        if (endpoint === '/api/model-settings') return route.fulfill({ json: { revision: 1, settings: { imageProviders: [], videoProviders: [], textProviders: [], audioProviders: [], concurrencyLimit: 3 } } });
        if (endpoint === '/api/auth/wechat/config') return route.fulfill({ json: { enabled: false } });
        return route.fulfill({ status: 503, json: { error: { message: '隔离验收不使用用户账户、模型或服务器工程目录。' } } });
    });
    await context.addInitScript(() => {
        localStorage.setItem('welcome_notice_seen', 'true');
        const originalInterval = window.setInterval;
        window.setInterval = (callback, milliseconds, ...args) => {
            if (milliseconds >= 60_000 && milliseconds <= 7_200_000) window.__lanAutosave = callback;
            return originalInterval(callback, milliseconds, ...args);
        };
        window.__readLanProjects = async () => {
            const database = await new Promise((resolve, reject) => {
                const request = indexedDB.open('keyval-store');
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            try {
                return await new Promise((resolve, reject) => {
                    const request = database.transaction('keyval').objectStore('keyval').getAll();
                    request.onsuccess = () => resolve(request.result.filter(record => record?.project && Array.isArray(record.snapshots)));
                    request.onerror = () => reject(request.error);
                });
            } finally { database.close(); }
        };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    const readyHome = async () => {
        await page.getByRole('heading', { name: '最近项目' }).waitFor();
        await page.getByRole('button', { name: username, exact: true }).waitFor();
        await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).some(button => button.textContent === '正在读取…'));
    };
    const readRecords = () => page.evaluate(() => window.__readLanProjects());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.evaluate(() => window.isSecureContext), false, 'This regression must use a real insecure LAN HTTP origin.');
    assert.equal(await page.evaluate(() => typeof window.showDirectoryPicker), 'undefined');
    await readyHome();
    await page.getByRole('button', { name: '新建工程', exact: true }).click();
    const create = page.getByRole('dialog', { name: '新建工程', exact: true });
    await create.getByLabel('工程名称').fill('局域网创建验收');
    assert.equal(await create.getByRole('button', { name: '创建并打开' }).isEnabled(), true);
    await create.getByRole('button', { name: '创建并打开' }).click();
    await page.locator('[data-project-auto-save]').waitFor();
    await page.waitForFunction(() => typeof window.__lanAutosave === 'function');
    await page.getByTitle('Add Image Node', { exact: true }).click();
    await page.locator('[data-node-id]').waitFor();
    for (let revision = 0; revision < 6; revision += 1) await page.evaluate(async () => { await window.__lanAutosave(); });
    let records = await readRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].project.settings.intervalMinutes, 5);
    assert.equal(records[0].project.snapshotCount, 5);
    assert.equal(records[0].snapshots.at(-1).data.nodes.length, 1);
    const originalId = records[0].project.id;
    console.log('PASS 真实局域网 HTTP 可创建并编辑，自动保存至 IndexedDB，保留五份快照');

    await page.getByRole('button', { name: 'Auto save', exact: true }).click();
    const settings = page.getByRole('region', { name: '自动保存设置' });
    await settings.getByLabel('保存频率（分钟）').fill('2');
    await settings.getByLabel('最大保存数目').fill('3');
    await settings.getByRole('button', { name: '应用设置', exact: true }).click();
    await page.waitForFunction(async () => (await window.__readLanProjects())[0].project.settings.maxSnapshots === 3);
    await page.keyboard.press('Escape');
    const downloadEvent = page.waitForEvent('download');
    await page.getByTitle('导出项目', { exact: true }).click();
    const download = await downloadEvent;
    const exported = await fs.readFile(await download.path(), 'utf8');
    assert.equal(JSON.parse(exported).nodes.length, 1);
    await page.getByTitle('保存工程并返回首页').click();
    await readyHome();
    await page.getByRole('button', { name: '重命名工程：局域网创建验收', exact: true }).click();
    const rename = page.getByRole('dialog', { name: '重命名工程', exact: true });
    await rename.getByLabel('工程名称').fill('局域网已保存工程');
    await rename.getByRole('button', { name: '保存名称', exact: true }).click();
    await rename.waitFor({ state: 'hidden' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await readyHome();
    await page.getByRole('button', { name: '打开工程：局域网已保存工程', exact: true }).click();
    await page.locator('[data-node-id]').waitFor();
    await page.getByRole('button', { name: 'Auto save', exact: true }).click();
    await page.getByRole('region', { name: '自动保存设置' }).getByText('当前工程：局域网已保存工程').waitFor();
    await page.keyboard.press('Escape');
    await page.getByTitle('保存工程并返回首页').click();
    await readyHome();
    console.log('PASS Auto save 配置、重命名、导出下载和刷新重开后节点完整');

    const image = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 2; canvas.height = 2;
        canvas.getContext('2d').fillRect(0, 0, 2, 2);
        return canvas.toDataURL('image/png');
    });
    const imported = { version: 1, nodes: [{ id: 'lan-media', type: 'image', title: '局域网图片', position: { x: 260, y: 180 }, width: 300, height: 250, content: image, blobData: image }], connections: [], groups: [], viewport: { x: 0, y: 0, k: 1 } };
    await page.locator('input[type=file][accept=".json,.js"]').setInputFiles({ name: '局域网媒体.js', mimeType: 'text/javascript', buffer: Buffer.from('export default ' + JSON.stringify(imported) + ';\n') });
    await page.locator('[data-node-id="lan-media"]').waitFor();
    await page.getByTitle('保存工程并返回首页').click();
    await readyHome();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await readyHome();
    await page.getByRole('button', { name: '打开工程：局域网媒体', exact: true }).click();
    await page.waitForFunction(() => {
        const image = document.querySelector('[data-node-id="lan-media"] img');
        return image?.complete && image.naturalWidth > 0;
    });
    console.log('PASS 导入 JS 工程、媒体序列化保存和刷新恢复');

    username = 'lan_project_bob';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await readyHome();
    assert.equal(await page.locator('[data-project-id]').count(), 0);
    await page.getByRole('button', { name: '新建工程', exact: true }).click();
    const other = page.getByRole('dialog', { name: '新建工程', exact: true });
    await other.getByLabel('工程名称').fill('Bob 本地工程');
    await other.getByRole('button', { name: '创建并打开' }).click();
    await page.locator('[data-project-auto-save]').waitFor();
    assert.equal(await page.locator('[data-node-id]').count(), 0);
    await page.getByTitle('保存工程并返回首页').click();
    await readyHome();
    username = 'lan_project_alice';
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await readyHome();
    assert.equal(await page.locator('[data-project-id]').count(), 2);
    await page.getByRole('checkbox', { name: '选择工程：局域网已保存工程', exact: true }).click();
    await page.getByRole('button', { name: '删除选中工程', exact: true }).click();
    await page.getByRole('dialog', { name: '删除选中工程', exact: true }).getByRole('button', { name: '确认删除', exact: true }).click();
    await page.getByRole('button', { name: '打开工程：局域网已保存工程', exact: true }).waitFor({ state: 'hidden' });
    records = await readRecords();
    assert.ok(records.find(record => record.project.id === originalId).deletedAt);
    assert.equal(requests.some(endpoint => endpoint.includes('/api/canvas-projects')), false);
    assert.deepEqual(errors, []);
    console.log('PASS 编辑中切换账号无工程串号，删除仅隐藏，未向服务器写工程');
} finally { await browser.close(); }
