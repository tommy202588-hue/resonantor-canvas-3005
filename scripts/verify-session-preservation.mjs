import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const site = process.env.CANVAS_VERIFY_URL || 'http://127.0.0.1:3016/resonantor-canvas/';
const outputPrefix = process.env.CANVAS_VERIFY_OUTPUT_PREFIX || '';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const provider = { id: 'session-fixture', name: '隔离模型', type: 'openai', baseUrl: 'https://model.invalid/v1', apiKey: 'managed:session-fixture', hasApiKey: true, isDefault: true, models: [{ id: 'gpt-image-1', displayName: '隔离模型' }] };
const user = name => ({ id: name, username: name, displayName: name, role: 'user' });
const passes = [];
const errors = [];
let completed = false;
const pass = message => { passes.push(message); console.log('PASS ' + message); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture({ anonymous = false, firstAuthFailure, browserStorage = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, acceptDownloads: true });
    const state = { user: anonymous ? null : user('session_alice'), authCalls: 0, modelCalls: 0, settingsCalls: 0, autoSaves: 0, blockFurtherAuth: false, settingsReply: null, settingsHold: null, modelReply: null, modelHold: null, image: '', loginUser: null };
    await context.addInitScript(({ browserStorage }) => {
        localStorage.setItem('welcome_notice_seen', 'true');
        window.showDirectoryPicker = browserStorage ? undefined : () => navigator.storage.getDirectory();
        FileSystemDirectoryHandle.prototype.queryPermission = async () => 'granted';
        FileSystemDirectoryHandle.prototype.requestPermission = async () => 'granted';
        const originalInterval = window.setInterval;
        window.setInterval = (callback, duration, ...args) => {
            if (duration >= 60_000 && duration <= 7_200_000) window.__saveProject = callback;
            return originalInterval(callback, duration, ...args);
        };
        window.__imageFingerprint = async source => {
            const bytes = await (await fetch(source)).arrayBuffer();
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            return { bytes: bytes.byteLength, sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') };
        };
        window.__readSnapshots = async () => {
            const records = [];
            const root = await navigator.storage.getDirectory();
            let projects;
            try { projects = await root.getDirectoryHandle('共智体画布工程'); } catch { return records; }
            for await (const [account, folder] of projects.entries()) {
                if (folder.kind !== 'directory') continue;
                for await (const [id, project] of folder.entries()) {
                    await navigator.locks.request('gzt-project-directory:' + id, async () => {
                        const metadata = JSON.parse(await (await (await project.getFileHandle('project.json')).getFile()).text());
                        const last = metadata.snapshots[0];
                        const text = await (await (await project.getFileHandle(last.filename)).getFile()).text();
                        const data = JSON.parse(text.replace(/^export default /, '').replace(/;\s*$/, ''));
                        records.push({ account, metadata, data });
                    });
                }
            }
            return records;
        };
    }, { browserStorage });
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(site).origin) return route.abort();
        const endpoint = url.pathname.replace(/^\/resonantor-canvas/, '');
        if (!endpoint.startsWith('/api/')) return url.pathname.endsWith('.mp4') ? route.abort() : route.continue();
        if (endpoint === '/api/auth/me') {
            state.authCalls += 1;
            if (state.blockFurtherAuth || firstAuthFailure === 'network' && state.authCalls === 1) return route.abort('failed');
            if (firstAuthFailure === '502' && state.authCalls === 1) return route.fulfill({ status: 502, contentType: 'text/html', body: 'Bad Gateway' });
            return state.user ? route.fulfill({ json: { user: state.user } }) : route.fulfill({ status: 401, json: { error: { type: 'login_required', message: '请先登录' } } });
        }
        if (endpoint === '/api/auth/login' || endpoint === '/api/auth/register') {
            state.user = state.loginUser || user(route.request().postDataJSON().username);
            return route.fulfill({ json: { user: state.user } });
        }
        if (endpoint === '/api/auth/logout') { state.user = null; return route.fulfill({ json: { ok: true } }); }
        if (endpoint === '/api/auth/wechat/config') return route.fulfill({ json: { enabled: false } });
        if (endpoint === '/api/model-settings') {
            state.settingsCalls += 1;
            const reply = state.settingsReply;
            const hold = state.settingsHold;
            state.settingsReply = null;
            state.settingsHold = null;
            if (hold) { hold.started.resolve(); await hold.release.promise; }
            if (reply === 'network') return route.abort('failed');
            if (reply === '502') return route.fulfill({ status: 502, contentType: 'text/html', body: 'Bad Gateway' });
            if (reply) return route.fulfill(reply).catch(() => {});
            return route.fulfill({ json: { revision: 1, settings: { imageProviders: [provider], videoProviders: [], textProviders: [], audioProviders: [], defaultImageProvider: provider.id, concurrencyLimit: 1 } } });
        }
        if (endpoint === '/api/model-request') {
            state.modelCalls += 1;
            const reply = state.modelReply;
            const hold = state.modelHold;
            if (reply !== 'network') state.modelReply = null;
            state.modelHold = null;
            if (hold) { hold.started.resolve(); await hold.release.promise; }
            if (reply === 'network') return route.abort('timedout');
            return route.fulfill(reply || { json: { data: [{ b64_json: state.image }] } }).catch(() => {});
        }
        throw new Error('Unexpected API request: ' + endpoint);
    });
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    const initialAuthCheck = new Promise(resolve => {
        const complete = request => {
            if (!new URL(request.url()).pathname.endsWith('/api/auth/me')) return;
            page.off('requestfinished', complete);
            page.off('requestfailed', complete);
            resolve();
        };
        page.on('requestfinished', complete);
        page.on('requestfailed', complete);
    });
    await page.goto(site, { waitUntil: 'domcontentloaded' });
    state.image = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 4; canvas.height = 4;
        canvas.getContext('2d').fillRect(0, 0, 4, 4);
        return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.getByRole('heading', { name: '最近项目', exact: true }).waitFor();
    await initialAuthCheck;
    if (state.user && !firstAuthFailure) await page.getByRole('button', { name: state.user.username, exact: true }).waitFor();
    const importProject = async (id = 'session-node', name = 'session-project') => {
        if (!browserStorage) {
            const choose = page.getByRole('button', { name: '选择工程文件夹', exact: true });
            if (await choose.count()) {
                await choose.click();
                await page.getByRole('button', { name: '更换工程文件夹', exact: true }).waitFor();
            }
        }
        const initial = { version: 1, viewport: { x: 0, y: 0, k: 1 }, connections: [], groups: [], nodes: [{ id, type: 'image', title: '隔离验收图片', prompt: 'session fixture', position: { x: 350, y: 180 }, width: 340, height: 340, status: 'idle', providerId: provider.id, modelId: 'gpt-image-1', params: { model: 'gpt-image-1', aspectRatio: '1:1', resolution: '1k' } }] };
        await page.locator('input[type=file][accept=".json,.js"]').setInputFiles({ name: name + '.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(initial)) });
        const node = page.locator('[data-node-id="' + id + '"]');
        await node.waitFor();
        const bounds = await node.boundingBox();
        await page.mouse.click(bounds.x + bounds.width - 35, bounds.y + 12);
        return node;
    };
    const canvasRetained = async id => {
        await page.locator('[data-node-id="' + id + '"]').waitFor({ state: 'visible' });
        assert.equal(await page.locator('[data-node-id="' + id + '"]').isVisible(), true);
        assert.equal(await page.getByRole('heading', { name: '最近项目', exact: true }).count(), 0);
        assert.equal(await page.getByRole('dialog').count(), 0);
    };
    const pulse = () => page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    const save = async () => {
        await page.getByRole('button', { name: 'Auto save', exact: true }).click();
        await page.getByRole('button', { name: '立即保存', exact: true }).click();
        await page.getByRole('status').filter({ hasText: '工程已' }).waitFor();
        await page.keyboard.press('Escape');
    };
    const signIn = async name => {
        const dialog = page.getByRole('dialog', { name: '登录共智体', exact: true });
        await dialog.getByLabel('用户名', { exact: true }).fill(name);
        await dialog.getByLabel('密码', { exact: true }).fill('IsolatedTestPassword!');
        await dialog.getByRole('button', { name: '登录', exact: true }).click();
    };
    return { context, page, state, importProject, canvasRetained, pulse, save, signIn };
}

try {
    for (const initialFailure of ['502', 'network']) {
        const test = await fixture({ firstAuthFailure: initialFailure });
        await test.page.getByRole('button', { name: '新建工程', exact: true }).click();
        await test.page.getByRole('dialog', { name: '新建工程', exact: true }).waitFor();
        assert.equal(test.state.authCalls, 2);
        await test.context.close();
    }
    pass('首次账号恢复失败可由用户主动登录重试，不循环检查或重置页面');

    if (!process.env.CANVAS_VERIFY_SESSION_ONLY) {
    if (!process.env.CANVAS_VERIFY_SKIP_LONG) {
        const test = await fixture();
        const node = await test.importProject();
        const generate = node.getByRole('button', { name: 'Generate', exact: true });
        const hold = { started: deferred(), release: deferred() };
        test.state.modelHold = hold;
        test.state.blockFurtherAuth = true;
        const download = test.page.waitForEvent('download', { timeout: 50_000 });
        await generate.click();
        await hold.started.promise;
        test.state.settingsReply = '502';
        await test.pulse();
        await test.page.waitForTimeout(31_000);
        await test.canvasRetained('session-node');
        assert.equal(test.state.authCalls, 1);
        assert.equal(test.state.modelCalls, 1);
        hold.release.resolve();
        await download;
        await node.locator('img').first().waitFor();
        const generated = await node.locator('img').first().evaluate(image => window.__imageFingerprint(image.currentSrc || image.src));
        await test.save();
        const records = await test.page.evaluate(() => window.__readSnapshots());
        const savedNode = records[0].data.nodes[0];
        assert.equal(savedNode.status, 'success');
        const savedImage = savedNode.blobData || savedNode.allBlobsData?.[0];
        assert.match(savedImage, /^data:image\/png;base64,/);
        assert.deepEqual(await test.page.evaluate(source => window.__imageFingerprint(source), savedImage), generated);
        await test.page.screenshot({ path: path.resolve(outputPrefix + 'session-retained.png') });
        await test.page.getByTitle('保存工程并返回首页').click();
        await test.page.getByRole('button', { name: '打开工程：session-project' }).click();
        await test.canvasRetained('session-node');
        await test.page.waitForFunction(() => [...document.querySelectorAll('[data-node-id="session-node"] img')].some(image => image.complete && image.naturalWidth > 0));
        assert.deepEqual(await node.locator('img').first().evaluate(image => window.__imageFingerprint(image.currentSrc || image.src)), generated);
        assert.equal(test.state.authCalls, 1);
        await test.context.close();
        pass('生图超过 30 秒、切换窗口、配置 502 均不检查登录；结果回填原节点并可保存、重新打开');
    }

    {
        const test = await fixture();
        const node = await test.importProject();
        const generate = node.getByRole('button', { name: 'Generate', exact: true });
        for (const response of [{ status: 401, json: { error: { type: 'model_upstream_error', message: '上游密钥配置错误' } } }, { status: 429, json: { error: { type: 'model_upstream_error', message: '上游限流' } } }, { status: 502, json: { error: { type: 'model_upstream_error', message: '上游不可用' } } }, 'network']) {
            const before = test.state.modelCalls;
            console.log('CHECK 上游异常 ' + (response.status || response));
            test.state.modelReply = response;
            await generate.click();
            await node.getByText('Generation Failed', { exact: true }).waitFor();
            await test.canvasRetained('session-node');
            assert.equal(await test.page.getByRole('button', { name: '重新登录', exact: true }).count(), 0);
            if (response !== 'network') assert.equal(test.state.modelCalls, before + 1);
            else assert.ok(test.state.modelCalls > before);
            assert.equal(test.state.authCalls, 1);
        }
        await test.context.close();
    }
    pass('上游 401／429／502 和持续连接超时只报节点错误，不退工程、不误报登录；HTTP 错误没有重复请求');

    {
        const test = await fixture();
        const node = await test.importProject();
        const hold = { started: deferred(), release: deferred() };
        test.state.modelHold = hold;
        const download = test.page.waitForEvent('download');
        await node.getByRole('button', { name: 'Generate', exact: true }).click();
        await hold.started.promise;
        test.state.settingsReply = { status: 401, json: { error: { type: 'login_required', message: '登录已过期' } } };
        await test.pulse();
        await test.page.getByRole('button', { name: '重新登录', exact: true }).waitFor();
        await test.canvasRetained('session-node');
        await test.save();
        test.state.user = null;
        test.state.loginUser = user('session_alice');
        await test.page.getByRole('button', { name: '重新登录', exact: true }).click();
        await test.signIn('session_alice');
        await test.page.getByRole('dialog').waitFor({ state: 'hidden' });
        await test.canvasRetained('session-node');
        assert.equal(await test.page.getByRole('button', { name: '重新登录', exact: true }).count(), 0);
        assert.equal(test.state.modelCalls, 1);
        hold.release.resolve();
        await download;
        await node.locator('img').first().waitFor();
        await test.canvasRetained('session-node');
        await test.context.close();
    }
    pass('真实网站登录过期仅显示提示，本地保存和已提交任务继续；同账号重新登录不重建画布');

    {
        const test = await fixture();
        const node = await test.importProject();
        test.state.modelReply = { status: 401, json: { error: { type: 'login_required', message: '网站登录已过期' } } };
        await node.getByRole('button', { name: 'Generate', exact: true }).click();
        await node.getByText('Generation Failed', { exact: true }).waitFor();
        await test.page.getByRole('button', { name: '重新登录', exact: true }).waitFor();
        await test.canvasRetained('session-node');
        await test.save();
        await test.page.getByRole('button', { name: '重新登录', exact: true }).click();
        await test.page.getByRole('dialog').waitFor({ state: 'hidden' });
        await test.canvasRetained('session-node');
        assert.equal(test.state.modelCalls, 1);
        await test.context.close();
    }
    pass('生成接口明确返回网站登录失效时保留节点与工程，用户恢复登录不自动重发生成请求');

    {
        const test = await fixture();
        const node = await test.importProject();
        const hold = { started: deferred(), release: deferred() };
        test.state.settingsReply = { status: 401, json: { error: { type: 'login_required', message: '旧请求过期' } } };
        test.state.settingsHold = hold;
        await test.pulse();
        await hold.started.promise;
        await test.page.getByTitle('保存工程并返回首页').click();
        await test.page.getByRole('button', { name: 'session_alice', exact: true }).click();
        await test.page.getByRole('dialog', { name: '已登录', exact: true }).getByRole('button', { name: '关闭登录窗口' }).click();
        hold.release.resolve();
        await test.page.waitForTimeout(300);
        assert.equal(await test.page.getByRole('button', { name: '重新登录', exact: true }).count(), 0);
        await test.page.getByRole('button', { name: '打开工程：session-project' }).click();
        await test.canvasRetained('session-node');
        await test.context.close();
    }
    pass('重新登录前发出的旧请求晚到 401，不覆盖当前账号状态');

    {
        const test = await fixture();
        const node = await test.importProject();
        await test.page.getByTitle('保存工程并返回首页').click();
        const logout = async name => {
            await test.page.getByRole('button', { name, exact: true }).click();
            await test.page.getByRole('dialog', { name: '已登录', exact: true }).getByRole('button', { name: '退出登录', exact: true }).click();
            await test.page.getByRole('dialog', { name: '登录共智体' }).waitFor();
        };
        await logout('session_alice');
        await test.signIn('session_bob');
        await test.page.getByRole('dialog', { name: '已登录', exact: true }).getByRole('button', { name: '关闭登录窗口' }).click();
        await test.page.getByRole('button', { name: 'session_bob', exact: true }).waitFor();
        assert.equal(await test.page.locator('[data-project-id]').count(), 0);
        await test.importProject('bob-node', 'bob-project');
        await test.page.getByTitle('保存工程并返回首页').click();
        await logout('session_bob');
        await test.signIn('session_alice');
        await test.page.getByRole('dialog', { name: '已登录', exact: true }).getByRole('button', { name: '关闭登录窗口' }).click();
        await test.page.getByRole('button', { name: '打开工程：session-project' }).click();
        await test.canvasRetained('session-node');
        assert.equal(await test.page.locator('[data-node-id="bob-node"]').count(), 0);
        const records = await test.page.evaluate(() => window.__readSnapshots());
        assert.equal(new Set(records.map(record => record.account)).size, 2);
        await test.context.close();
    }
    pass('主动退出与重新登录仍生效，不同账号的工程及目录互相隔离');

    {
        const test = await fixture({ browserStorage: true });
        const node = await test.importProject('browser-node', 'browser-project');
        const download = test.page.waitForEvent('download');
        await node.getByRole('button', { name: 'Generate', exact: true }).click();
        await download;
        await test.save();
        await test.page.getByTitle('保存工程并返回首页').click();
        await test.page.getByRole('button', { name: '打开工程：browser-project' }).click();
        await test.canvasRetained('browser-node');
        await test.context.close();
    }
    pass('无文件夹接口的浏览器也能生成、保存和重新打开工程');
    }
    assert.deepEqual(errors, []);
    completed = true;
} finally {
    await browser.close();
    fs.writeFileSync(path.resolve(outputPrefix + 'session-verification.json'), JSON.stringify({ site, completed, fullRun: !process.env.CANVAS_VERIFY_SKIP_LONG, finishedAt: new Date().toISOString(), passes, pageErrors: errors }, null, 2) + '\n');
}
