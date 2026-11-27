import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createLocalSaveDirectoryService } from './local-save-directory.mjs';

function fixture(context, picker) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-save-test-'));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const output = path.join(root, '自定义 图片');
    fs.mkdirSync(output);
    const config = { settingsFile: path.join(root, 'prefs.json'), platform: 'win32', chooseDirectory: picker || (async () => output) };
    return { root, output, config, service: createLocalSaveDirectoryService(config), owner: randomUUID() };
}

async function call(service, owner, url, { method = 'GET', data, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
    const request = Readable.from(data ? [Buffer.from(data)] : []);
    Object.assign(request, {
        url, method, socket: { remoteAddress, localPort: 3004 },
        headers: { host: 'localhost:3004', origin: 'http://localhost:3004', 'x-canvas-save-client': owner, ...headers },
    });
    let result;
    const response = { statusCode: 0, setHeader: () => {}, end: data => { result = JSON.parse(data); } };
    await service(request, response);
    return { status: response.statusCode, ...result };
}

test('native selection persists and both processed PNGs save to the chosen folder', async context => {
    const setup = fixture(context);
    assert.equal((await call(setup.service, setup.owner, '/directory')).directory, null);
    const chosen = await call(setup.service, setup.owner, '/directory', { method: 'POST' });
    assert.equal(chosen.status, 200);
    assert.equal(chosen.directory.path, setup.output);
    const reloaded = createLocalSaveDirectoryService(setup.config);
    assert.deepEqual((await call(reloaded, setup.owner, '/directory')).directory, chosen.directory);
    for (const filename of ['去背景-result.png', '保真放大-2x-result.png']) {
        const options = { method: 'POST', data: 'image-data', headers: { 'content-type': 'image/png', 'x-canvas-save-directory': chosen.directory.id } };
        assert.equal((await call(reloaded, setup.owner, '/image?filename=' + encodeURIComponent(filename), options)).saved, true);
        assert.equal(fs.readFileSync(path.join(setup.output, filename), 'utf8'), 'image-data');
        assert.equal((await call(reloaded, setup.owner, '/image?filename=' + encodeURIComponent(filename), options)).saved, true);
        assert.equal((await call(reloaded, setup.owner, '/image?filename=' + encodeURIComponent(filename), { ...options, data: 'different' })).status, 409);
    }
});

test('cancelling leaves the previous directory unchanged', async context => {
    const setup = fixture(context);
    const before = await call(setup.service, setup.owner, '/directory', { method: 'POST' });
    const cancelledService = createLocalSaveDirectoryService({ ...setup.config, chooseDirectory: async () => '' });
    assert.equal((await call(cancelledService, setup.owner, '/directory', { method: 'POST' })).cancelled, true);
    assert.deepEqual((await call(cancelledService, setup.owner, '/directory')).directory, before.directory);
});

test('duplicate clicks share one picker and other clients cannot hijack it', async context => {
    let finish;
    let launches = 0;
    const setup = fixture(context, () => { launches += 1; return new Promise(resolve => { finish = resolve; }); });
    const first = call(setup.service, setup.owner, '/directory', { method: 'POST' });
    const second = call(setup.service, setup.owner, '/directory', { method: 'POST' });
    assert.equal((await call(setup.service, randomUUID(), '/directory', { method: 'POST' })).status, 409);
    finish(setup.output);
    assert.deepEqual(await first, await second);
    assert.equal(launches, 1);
});

test('picker failure releases pending state so selection can retry', async context => {
    let attempts = 0;
    const setup = fixture(context, async () => { attempts += 1; if (attempts === 1) throw Object.assign(new Error('timeout'), { killed: true }); return ''; });
    const failure = await call(setup.service, setup.owner, '/directory', { method: 'POST' });
    assert.match(failure.error.message, /超时/);
    assert.equal((await call(setup.service, setup.owner, '/directory', { method: 'POST' })).cancelled, true);
});

test('local access, origin, ownership, directory identity and filename are checked', async context => {
    const setup = fixture(context);
    assert.equal((await call(setup.service, setup.owner, '/directory', { remoteAddress: '192.168.1.10' })).status, 403);
    assert.equal((await call(setup.service, setup.owner, '/directory', { method: 'POST', headers: { origin: 'https://example.com' } })).status, 403);
    assert.equal((await call(setup.service, setup.owner, '/directory', { headers: { host: 'example.com:3004' } })).status, 403);
    const chosen = await call(setup.service, setup.owner, '/directory', { method: 'POST' });
    assert.equal((await call(setup.service, randomUUID(), '/directory')).directory, null);
    const options = { method: 'POST', data: 'image', headers: { 'content-type': 'image/png', 'x-canvas-save-directory': chosen.directory.id } };
    assert.equal((await call(setup.service, randomUUID(), '/image?filename=photo.png', options)).status, 409);
    for (const filename of ['../outside.png', 'C:\\outside.png', 'file:stream.png', 'CON.png', 'script.ps1', 'trailing.png.']) {
        assert.equal((await call(setup.service, setup.owner, '/image?filename=' + encodeURIComponent(filename), options)).status, 400, filename);
    }
    assert.equal((await call(setup.service, setup.owner, '/image?filename=photo.png', options)).saved, true);
});
