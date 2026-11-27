import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const url = process.env.CANVAS_VERIFY_URL || 'http://localhost:3005/';
const browser = await chromium.launch({ channel: process.env.CANVAS_VERIFY_BROWSER || 'msedge', headless: true });
const requests = [];
const errors = [];
let username = 'browser_save_alice';

async function mockServices(context, anonymous = false) {
    await context.route('**/api/**', route => {
        const endpoint = new URL(route.request().url()).pathname;
        requests.push(endpoint);
        if (endpoint.endsWith('/api/auth/me')) return route.fulfill({ status: anonymous ? 401 : 200, json: anonymous ? { error: { message: '请登录' } } : { user: { id: username, username, displayName: username, role: 'user' } } });
        if (endpoint.endsWith('/api/model-settings')) return route.fulfill({ json: { revision: 1, settings: { imageProviders: [], videoProviders: [], audioProviders: [], textProviders: [], concurrencyLimit: 3 } } });
        if (endpoint.endsWith('/api/auth/wechat/config')) return route.fulfill({ json: { enabled: false } });
        return route.fulfill({ status: 503, json: { error: { message: '此验收仅测试本机工程存储，不调用云模型或 GPU。' } } });
    });
}

async function installTestDirectory(context) {
    await context.addInitScript(() => {
        const state = { calls: 0, requests: 0, cancel: false, interval: 0, autoSave: null };
        window.__projectTest = state;
        window.showDirectoryPicker = () => {
            state.calls += 1;
            if (!navigator.userActivation.isActive) return Promise.reject(new DOMException('Missing user gesture', 'SecurityError'));
            if (state.cancel) return Promise.reject(new DOMException('Cancelled', 'AbortError'));
            return navigator.storage.getDirectory();
        };
        FileSystemDirectoryHandle.prototype.queryPermission = async () => localStorage.getItem('gzt-test-revoked') ? 'prompt' : 'granted';
        FileSystemDirectoryHandle.prototype.requestPermission = () => {
            state.requests += 1;
            if (!navigator.userActivation.isActive) return Promise.reject(new DOMException('Missing user gesture', 'SecurityError'));
            localStorage.removeItem('gzt-test-revoked');
            return Promise.resolve('granted');
        };
        const originalInterval = window.setInterval;
        window.setInterval = (callback, milliseconds, ...args) => {
            if (milliseconds >= 60_000 && milliseconds <= 7_200_000) { state.autoSave = callback; state.interval = milliseconds; }
            return originalInterval(callback, milliseconds, ...args);
        };
        window.__readProjectFiles = async () => {
            const result = [];
            const desktop = await navigator.storage.getDirectory();
            let root;
            try { root = await desktop.getDirectoryHandle('共智体画布工程'); } catch { return result; }
            for await (const [account, directory] of root.entries()) {
                if (directory.kind !== 'directory') continue;
                for await (const [id, projectDirectory] of directory.entries()) {
                    await navigator.locks.request('gzt-project-directory:' + id, async () => {
                    let metadata;
                    try { metadata = JSON.parse(await (await (await projectDirectory.getFileHandle('project.json')).getFile()).text()); }
                    catch (failure) { if (failure.name === 'NotFoundError') return; throw failure; }
                    const files = [];
                    for await (const [name, handle] of projectDirectory.entries()) if (name.endsWith('.js')) {
                        try { files.push({ name, text: await (await handle.getFile()).text() }); }
                        catch (failure) { if (failure.name !== 'NotFoundError') throw failure; }
                    }
                    result.push({ account, id, metadata, files });
                    });
                }
            }
            return result;
        };
    });
}

const readProjects = page => page.evaluate(() => window.__readProjectFiles());
const readyHome = async page => {
    await page.getByRole('heading', { name: '最近项目' }).waitFor();
    await page.getByRole('button', { name: username, exact: true }).waitFor();
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).some(button => button.textContent === '正在读取…'));
};

