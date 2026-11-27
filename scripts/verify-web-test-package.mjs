import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releases = path.join(root, 'web-test-release');
const imageProcessingCalls = [];
const newest = fs.readdirSync(releases, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^\d{8}T\d{6}Z$/.test(entry.name)).map(entry => entry.name).sort().at(-1);
if (!newest) throw new Error('Build a web-test package first.');
const release = path.join(releases, newest);
for (const filename of ['server/upscale-service.mjs', 'server/upscale-workflows.mjs', 'server/upscale-image.py', 'server/generated-image-downloads.mjs']) {
    assert.ok(fs.existsSync(path.join(release, filename)), `Published image-processing dependency is missing: ${filename}`);
}
for (const line of fs.readFileSync(path.join(release, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
    const [digest, filename] = line.split('  ');
    const target = path.resolve(release, filename);
    assert.ok(target.startsWith(release + path.sep));
    assert.equal(createHash('sha256').update(fs.readFileSync(target)).digest('hex'), digest, filename);
}
const { createApiServer, loadConfig } = await import(pathToFileURL(path.join(release, 'server', 'api-server.mjs')).href);
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'resonantor-web-package-test-'));
const password = randomBytes(24).toString('hex');
const api = createApiServer({
    ...loadConfig({}), dataDir: dataDirectory, adminPassword: password,
    publicBasePath: '/resonantor-canvas', sessionCookieName: 'resonantor_canvas_test_session', sessionCookiePath: '/resonantor-canvas', secureCookies: true,
    upscaleService: {
        async middleware(request, response, owner) {
            imageProcessingCalls.push({ path: request.url, owner });
            const body = Buffer.from(JSON.stringify({ owner }));
            response.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
            response.end(body);
        },
        dispose() {},
    },
});
const staticRoot = path.join(release, 'dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png' };
const policy = fs.readFileSync(path.join(release, 'deploy', 'web-test-static-security.conf'), 'utf8').match(/Content-Security-Policy "([^"]+)"/)[1];
const server = http.createServer((request, response) => {
    try {
        const url = new URL(request.url, 'http://localhost');
        if (/^\/resonantor-canvas\/(?:api\/|admin(?:\/|$)|healthz$)/.test(url.pathname)) {
            request.url = request.url.slice('/resonantor-canvas'.length);
            api.emit('request', request, response);
            return;
        }
        const decoded = decodeURIComponent(url.pathname);
        const filename = decoded === '/resonantor-canvas/index.html' || decoded === '/resonantor-canvas/' ? 'index.html' : decoded.startsWith('/resonantor-canvas/') ? decoded.slice('/resonantor-canvas/'.length) : '';
        const target = path.resolve(staticRoot, filename);
        if (!filename || !target.startsWith(staticRoot + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { response.writeHead(404).end('Not found'); return; }
        response.writeHead(200, { 'content-type': types[path.extname(target)] || 'application/octet-stream', 'content-security-policy': policy, 'x-content-type-options': 'nosniff' });
        fs.createReadStream(target).pipe(response);
    } catch { response.writeHead(500).end('Package verification server failed'); }
});

try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://localhost:' + server.address().port;
    const titleMask = await fetch(base + '/resonantor-canvas/brand/home-title-mask.png');
    assert.equal(titleMask.status, 200);
    assert.match(titleMask.headers.get('content-type'), /^image\/png/);
    assert.deepEqual(Buffer.from(await titleMask.arrayBuffer()).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal((await fetch(base + '/resonantor-canvas/healthz')).status, 200);
    const login = await fetch(base + '/resonantor-canvas/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username: 'admin', password }) });
    assert.equal(login.status, 200);
    const cookieHeader = login.headers.get('set-cookie');
    assert.match(cookieHeader, /^resonantor_canvas_test_session=/);
    assert.match(cookieHeader, /Path=\/resonantor-canvas(?:;|$)/);
    assert.match(cookieHeader, /Secure/);
    assert.match(cookieHeader, /HttpOnly/);
    const cookie = cookieHeader.split(';')[0];
    const clientId = '9cb93ae8-2f11-4bc2-999f-9fb8b54fb9b9';
    assert.equal((await fetch(base + '/resonantor-canvas/api/upscale/runtime', { headers: { 'x-upscale-client': clientId } })).status, 401);
    const runtime = await fetch(base + '/resonantor-canvas/api/upscale/runtime', { headers: { cookie, 'x-upscale-client': clientId } });
    assert.equal(runtime.status, 200);
    const imageOwner = (await runtime.json()).owner;
    assert.match(imageOwner, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(imageOwner, clientId);
    assert.deepEqual(imageProcessingCalls.map(call => call.path), ['/api/upscale/runtime']);
    const settings = await fetch(base + '/resonantor-canvas/api/model-settings', { headers: { cookie } });
    assert.equal(settings.status, 200);
    assert.ok(Array.isArray((await settings.json()).settings.imageProviders));
    for (const endpoint of ['/admin', '/admin/models', '/admin/gpu']) {
        const response = await fetch(base + '/resonantor-canvas' + endpoint);
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.match(text, /fetch\('\/resonantor-canvas\/api\//);
        assert.doesNotMatch(text, /fetch\('\/api\//);
    }
    assert.equal((await fetch(base + '/resonantor-canvas/api/admin/overview')).status, 401);
    assert.equal((await fetch(base + '/resonantor-canvas/api/canvas-projects', { headers: { cookie } })).status, 404);
    console.log('PASS 发布包校验、隔离图像后端、登录门禁、任务用户隔离、私有 cookie 路径');
    for (const script of ['verify-image-csp.mjs', 'verify-browser-projects.mjs', 'verify-canvas-undo.mjs', 'verify-canvas-download.mjs']) {
        const child = spawn(process.execPath, [path.join(root, 'scripts', script)], { cwd: root, env: { ...process.env, CANVAS_VERIFY_URL: base + '/resonantor-canvas/' }, stdio: 'inherit', windowsHide: true });
        const [code] = await once(child, 'exit');
        assert.equal(code, 0, 'Hosted-path browser verification failed: ' + script);
    }
    console.log('PASS 网站测试入口、子路径资源及 CSP 下的保存、撤销和图片下载流程');
} finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const checked = path.resolve(dataDirectory);
    const temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!checked.startsWith(temporaryRoot) || !path.basename(checked).startsWith('resonantor-web-package-test-')) throw new Error('Refusing to remove unexpected test directory.');
    fs.rmSync(checked, { recursive: true, force: true });
}
