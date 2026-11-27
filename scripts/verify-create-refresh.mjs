import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
    const context = await browser.newContext();
    await context.route('**/api/**', route => route.fulfill({ status: 401, json: { error: { message: 'isolated test' } } }));
    const page = await context.newPage();
    await page.goto('http://192.168.0.228:3005/');
    const result = await page.evaluate(async () => {
        const { default: React } = await import('/node_modules/.vite/deps/react.js');
        const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
        const Refresh = await import('/@react-refresh');
        const { useCanvasProjects } = await import('/services/useCanvasProjects.ts');
        const data = { version: 1, nodes: [], connections: [] };
        let workspace; let shown = 0;
        const noop = () => {}; const snapshot = () => data;
        function Before() {
            workspace = useCanvasProjects(data, snapshot, noop, () => shown++, noop, true, 'create-refresh-fixture');
            return React.createElement('span', null, workspace.busy ? 'busy' : 'idle');
        }
        function After() {
            workspace = useCanvasProjects(data, snapshot, noop, () => shown++, noop, true, 'create-refresh-fixture');
            return React.createElement('span', null, workspace.busy ? 'busy' : 'idle');
        }
        const until = async fn => { for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('harness wait timed out'); };
        const element = document.createElement('div'); document.body.append(element);
        const root = ReactDOM.createRoot(element);
        Refresh.register(Before, 'create-refresh-harness'); root.render(React.createElement(Before));
        await until(() => workspace && !workspace.loading);
        const realGet = IDBObjectStore.prototype.get;
        let release; let started = false;
        IDBObjectStore.prototype.get = function (key) {
            if (!String(key).startsWith('gzt-browser-projects-v1:create-refresh-fixture:')) return realGet.call(this, key);
            IDBObjectStore.prototype.get = realGet;
            const request = realGet.call(this, key);
            const store = this; let holding = true; let callback;
            store.transaction.addEventListener('abort', () => { holding = false; });
            const keepAlive = () => {
                if (!holding) return;
                const pending = realGet.call(store, 'keepalive');
                pending.addEventListener('success', keepAlive);
                pending.addEventListener('error', event => event.preventDefault());
            };
            request.addEventListener('success', () => { started = true; keepAlive(); });
            release = () => { holding = false; try { callback?.(); } catch {} };
            return { get result() { return request.result; }, set onerror(fn) { request.onerror = fn; }, set onsuccess(fn) { callback = fn; } };
        };
        const pending = workspace.create('中断的创建');
        await until(() => started && workspace.busy);
        Refresh.register(After, 'create-refresh-harness');
        Refresh.validateRefreshBoundaryAndEnqueueUpdate('create-refresh-harness', { Harness: Before }, { Harness: After });
        await new Promise(r => setTimeout(r, 100));
        release(); await pending;
        await new Promise(r => setTimeout(r, 100));
        const stuck = workspace.busy;
        const retried = await workspace.create('重新创建成功');
        await new Promise(r => setTimeout(r, 100));
        const outcome = { stuck, retried, shown, activeName: workspace.active?.name };
        root.unmount(); element.remove();
        return outcome;
    });
    console.log(JSON.stringify(result));
    assert.equal(result.stuck, false);
    assert.equal(result.retried, true);
    assert.equal(result.activeName, '重新创建成功');
    assert.equal(result.shown, 1);
    console.log('PASS creation interrupted by Fast Refresh releases busy state and a second creation opens the canvas');

    const uiContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await uiContext.route('**/api/**', route => {
        const endpoint = new URL(route.request().url()).pathname;
        if (endpoint === '/api/auth/me') return route.fulfill({ json: { user: { id: 'create-ui', username: 'create-ui', role: 'user' } } });
        if (endpoint === '/api/model-settings') return route.fulfill({ json: { revision: 1, settings: { imageProviders: [], videoProviders: [], textProviders: [], audioProviders: [], concurrencyLimit: 15 } } });
        if (endpoint === '/api/auth/wechat/config') return route.fulfill({ json: { enabled: false } });
        return route.fulfill({ status: 503, json: { error: { message: 'isolated test' } } });
    });
    await uiContext.addInitScript(() => localStorage.setItem('welcome_notice_seen', 'true'));
    const ui = await uiContext.newPage();
    ui.on('dialog', dialog => dialog.accept());
    await ui.goto('http://192.168.0.228:3005/');
    await ui.getByRole('button', { name: '刷新项目 ↻', exact: true }).waitFor();
    await ui.getByRole('button', { name: '新建工程', exact: true }).click();
    const dialog = ui.getByRole('dialog', { name: '新建工程', exact: true });
    await dialog.getByLabel('工程名称').fill('浏览器写入恢复');
    await ui.evaluate(() => {
        const get = IDBObjectStore.prototype.get;
        IDBObjectStore.prototype.get = function (key) {
            if (!String(key).startsWith('gzt-browser-projects-v1:create-ui:')) return get.call(this, key);
            IDBObjectStore.prototype.get = get;
            const store = this; let aborted = false;
            window.__createAborted = false;
            store.transaction.addEventListener('abort', () => { aborted = true; window.__createAborted = true; });
            const keepAlive = () => {
                if (aborted) return;
                const request = get.call(store, 'create-keepalive');
                request.addEventListener('success', keepAlive);
                request.addEventListener('error', event => event.preventDefault());
            };
            keepAlive(); return {};
        };
    });
    await dialog.getByRole('button', { name: '创建并打开', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: '正在等待浏览器写入工程' }).waitFor();
    await dialog.getByRole('alert').filter({ hasText: '浏览器工程存储未响应' }).waitFor({ timeout: 25_000 });
    assert.equal(await dialog.getByRole('button', { name: '创建并打开', exact: true }).isEnabled(), true);
    await ui.waitForFunction(() => window.__createAborted);
    const count = await ui.evaluate(async () => {
        const { getProjectKeys } = await import('/services/projectStorageUpdate.mjs');
        return (await getProjectKeys()).filter(key => String(key).startsWith('gzt-browser-projects-v1:create-ui:')).length;
    });
    assert.equal(count, 0, 'Timed-out creation must not commit an incomplete or late project');
    await dialog.getByRole('button', { name: '创建并打开', exact: true }).click();
    await ui.locator('[data-project-auto-save]').waitFor();
    await ui.getByTitle('保存工程并返回首页').click();
    await ui.getByRole('button', { name: '打开工程：浏览器写入恢复', exact: true }).waitFor();
    await ui.reload();
    await ui.getByRole('button', { name: '打开工程：浏览器写入恢复', exact: true }).click();
    await ui.locator('[data-project-auto-save]').waitFor();
    console.log('PASS actual create dialog shows storage stage, cancels stalled writes within 20 seconds, retries and reopens after reload');
} finally { await browser.close(); }
