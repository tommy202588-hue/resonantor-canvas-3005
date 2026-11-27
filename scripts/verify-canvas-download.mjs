import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const browser = await chromium.launch({ channel: process.env.CANVAS_VERIFY_BROWSER || 'msedge', headless: true });
const verificationUrl = process.env.CANVAS_VERIFY_URL || 'http://localhost:3005/';
const verificationOrigin = new URL(verificationUrl).origin;
const imageUrl = 'https://generated-cdn.invalid/result.png?signature=fixture';
const provider = { id: 'download-test', name: '隔离图片模型', type: 'openai', baseUrl: 'https://model.invalid/v1', apiKey: 'managed:download-test', isDefault: true, models: [{ id: 'gpt-image-1', displayName: '下载测试' }] };
let requests = 0;
let proxyReads = 0;
let blocked = false;
let base64Result = false;
const errors = [];
const violations = [];
const downloads = [];

try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, acceptDownloads: true });
    await context.addInitScript(() => {
        localStorage.setItem('welcome_notice_seen', 'true');
        document.addEventListener('securitypolicyviolation', event => {
            if (event.effectiveDirective === 'connect-src') window.reportImageCspViolation(event.blockedURI.split(':')[0]);
        });
        window.showDirectoryPicker = async options => {
            const root = await navigator.storage.getDirectory();
            return options.id === 'x-tapnow-generated-images' ? root.getDirectoryHandle('download-verification', { create: true }) : root;
        };
        FileSystemDirectoryHandle.prototype.queryPermission = async () => window.__revokeImageFolder && 'prompt' || 'granted';
        FileSystemDirectoryHandle.prototype.requestPermission = async () => 'granted';
    });
    const page = await context.newPage();
    await page.exposeFunction('reportImageCspViolation', scheme => violations.push(scheme));
    let image;
    page.on('pageerror', error => errors.push(error.message));
    if (process.env.CANVAS_DOWNLOAD_DEBUG === '1') page.on('console', message => console.log(message.text()));
    page.on('dialog', dialog => dialog.accept());
    page.on('download', download => {
        downloads.push(download);
        if (process.env.CANVAS_DOWNLOAD_DEBUG === '1') console.log('DOWNLOAD', requests, download.suggestedFilename());
    });
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== verificationOrigin) return route.abort();
        const endpoint = url.pathname.replace(/^\/resonantor-canvas/, '');
        if (!endpoint.startsWith('/api/')) return route.continue();
        if (endpoint === '/api/auth/me') return route.fulfill({ json: { user: { id: 'download-test', username: 'download-test', role: 'user' } } });
        if (endpoint === '/api/model-settings') return route.fulfill({ json: { revision: 1, settings: { imageProviders: [provider], videoProviders: [], textProviders: [], audioProviders: [], defaultImageProvider: provider.id, concurrencyLimit: 1 } } });
        if (endpoint === '/api/model-request') {
            if (process.env.CANVAS_DOWNLOAD_DEBUG === '1') console.log('MODEL REQUEST', route.request().postDataJSON().targetUrl);
            requests += 1;
            return route.fulfill({ json: { data: [base64Result ? { b64_json: image.toString('base64') } : { url: imageUrl }] } });
        }
        if (endpoint === '/api/openai-download-proxy') {
            proxyReads += 1;
            assert.equal(url.searchParams.get('url'), imageUrl);
            return blocked ? route.fulfill({ status: 403, json: { error: { type: 'target_not_allowed' } } }) : route.fulfill({ contentType: 'image/png', body: image });
        }
        return route.fulfill({ status: 503, json: { error: { message: '隔离测试不访问真实服务' } } });
    });
    await page.goto(verificationUrl, { waitUntil: 'domcontentloaded' });
    image = Buffer.from(await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 4; canvas.height = 4;
        canvas.getContext('2d').fillRect(0, 0, 4, 4);
        return canvas.toDataURL('image/png').split(',')[1];
    }), 'base64');
    await page.getByRole('button', { name: 'download-test', exact: true }).waitFor();
    await page.getByRole('button', { name: '选择工程文件夹', exact: true }).click();
    await page.getByRole('button', { name: '更换工程文件夹', exact: true }).waitFor();
    const initial = { version: 1, viewport: { x: 0, y: 0, k: 1 }, connections: [], groups: [], nodes: [{ id: 'download-node', type: 'image', title: '下载验证', prompt: 'test image', position: { x: 350, y: 180 }, width: 340, height: 340, status: 'idle', providerId: provider.id, modelId: 'gpt-image-1', params: { model: 'gpt-image-1', aspectRatio: '1:1', resolution: '1k' } }] };
    await page.locator('input[type=file][accept=".json,.js"]').setInputFiles({ name: '下载隔离验收.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(initial)) });
    const node = page.locator('[data-node-id="download-node"]');
    await node.waitFor();
    const bounds = await node.boundingBox();
    await page.mouse.click(bounds.x + bounds.width - 35, bounds.y + 12);
    const generate = node.getByRole('button', { name: 'Generate', exact: true });
    const firstDownload = page.waitForEvent('download');
    await generate.click();
    const first = await firstDownload;
    assert.match(first.suggestedFilename(), /\.png$/);
    assert.ok((await fs.readFile(await first.path())).length > 0);
    assert.equal(requests, 1);
    assert.equal(proxyReads, 1);
    assert.equal(await page.getByRole('dialog', { name: '图片保存设置' }).count(), 0);
    console.log('PASS 远程图片经官网子路径代理生成真实 PNG 下载，无失败弹窗、无重复模型请求');

    await page.getByTitle('图片保存设置（默认浏览器下载）', { exact: true }).click();
    await generate.click();
    await page.waitForFunction(async () => {
        const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('download-verification');
        for await (const entry of folder.values()) if (entry.kind === 'file' && (await entry.getFile()).size > 0) return true;
        return false;
    });
    await page.getByTitle('保存到：download-verification', { exact: true }).locator('.animate-pulse').waitFor({ state: 'hidden' });
    await page.waitForTimeout(600);
    assert.equal(downloads.length, 1);
    assert.equal(requests, 2);
    console.log('PASS 选择文件夹后图片实际写入，不重复触发浏览器下载');

    await page.evaluate(() => { window.__revokeImageFolder = true; });
    const fallbackDownload = page.waitForEvent('download');
    await generate.click();
    await fallbackDownload;
    assert.equal(requests, 3);
    assert.equal(await page.getByRole('dialog', { name: '图片保存设置' }).count(), 0);
    console.log('PASS 文件夹权限失效时回退浏览器下载，不弹后台权限窗口');

    base64Result = true;
    await page.waitForTimeout(600);
    const readsBeforeBase64 = proxyReads;
    const base64Download = page.waitForEvent('download');
    await generate.click();
    const generated = await base64Download;
    assert.ok((await fs.readFile(await generated.path())).length > 0);
    assert.equal(proxyReads, readsBeforeBase64);
    assert.equal(requests, 4);
    assert.equal(await page.getByRole('dialog', { name: '图片保存设置' }).count(), 0);
    assert.deepEqual(violations, []);
    console.log('PASS Base64 生成结果在实际 CSP 下正常读取和下载，无代理请求和安全策略拦截');

    base64Result = false;
    blocked = true;
    await page.waitForTimeout(600);
    await generate.click();
    const failure = page.getByRole('dialog', { name: '图片保存设置' });
    await failure.waitFor();
    assert.match(await failure.textContent(), /未获服务器授权/);
    assert.equal(requests, 5);
    assert.equal(downloads.length, 3);
    assert.deepEqual(errors, []);
    assert.deepEqual(violations, []);
    console.log('PASS 真正下载失败保留图片和具体错误，不伪装成功、不自动重试付费生成');
} finally { await browser.close(); }