try {
    const anonymous = await browser.newContext();
    await mockServices(anonymous, true);
    const anonymousPage = await anonymous.newPage();
    await anonymousPage.goto(url, { waitUntil: 'domcontentloaded' });
    await anonymousPage.getByRole('button', { name: '新建工程', exact: true }).click();
    await anonymousPage.getByRole('dialog', { name: '登录共智体' }).waitFor();
    await anonymous.close();
    console.log('PASS 登录门禁未被文件夹模式绕过');

    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, acceptDownloads: true });
    await mockServices(context);
    await installTestDirectory(context);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await readyHome(page);
    assert.equal(await page.evaluate(() => window.__projectTest.calls), 0);
    await page.getByRole('button', { name: '新建工程', exact: true }).click();
    const createDialog = page.getByRole('dialog', { name: '新建工程', exact: true });
    await createDialog.getByLabel('工程名称').fill('浏览器工程验收');
    assert.equal(await createDialog.getByRole('button', { name: '创建并打开' }).isDisabled(), true);
    await createDialog.getByRole('button', { name: '选择工程文件夹', exact: true }).click();
    await createDialog.getByRole('button', { name: '创建并打开' }).click();
    await page.locator('[data-project-auto-save]').waitFor();
    let records = await readProjects(page);
    assert.equal(records.length, 1);
    assert.equal(records[0].metadata.name, '浏览器工程验收');
    assert.equal(records[0].metadata.settings.intervalMinutes, 5);
    assert.equal(records[0].metadata.settings.maxSnapshots, 5);
    assert.equal(await page.evaluate(() => window.__projectTest.calls), 1);
    await page.waitForFunction(() => window.__projectTest.interval === 300_000);
    for (let run = 0; run < 6; run += 1) await page.evaluate(async () => { await window.__projectTest.autoSave(); });
    records = await readProjects(page);
    assert.equal(records[0].files.length, 5);
    assert.ok(records[0].metadata.revision >= 7);
    console.log('PASS 从用户点击授权、创建工程并自动裁剪至五份磁盘快照');

    await page.getByRole('button', { name: 'Auto save', exact: true }).click();
    const settings = page.getByRole('region', { name: '自动保存设置' });
    await settings.getByLabel('保存频率（分钟）').fill('2');
    await settings.getByLabel('最大保存数目').fill('3');
    await settings.getByRole('button', { name: '应用设置' }).click();
    await page.waitForFunction(async () => (await window.__readProjectFiles())[0].metadata.settings.maxSnapshots === 3);
    assert.equal((await readProjects(page))[0].files.length, 3);
    await page.keyboard.press('Escape');
    await page.getByTitle('保存工程并返回首页').click();
    await readyHome(page);
    await page.getByRole('button', { name: '重命名工程：浏览器工程验收' }).click();
    const rename = page.getByRole('dialog', { name: '重命名工程', exact: true });
    await rename.getByLabel('工程名称').fill('重命名后的工程');
    await rename.getByRole('button', { name: '保存名称' }).click();
    await rename.waitFor({ state: 'hidden' });
    assert.equal((await readProjects(page))[0].metadata.name, '重命名后的工程');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await readyHome(page);
    await page.getByRole('button', { name: '打开工程：重命名后的工程' }).waitFor();
    assert.equal(await page.evaluate(() => window.__projectTest.calls), 0);
    console.log('PASS Auto save 设置、重命名、刷新后的目录句柄恢复');

    const image = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 2;
        const drawing = canvas.getContext('2d');
        drawing.fillStyle = '#44ddcc';
        drawing.fillRect(0, 0, 2, 2);
        return canvas.toDataURL('image/png');
    });
    const imported = {
        version: 1, nodes: [{ id: 'media-verification', type: 'image', title: '图片持久化验收', position: { x: 200, y: 200 }, width: 300, height: 250, blobData: image, content: image }],
        connections: [], groups: [], viewport: { x: 0, y: 0, k: 1 },
    };
    await page.locator('input[type=file][accept=".json,.js"]').setInputFiles({ name: '媒体保存验收.js', mimeType: 'text/javascript', buffer: Buffer.from('export default ' + JSON.stringify(imported) + ';\n') });
    await page.locator('[data-node-id="media-verification"]').waitFor();
    records = await readProjects(page);
    const mediaRecord = records.find(record => record.metadata.name === '媒体保存验收');
    assert.ok(mediaRecord);
    const diskData = JSON.parse(mediaRecord.files[0].text.replace(/^export default /, '').replace(/;\s*$/, ''));
    assert.equal(diskData.nodes[0].blobData, image);
    await page.evaluate(() => localStorage.setItem('gzt-test-revoked', '1'));
    await page.getByRole('button', { name: 'Auto save', exact: true }).click();
    await page.getByRole('button', { name: '立即保存', exact: true }).click();
    await page.getByRole('button', { name: '重新授权文件夹', exact: true }).first().waitFor();
    assert.equal(await page.evaluate(() => window.__projectTest.requests), 0);
    await page.getByRole('button', { name: '重新授权文件夹', exact: true }).first().click();
    await page.getByRole('button', { name: '立即保存', exact: true }).click();
    await page.waitForFunction(async () => (await window.__readProjectFiles()).some(record => record.metadata.name === '媒体保存验收' && record.metadata.revision > 1));
    assert.equal(await page.evaluate(() => window.__projectTest.requests), 1);
    await page.keyboard.press('Escape');
    await page.getByTitle('保存工程并返回首页').click();
    await readyHome(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await readyHome(page);
    await page.getByRole('button', { name: '打开工程：媒体保存验收' }).click();
    await page.locator('[data-node-id="media-verification"] img').first().waitFor();
    await page.getByTitle('保存工程并返回首页').click();
    await readyHome(page);
    console.log('PASS 媒体 Blob 写入及重新打开、权限撤销后的显式重新授权');

    username = 'browser_save_bob';
    await page.getByRole('button', { name: 'browser_save_alice', exact: true }).click();
    await page.getByRole('dialog', { name: '已登录', exact: true }).getByRole('button', { name: '关闭登录窗口' }).click();
    await readyHome(page);
    assert.equal(await page.locator('[data-project-id]').count(), 0);
    await page.getByRole('button', { name: '选择工程文件夹', exact: true }).click();
    await page.getByRole('button', { name: '新建工程', exact: true }).click();
    const otherCreate = page.getByRole('dialog', { name: '新建工程', exact: true });
    await otherCreate.getByLabel('工程名称').fill('Bob 独立工程');
    await otherCreate.getByRole('button', { name: '创建并打开' }).click();
    await page.locator('[data-project-auto-save]').waitFor();
    records = await readProjects(page);
    assert.equal(new Set(records.map(record => record.account)).size, 2);
    await page.getByTitle('保存工程并返回首页').click();
    username = 'browser_save_alice';
    await page.getByRole('button', { name: 'browser_save_bob', exact: true }).click();
    await page.getByRole('dialog', { name: '已登录', exact: true }).getByRole('button', { name: '关闭登录窗口' }).click();
    await readyHome(page);
    assert.equal(await page.locator('[data-project-id]').count(), 2);
    assert.equal(await page.getByRole('button', { name: '打开工程：Bob 独立工程' }).count(), 0);
    console.log('PASS 同浏览器切换账号，工程、目录授权和草稿相互隔离');

    await page.getByRole('checkbox', { name: '选择工程：重命名后的工程' }).click();
    await page.getByRole('button', { name: '删除选中工程', exact: true }).click();
    await page.getByRole('dialog', { name: '删除选中工程', exact: true }).getByRole('button', { name: '确认删除' }).click();
    await page.getByRole('button', { name: '打开工程：重命名后的工程' }).waitFor({ state: 'hidden' });
    const removed = (await readProjects(page)).find(record => record.metadata.name === '重命名后的工程');
    assert.ok(removed.metadata.deletedAt);
    assert.equal(removed.files.length, 3);
    await page.evaluate(() => { window.__projectTest.cancel = true; });
    await page.getByRole('button', { name: '更换工程文件夹', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已取消选择文件夹' }).waitFor();
    await page.getByRole('button', { name: '打开工程：媒体保存验收' }).waitFor();
    await page.screenshot({ path: path.resolve('web-test-home.png'), fullPage: true });
    console.log('PASS 删除仅隐藏工程并保留快照；取消选择不丢失原目录');

    await page.getByRole('button', { name: '打开工程：媒体保存验收' }).click();
    await page.locator('[data-project-auto-save]').waitFor();
    await page.evaluate(() => localStorage.setItem('gzt-test-revoked', '1'));
    await page.getByRole('button', { name: 'Auto save', exact: true }).click();
    await page.getByRole('button', { name: '立即保存', exact: true }).click();
    await page.getByRole('button', { name: '保留临时草稿并返回首页', exact: true }).click();
    await readyHome(page);
    await page.getByRole('button', { name: '恢复草稿', exact: true }).waitFor();
    await page.getByRole('button', { name: '重新授权文件夹', exact: true }).click();
    await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
    await page.locator('[data-node-id="media-verification"]').waitFor();
    assert.ok((await readProjects(page)).some(record => record.metadata.name === '恢复的画布工程'));
    console.log('PASS 保存失败可保留本账号草稿返回首页，授权后另存恢复，不困在画布');

    const unsupported = await browser.newContext();
    await mockServices(unsupported);
    await unsupported.addInitScript(() => { window.showDirectoryPicker = undefined; });
    const unsupportedPage = await unsupported.newPage();
    await unsupportedPage.goto(url, { waitUntil: 'domcontentloaded' });
    await readyHome(unsupportedPage);
    await unsupportedPage.getByText('工程保存在当前浏览器', { exact: true }).waitFor();
    assert.equal(await unsupportedPage.getByRole('button', { name: '选择工程文件夹', exact: true }).count(), 0);
    await unsupportedPage.getByRole('button', { name: '新建工程', exact: true }).click();
    const fallbackCreate = unsupportedPage.getByRole('dialog', { name: '新建工程', exact: true });
    assert.equal(await fallbackCreate.getByRole('button', { name: '创建并打开' }).isEnabled(), true);
    await fallbackCreate.getByRole('button', { name: '创建并打开' }).click();
    await unsupportedPage.locator('[data-project-auto-save]').waitFor();
    assert.equal(requests.some(endpoint => endpoint.includes('/api/canvas-projects')), false);
    assert.deepEqual(errors, []);
    console.log('PASS 无文件夹接口的浏览器仍可创建本地工程，不改写服务器工程目录');
    console.log('浏览器验收通过：使用真实 Chromium 文件句柄和 OPFS 私有文件系统；系统桌面选择弹窗由测试替身替代，未写入用户桌面。');
} finally { await browser.close(); }
