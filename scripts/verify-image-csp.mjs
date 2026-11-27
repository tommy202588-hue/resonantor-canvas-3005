import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const configuration = fs.readFileSync(new URL('../deploy/web-test-static-security.conf', import.meta.url), 'utf8');
const policy = configuration.match(/Content-Security-Policy "([^"]+)"/)[1];
const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': policy });
    response.end('<!doctype html><title>Image CSP regression</title>');
});
const browser = await chromium.launch({ channel: process.env.CANVAS_VERIFY_BROWSER || 'msedge', headless: true });
try {
    let url = process.env.CANVAS_VERIFY_URL;
    if (!url) {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        url = 'http://127.0.0.1:' + server.address().port;
    }
    const context = await browser.newContext();
    await context.addInitScript(() => {
        window.__imageCspViolations = [];
        document.addEventListener('securitypolicyviolation', event => {
            window.__imageCspViolations.push({ directive: event.effectiveDirective, blocked: event.blockedURI.split(':')[0] });
        });
    });
    await context.route('**/api/**', route => route.fulfill({ status: 401, json: { error: { message: 'Isolated CSP verification' } } }));
    await context.route('**/*.mp4', route => route.abort());
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    const applied = response.headers()['content-security-policy'];
    assert.ok(applied, 'Test must use a real CSP response header');
    const results = await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 4; canvas.height = 4;
        canvas.getContext('2d').fillRect(0, 0, 4, 4);
        const original = new Blob(['local image'], { type: 'image/png' });
        const blobUrl = URL.createObjectURL(original);
        const sources = [['data-jpeg', canvas.toDataURL('image/jpeg')], ['data-png', canvas.toDataURL('image/png')], ['blob-image', blobUrl]];
        const results = [];
        try {
            for (const [name, value] of sources) {
                try {
                    const blob = await (await fetch(value)).blob();
                    results.push({ name, ok: blob.size > 0 && blob.type.startsWith('image/'), type: blob.type });
                } catch (error) { results.push({ name, ok: false, error: error.message }); }
            }
            await new Promise(resolve => setTimeout(resolve, 50));
            return { images: results, violations: window.__imageCspViolations.filter(event => event.directive === 'connect-src') };
        } finally { URL.revokeObjectURL(blobUrl); }
    });
    if (process.argv.includes('--expect-blocked')) {
        assert.ok(results.images.filter(image => image.name.startsWith('data-')).every(image => !image.ok));
        assert.ok(results.violations.some(event => event.blocked === 'data'));
        console.log('REPRODUCED: current connect-src blocks data:image JPEG/PNG fetch', JSON.stringify(results));
    } else {
        assert.ok(results.images.every(image => image.ok), JSON.stringify(results));
        assert.deepEqual(results.violations, []);
        assert.match(applied, /connect-src[^;]*data:/);
        assert.match(applied, /connect-src[^;]*blob:/);
        assert.doesNotMatch(applied.match(/script-src[^;]*/)[0], /data:|blob:|'unsafe-eval'/);
        console.log('PASS JPEG/PNG Base64 and blob image reads under actual CSP, no connect-src violations; script policy unchanged');
    }
} finally {
    await browser.close();
    if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
