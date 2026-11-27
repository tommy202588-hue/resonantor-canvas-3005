import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createCanvasAccessMiddleware, loadConfig } from './api-server.mjs';
import { createModelSettingsStore, emptyModelSettings, normalizeModelSettings } from './model-settings.mjs';
import { resolveModelRequest } from './model-request.mjs';
import { prepareManagedRequest } from '../services/modelTransport.mjs';

const provider = (overrides = {}) => ({ id: 'test-image', name: 'Test model service', type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'test-server-secret-not-for-browser', models: [{ id: 'image-model', displayName: 'Image' }], ...overrides });
const settings = (overrides = {}) => ({ ...emptyModelSettings(), imageProviders: [provider()], ...overrides });
function directory(context) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-managed-models-'));
    context.after(() => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('canvas-managed-models-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return root;
}
async function fixture(context, { restrictMethods = false, modelResult, downloadForwardRequest } = {}) {
    const root = directory(context);
    const calls = [];
    const middleware = createCanvasAccessMiddleware({ ...loadConfig({}), dataDir: root, adminPassword: 'OnlyTestAdminPassword!', secureCookies: false, downloadForwardRequest, modelForwardRequest: async input => {
        calls.push(input);
        return { statusCode: input.body?.toString().includes('simulate-error') ? 500 : 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(modelResult || { data: [{ b64_json: 'AA==' }], echoed: input.headers.authorization })) };
    } });
    const server = http.createServer((request, response) => {
        if (restrictMethods && !['GET', 'HEAD', 'POST'].includes(request.method)) {
            response.writeHead(405, { 'content-type': 'text/html' });
            response.end('<html><body>405 Not Allowed</body></html>');
            return;
        }
        middleware(request, response, () => { response.writeHead(200); response.end('next'); });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    context.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
    const base = 'http://127.0.0.1:' + server.address().port;
    const request = async (endpoint, { method = 'GET', payload, cookie, headers = {} } = {}) => {
        const response = await fetch(base + endpoint, { method, headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
        const text = await response.text();
        let data; try { data = JSON.parse(text); } catch {}
        return { status: response.status, text, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    const admin = await request('/api/auth/login', { method: 'POST', payload: { username: 'admin', password: 'OnlyTestAdminPassword!' } });
    const member = await request('/api/auth/register', { method: 'POST', payload: { username: 'member', password: 'OnlyTestMemberPassword!' } });
    return { root, request, calls, admin: admin.cookie, member: member.cookie };
}

test('central settings persist keys privately and reject stale or unsafe changes', context => {
    const store = createModelSettingsStore(directory(context));
    assert.equal(store.view().revision, 0);
    const saved = store.save(settings(), 0);
    assert.equal(saved.settings.imageProviders[0].apiKey, '');
    assert.equal(saved.settings.imageProviders[0].hasApiKey, true);
    assert.equal(store.view().settings.imageProviders[0].apiKey, 'managed:test-image');
    assert.equal(store.resolve('test-image').apiKey, provider().apiKey);
    assert.ok(!JSON.stringify(store.view()).includes(provider().apiKey));
    assert.throws(() => store.save(settings(), 0), error => error.statusCode === 409);
    store.save(saved.settings, 1);
    assert.equal(store.resolve('test-image').apiKey, provider().apiKey);
    const changed = store.view(true).settings;
    changed.imageProviders[0].baseUrl = 'https://other.example.com';
    assert.throws(() => store.save(changed, 2), error => error.statusCode === 400);
    changed.imageProviders[0].apiKey = 'replacement-secret';
    store.save(changed, 2);
    assert.equal(store.resolve('test-image').apiKey, 'replacement-secret');
});

test('model settings validate addresses and preserve corrupt files', context => {
    for (const baseUrl of ['http://api.example.com', 'https://user:password@api.example.com', 'https://api.example.com/?key=secret', 'https://api.example.com:9000']) assert.throws(() => normalizeModelSettings(settings({ imageProviders: [provider({ baseUrl })] })));
    for (const input of [settings({ videoProviders: [provider()] }), settings({ defaultImageProvider: 'missing' }), settings({ concurrencyLimit: 0 }), settings({ imageProviders: [provider({ apiKey: 'managed:test-image' })] })]) assert.throws(() => normalizeModelSettings(input));
    const root = directory(context);
    const filename = path.join(root, 'model-settings.json');
    fs.writeFileSync(filename, 'corrupt');
    const store = createModelSettingsStore(root);
    assert.throws(() => store.view(), error => error.statusCode === 503);
    assert.throws(() => store.save(settings(), 0), error => error.statusCode === 503);
    assert.equal(fs.readFileSync(filename, 'utf8'), 'corrupt');
});

test('only administrators can configure models and users only receive public settings', async context => {
    const setup = await fixture(context);
    assert.equal((await setup.request('/api/model-settings')).status, 401);
    assert.equal((await setup.request('/api/admin/model-settings', { cookie: setup.member })).status, 403);
    assert.equal((await setup.request('/api/admin/model-settings', { method: 'PUT', cookie: setup.member, payload: { settings: settings(), revision: 0 } })).status, 403);
    assert.equal((await setup.request('/api/admin/model-settings', { method: 'PUT', cookie: setup.admin, payload: { settings: settings(), revision: 0 }, headers: { origin: 'http://evil.example' } })).status, 403);
    const saved = await setup.request('/api/admin/model-settings', { method: 'PUT', cookie: setup.admin, payload: { settings: settings(), revision: 0 } });
    assert.equal(saved.status, 200);
    assert.ok(!saved.text.includes(provider().apiKey));
    const shared = await setup.request('/api/model-settings', { cookie: setup.member });
    assert.equal(shared.status, 200);
    assert.equal(shared.data.settings.imageProviders[0].apiKey, 'managed:test-image');
    assert.equal((await setup.request('/api/model-settings', { method: 'PUT', cookie: setup.member, payload: {} })).status, 405);
    assert.match((await setup.request('/admin')).text, /href="\/admin\/models"/);
    assert.match((await setup.request('/admin/models')).text, /保存统一配置/);
});

test('imported model settings save through a POST-only proxy with all protections intact', async context => {
    const setup = await fixture(context, { restrictMethods: true });
    const endpoint = '/api/admin/model-settings';
    const imported = settings({ defaultImageProvider: 'test-image', concurrencyLimit: 5 });
    const payload = { settings: imported, revision: 0 };
    const blocked = await setup.request(endpoint, { method: 'PUT', cookie: setup.admin, payload });
    assert.equal(blocked.status, 405);
    assert.match(blocked.text, /<html>/);
    assert.equal((await setup.request(endpoint, { method: 'POST', payload })).status, 401);
    assert.equal((await setup.request(endpoint, { method: 'POST', cookie: setup.member, payload })).status, 403);
    assert.equal((await setup.request(endpoint, { method: 'POST', cookie: setup.admin, payload, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await setup.request(endpoint, { method: 'POST', cookie: setup.admin, payload, headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await setup.request(endpoint, { method: 'POST', cookie: setup.admin, payload: { ...payload, settings: { ...imported, concurrencyLimit: 0 } } })).status, 400);
    assert.equal((await setup.request(endpoint, { method: 'POST', cookie: setup.admin, payload: { ...payload, padding: 'x'.repeat(1024 * 1024) } })).status, 413);
    const saved = await setup.request(endpoint, { method: 'POST', cookie: setup.admin, payload });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.revision, 1);
    assert.equal(saved.data.settings.defaultImageProvider, 'test-image');
    assert.equal(saved.data.settings.imageProviders[0].apiKey, '');
    assert.equal(saved.data.settings.imageProviders[0].hasApiKey, true);
    assert.ok(!saved.text.includes(provider().apiKey));
    assert.equal((await setup.request(endpoint, { method: 'POST', cookie: setup.admin, payload })).status, 409);
    const reloaded = await setup.request(endpoint, { cookie: setup.admin });
    assert.deepEqual(reloaded.data, saved.data);
    const resaved = await setup.request(endpoint, { method: 'POST', cookie: setup.admin, payload: reloaded.data });
    assert.equal(resaved.status, 200);
    assert.equal(resaved.data.revision, 2);
    const stored = createModelSettingsStore(setup.root);
    assert.equal(stored.resolve('test-image').apiKey, provider().apiKey);
    assert.equal(stored.view().settings.concurrencyLimit, 5);
    const shared = await setup.request('/api/model-settings', { cookie: setup.member });
    assert.equal(shared.data.settings.imageProviders[0].apiKey, 'managed:test-image');
    assert.ok(!shared.text.includes(provider().apiKey));
});

test('model requests inject server keys, deny overrides and block legacy proxies', async context => {
    const setup = await fixture(context);
    const payload = { providerId: 'test-image', targetUrl: 'https://api.example.com/v1/images/generations', method: 'POST', payload: { model: 'image-model', prompt: 'test' } };
    assert.equal((await setup.request('/api/model-request', { method: 'POST', payload })).status, 401);
    await setup.request('/api/admin/model-settings', { method: 'PUT', cookie: setup.admin, payload: { settings: settings(), revision: 0 } });
    const result = await setup.request('/api/model-request', { method: 'POST', cookie: setup.member, payload });
    assert.equal(result.status, 200);
    assert.equal(setup.calls.length, 1);
    assert.equal(setup.calls[0].headers.authorization, 'Bearer ' + provider().apiKey);
    assert.ok(!result.text.includes(provider().apiKey));
    for (const override of [{ targetUrl: 'https://evil.example/v1/images/generations' }, { targetUrl: 'https://api.example.com/v1/files' }, { payload: { model: 'unlisted' } }]) assert.equal((await setup.request('/api/model-request', { method: 'POST', cookie: setup.member, payload: { ...payload, ...override } })).status, 403);
    assert.equal(setup.calls.length, 1);
    const failed = await setup.request('/api/model-request', { method: 'POST', cookie: setup.member, payload: { ...payload, payload: { model: 'image-model', prompt: 'simulate-error' } } });
    assert.equal(failed.status, 500);
    assert.ok(!failed.text.includes(provider().apiKey));
    for (const endpoint of ['openai-chat-proxy', 'openai-images-proxy', 'gemini-image-proxy', 'minimax-video-proxy', 'model-list-proxy']) assert.equal((await setup.request('/api/' + endpoint, { method: 'POST', cookie: setup.member, payload: {} })).status, 403);
});

test('generated image downloads authorize exact model results per account through the production middleware', async context => {
    const imageUrl = 'https://8.8.8.8/generated.png?signature=exact';
    const privateUrl = 'https://127.0.0.1/private.png';
    const downloads = [];
    const setup = await fixture(context, {
        modelResult: { data: [{ url: imageUrl }, { url: privateUrl }] },
        downloadForwardRequest: async input => {
            downloads.push(input);
            return { statusCode: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from('image-bytes') };
        },
    });
    await setup.request('/api/admin/model-settings', { method: 'POST', cookie: setup.admin, payload: { settings: settings(), revision: 0 } });
    const endpoint = '/api/openai-download-proxy?url=' + encodeURIComponent(imageUrl);
    assert.equal((await setup.request(endpoint, { cookie: setup.member })).status, 403);
    const payload = { providerId: 'test-image', targetUrl: 'https://api.example.com/v1/images/generations', payload: { model: 'image-model', prompt: 'download regression' } };
    assert.equal((await setup.request('/api/model-request', { method: 'POST', cookie: setup.member, payload })).status, 200);
    const downloaded = await setup.request(endpoint, { cookie: setup.member });
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.text, 'image-bytes');
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].generatedDownload, true);
    assert.equal(downloads[0].headers, undefined);
    assert.equal((await setup.request(endpoint)).status, 401);
    assert.equal((await setup.request(endpoint, { cookie: setup.admin })).status, 403);
    assert.equal((await setup.request(endpoint + 'changed', { cookie: setup.member })).status, 403);
    assert.equal((await setup.request('/api/openai-download-proxy?url=' + encodeURIComponent(privateUrl), { cookie: setup.member })).status, 403);
    assert.equal(downloads.length, 1);
});

test('managed transport supports Gemini, wrapped proxies and video polling', async () => {
    const direct = await prepareManagedRequest('https://api.example.com/v1/images/generations', { method: 'POST', headers: { authorization: 'Bearer managed:image' }, body: JSON.stringify({ model: 'image-model' }) });
    assert.equal(direct.providerId, 'image');
    assert.equal(direct.payload.model, 'image-model');
    const google = await prepareManagedRequest('https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent?key=managed:gemini', { method: 'POST', body: '{}' });
    assert.equal(google.providerId, 'gemini');
    assert.ok(!google.targetUrl.includes('key='));
    const proxy = await prepareManagedRequest('/api/openai-chat-proxy', { method: 'POST', body: JSON.stringify({ apiKey: 'managed:text', targetUrl: 'https://api.example.com/v1/chat/completions', payload: { model: 'text-model' } }) });
    assert.equal(proxy.providerId, 'text');
    assert.equal(proxy.payload.model, 'text-model');
    const minimax = await prepareManagedRequest('/api/minimax-video-proxy', { method: 'POST', body: JSON.stringify({ apiKey: 'managed:video', baseUrl: 'https://api.minimaxi.com', action: 'query', taskId: 'task-1' }) });
    assert.equal(minimax.targetUrl, 'https://api.minimaxi.com/v2/video_generation/task-1');
    assert.equal(minimax.method, 'GET');
    assert.equal(await prepareManagedRequest('blob:http://localhost:3004/test'), null);
});

test('request resolver allows supported formats and rejects malformed multipart models', () => {
    const store = { resolve: () => provider() };
    const request = { providerId: 'test-image', targetUrl: 'https://api.example.com/v1/images/edits', method: 'POST', payloadType: 'form-data', payload: [{ name: 'model', kind: 'field', value: 'image-model' }] };
    assert.equal(resolveModelRequest(store, request).payloadType, 'form-data');
    assert.throws(() => resolveModelRequest(store, { ...request, payload: [null] }), error => error.statusCode === 400);
    assert.throws(() => resolveModelRequest(store, { ...request, payload: [...request.payload, ...request.payload] }), error => error.statusCode === 400);
    const geminiStore = { resolve: () => provider({ baseUrl: 'https://generativelanguage.googleapis.com', type: 'gemini', models: [{ id: 'gemini' }] }) };
    const gemini = resolveModelRequest(geminiStore, { targetUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent', method: 'POST', payload: { contents: [] } });
    assert.equal(gemini.headers['x-goog-api-key'], provider().apiKey);
    assert.equal(resolveModelRequest(store, { targetUrl: 'https://api.example.com/v1/audio/speech', method: 'POST', payload: { model: 'image-model' } }).method, 'POST');
    assert.equal(resolveModelRequest(store, { targetUrl: 'https://api.example.com/v1/videos/task-1', method: 'GET' }).method, 'GET');
});
