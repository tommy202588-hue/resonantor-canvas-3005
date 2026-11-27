import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const browser = await chromium.launch({ channel: process.env.CANVAS_VERIFY_BROWSER || 'msedge', headless: true });
const initial = {
    version: 1, viewport: { x: 0, y: 0, k: 1 }, groups: [], connections: [],
    nodes: [
        { id: 'undo-first', type: 'text', title: '第一个节点', content: 'first', position: { x: 220, y: 180 }, width: 260, height: 200, status: 'idle' },
        { id: 'undo-second', type: 'text', title: '第二个节点', content: 'second', position: { x: 800, y: 260 }, width: 260, height: 200, status: 'idle' },
    ],
};
let data = structuredClone(initial);
let project = { id: 'b1abe5cb-a4b7-4a1f-9b89-1b30b5340e21', name: '撤销隔离验收', createdAt: Date.now(), updatedAt: Date.now(), lastSavedAt: Date.now(), revision: 1, snapshotCount: 1, nodeCount: 2, thumbnail: '', settings: { intervalMinutes: 5, maxSnapshots: 5 }, directory: '仅内存测试，不写入用户工程' };
const errors = [];

try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
    if (process.env.CANVAS_UNDO_DEBUG === '1') await context.route('**/services/canvasHistory.mjs*', async route => {
        const response = await route.fetch();
        const source = (await response.text()).replace('if (!changes.length) return;', 'if (!changes.length) return; console.log("HISTORY RECORD", JSON.stringify({ key, changes }));').replace('while (entries.length) {', 'console.log("HISTORY UNDO", JSON.stringify(entries)); while (entries.length) {');
        await route.fulfill({ response, body: source });
    });
    await context.addInitScript(() => {
        localStorage.setItem('welcome_notice_seen', 'true');
        window.showDirectoryPicker = () => navigator.storage.getDirectory();
        FileSystemDirectoryHandle.prototype.queryPermission = async () => 'granted';
        FileSystemDirectoryHandle.prototype.requestPermission = async () => 'granted';
    });
    await context.route('**/api/**', route => {
        const request = route.request();
        const endpoint = new URL(request.url()).pathname.replace(/^\/resonantor-canvas/, '');
        if (endpoint === '/api/auth/me') return route.fulfill({ json: { user: { id: 'undo_verification', username: 'undo_verification', role: 'user' } } });
        if (endpoint === '/api/model-settings') return route.fulfill({ json: { revision: 1, settings: { imageProviders: [], videoProviders: [], textProviders: [], audioProviders: [], concurrencyLimit: 3 } } });
        if (endpoint === '/api/canvas-projects') return route.fulfill({ json: { projects: [project], directory: project.directory, warnings: [] } });
        if (endpoint === '/api/canvas-projects/' + project.id) return route.fulfill({ json: { project, data } });
        if (endpoint.endsWith('/snapshots')) {
            data = request.postDataJSON().data;
            project = { ...project, revision: project.revision + 1, updatedAt: Date.now(), lastSavedAt: Date.now() };
            return route.fulfill({ json: { project } });
        }
        return route.fulfill({ status: 503, json: { error: { message: '此测试不请求云端模型、GPU 或用户磁盘。' } } });
    });
    const page = await context.newPage();
    if (process.env.CANVAS_UNDO_DEBUG === '1') page.on('console', message => { if (message.text().startsWith('HISTORY')) console.log(message.text()); });
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    const openFixture = async () => {
        data = structuredClone(initial);
        project = { ...project, revision: project.revision + 10, lastSavedAt: Date.now() };
        await page.goto(process.env.CANVAS_VERIFY_URL || 'http://localhost:3005/', { waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: '最近项目' }).waitFor();
        await page.getByRole('button', { name: 'undo_verification', exact: true }).waitFor();
        await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).some(button => button.textContent === '正在读取…'));
        const choose = page.getByRole('button', { name: '选择工程文件夹', exact: true });
        if (await choose.isVisible()) {
            await choose.click();
            await page.getByRole('button', { name: '更换工程文件夹', exact: true }).waitFor();
        }
        await page.locator('input[type=file][accept=".json,.js"]').setInputFiles({ name: '撤销隔离验收.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(initial)) });
        await page.locator('[data-node-id="undo-first"]').waitFor();
    };
    const snapshot = async () => {
        const download = page.waitForEvent('download');
        await page.getByTitle('导出项目', { exact: true }).click();
        const result = await download;
        return JSON.parse(await fs.readFile(await result.path(), 'utf8'));
    };
    const undo = async () => { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press('Control+z'); };
    const select = async (id, modifiers = []) => {
        const box = await page.locator('[data-node-id="' + id + '"]').boundingBox();
        await page.mouse.click(box.x + box.width - 35, box.y + 12, { modifiers });
    };
    const drag = async (id, deltaX, deltaY) => {
        const box = await page.locator('[data-node-id="' + id + '"]').boundingBox();
        await page.keyboard.down('Alt');
        await page.mouse.move(box.x + box.width - 35, box.y + 12);
        await page.mouse.down();
        for (let step = 1; step <= 15; step += 1) {
            await page.mouse.move(box.x + box.width - 35 + deltaX * step / 15, box.y + 12 + deltaY * step / 15);
            await page.waitForTimeout(20);
        }
        await page.mouse.up();
        await page.keyboard.up('Alt');
    };
    const locate = (snapshot, id) => snapshot.nodes.find(node => node.id === id);

    await openFixture();
    await page.getByTitle('Add Image Node', { exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-node-id]').length === 3);
    await page.waitForTimeout(150);
    await undo();
    assert.equal((await snapshot()).nodes.length, 2, '新建节点后撤销必须删除新节点，不能只回退参数初始化');
    await undo();
    assert.equal((await snapshot()).nodes.length, 2);
    console.log('PASS 新建/撤销一步对应；参数初始化不消耗撤销步骤');

    await openFixture();
    await page.getByTitle('Add Image Node', { exact: true }).click();
    let parametersSnapshot = await snapshot();
    const parameterNode = parametersSnapshot.nodes.find(node => !initial.nodes.some(original => original.id === node.id));
    const parameterPanel = page.locator('[data-node-id="' + parameterNode.id + '"]');
    await parameterPanel.getByText('16:9', { exact: true }).click();
    await parameterPanel.getByText('1:1', { exact: true }).click();
    parametersSnapshot = await snapshot();
    assert.equal(locate(parametersSnapshot, parameterNode.id).params.aspectRatio, '1:1');
    await undo();
    parametersSnapshot = await snapshot();
    assert.equal(locate(parametersSnapshot, parameterNode.id).params.aspectRatio, '16:9');
    await parameterPanel.getByText('16:9', { exact: true }).waitFor();
    await undo();
    assert.equal((await snapshot()).nodes.length, 2);
    console.log('PASS 参数修改可撤销且面板同步，撤销本身不再新增步骤');

    await openFixture();
    await drag('undo-first', 100, 60);
    const firstDrag = await snapshot();
    assert.deepEqual(locate(firstDrag, 'undo-first').position, { x: 320, y: 240 });
    await drag('undo-second', -50, 120);
    const secondDrag = await snapshot();
    assert.deepEqual(locate(secondDrag, 'undo-second').position, { x: 750, y: 380 });
    await select('undo-first');
    await undo();
    let current = await snapshot();
    assert.deepEqual(locate(current, 'undo-second').position, initial.nodes[1].position);
    assert.deepEqual(locate(current, 'undo-first').position, locate(firstDrag, 'undo-first').position);
    await undo();
    current = await snapshot();
    assert.deepEqual(locate(current, 'undo-first').position, initial.nodes[0].position);
    console.log('PASS 连续拖动按次倒退，一次拖动多个鼠标帧只算一步；单击不占步骤');

    await page.getByTitle('Add Audio Node', { exact: true }).click();
    let interleaved = await snapshot();
    const audioId = interleaved.nodes.find(node => node.type === 'audio').id;
    await drag('undo-first', 60, 40);
    await page.getByTitle('Add Video Node', { exact: true }).click();
    interleaved = await snapshot();
    assert.equal(interleaved.nodes.length, 4);
    await undo();
    interleaved = await snapshot();
    assert.equal(interleaved.nodes.length, 3);
    assert.ok(interleaved.nodes.some(node => node.id === audioId));
    assert.deepEqual(locate(interleaved, 'undo-first').position, { x: 280, y: 220 });
    await undo();
    interleaved = await snapshot();
    assert.equal(interleaved.nodes.length, 3);
    assert.deepEqual(locate(interleaved, 'undo-first').position, initial.nodes[0].position);
    await undo();
    assert.equal((await snapshot()).nodes.length, 2);
    console.log('PASS 新建、移动、再新建交错操作严格按逆序撤销');

    await drag('undo-first', 80, 30);
    const beforeResize = await snapshot();
    const handle = await page.locator('[data-node-id="undo-first"] .cursor-se-resize').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 90, handle.y + handle.height / 2 + 50, { steps: 20 });
    await page.mouse.up();
    current = await snapshot();
    assert.equal(locate(current, 'undo-first').width, 350);
    await undo();
    current = await snapshot();
    assert.equal(locate(current, 'undo-first').width, 260);
    assert.deepEqual(locate(current, 'undo-first').position, locate(beforeResize, 'undo-first').position);
    await undo();
    assert.deepEqual(locate(await snapshot(), 'undo-first').position, initial.nodes[0].position);
    console.log('PASS 手动缩放是一整步，不会跳过最近的移动');

    await openFixture();
    const source = await page.locator('[data-node-id="undo-first"] > .cursor-crosshair').last().boundingBox();
    const target = await page.locator('[data-node-id="undo-second"] > .cursor-crosshair').first().boundingBox();
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
    await page.mouse.up();
    assert.equal((await snapshot()).connections.length, 1);
    await select('undo-first');
    await page.keyboard.press('Delete');
    current = await snapshot();
    assert.equal(current.nodes.length, 1);
    assert.equal(current.connections.length, 0);
    await undo();
    current = await snapshot();
    assert.equal(current.nodes.length, 2);
    assert.equal(current.connections.length, 1);
    await undo();
    assert.equal((await snapshot()).connections.length, 0);
    console.log('PASS 删除恢复节点与连线；再撤销才回到连线之前');

    await openFixture();
    await select('undo-first');
    await page.keyboard.down('Shift');
    await select('undo-second');
    await page.keyboard.up('Shift');
    await page.keyboard.press('Control+g');
    current = await snapshot();
    assert.equal(current.groups.length, 1);
    const grouped = current;
    const group = await page.locator('[data-group-id]').boundingBox();
    await page.mouse.move(group.x + group.width / 2, group.y + 15);
    await page.mouse.down();
    await page.mouse.move(group.x + group.width / 2 + 60, group.y + 65, { steps: 20 });
    await page.mouse.up();
    const movedGroup = await snapshot();
    assert.notDeepEqual(movedGroup.groups[0].position, grouped.groups[0].position);
    await undo();
    current = await snapshot();
    assert.deepEqual(current.groups[0].position, grouped.groups[0].position);
    assert.deepEqual(current.nodes.map(node => node.position), grouped.nodes.map(node => node.position));
    await undo();
    current = await snapshot();
    assert.equal(current.groups.length, 0);
    assert.ok(current.nodes.every(node => !node.groupId));
    console.log('PASS 创建分组和整组移动分步撤销，子节点同步复位');

    await openFixture();
    await drag('undo-first', 50, 50);
    const beforeEditing = await snapshot();
    const editor = page.locator('[data-node-id="undo-first"] [contenteditable="true"]');
    await editor.click();
    await page.keyboard.type('hello undo');
    await page.keyboard.press('Control+z');
    current = await snapshot();
    assert.deepEqual(locate(current, 'undo-first').position, locate(beforeEditing, 'undo-first').position);
    assert.equal(current.nodes.length, 2);
    const textarea = page.locator('[data-node-id="undo-first"] textarea').first();
    await textarea.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' more');
    await page.keyboard.press('Control+z');
    current = await snapshot();
    assert.deepEqual(locate(current, 'undo-first').position, locate(beforeEditing, 'undo-first').position);
    console.log('PASS 文本输入与提示词框使用原生撤销，不触发画布历史');

    await openFixture();
    await undo();
    assert.deepEqual((await snapshot()).nodes.map(node => node.position), initial.nodes.map(node => node.position));
    assert.deepEqual(errors, []);
    console.log('PASS 切换/重新打开工程清空撤销历史，无浏览器运行时错误');
    console.log('官网版本撤销浏览器验收完成：隔离账号和浏览器私有测试目录，无用户工程写入、无模型调用。');
} finally { await browser.close(); }
