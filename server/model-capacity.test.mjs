import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createApiServer, loadConfig } from './api-server.mjs';
import { createModelSettingsStore, emptyModelSettings } from './model-settings.mjs';

const payload = { providerId: 'capacity-image', targetUrl: 'https://models.example.com/v1/images/generations', method: 'POST', payload: { model: 'test-image', prompt: 'local test' } };
const success = { statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"data":[{"b64_json":"AA=="}]}') };
const until = async predicate => {
    for (let attempt = 0; attempt < 150; attempt += 1) {
        if (predicate()) return;
        await delay(10);
    }
    assert.fail('Timed out waiting for mock model requests');
};

async function fixture(context, overrides = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-capacity-test-'));
    context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const store = createModelSettingsStore(dataDir);
    store.save({ ...emptyModelSettings(), concurrencyLimit: 15, imageProviders: [{ id: 'capacity-image', type: 'openai', name: 'Local fixture', baseUrl: 'https://models.example.com/v1', apiKey: 'only-a-test-secret', models: [{ id: 'test-image', displayName: 'Test' }] }] }, 0);
    const pending = [];
    const server = createApiServer({
        ...loadConfig({}), dataDir, adminPassword: 'OnlyLocalCapacityTest!', secureCookies: false,
        enableUpscaleApi: false, rateMax: 1000, expensiveRateMax: 1000,
        modelForwardRequest: input => new Promise((resolve, reject) => {
            pending.push({ input, resolve, reject });
            input.signal?.addEventListener('abort', () => reject(input.signal.reason), { once: true });
        }), ...overrides,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    context.after(async () => {
        for (const request of pending) request.resolve(success);
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    const base = 'http://127.0.0.1:' + server.address().port;
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username: 'admin', password: 'OnlyLocalCapacityTest!' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    await login.arrayBuffer();
    const request = (endpoint, body, options = {}) => fetch(base + endpoint, {
        method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie, origin: base },
        ...(body ? { body: JSON.stringify(body) } : {}), ...options,
    });
    return { request, pending, store };
}

test('three active model requests reject the fourth before forwarding and release on success or error', { timeout: 10000 }, async context => {
    const setup = await fixture(context);
    const active = [setup.request('/api/model-request', payload), setup.request('/api/model-request', payload), setup.request('/api/model-request', payload)];
    await until(() => setup.pending.length === 3);
    const busy = await setup.request('/api/model-request', payload);
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('retry-after'), '10');
    const error = (await busy.json()).error;
    assert.equal(error.type, 'concurrency_limit');
    assert.match(error.message, /当前账号.*3.*尚未发送/);
    assert.equal(setup.pending.length, 3);
    assert.equal((await setup.request('/api/auth/me')).status, 200);
    setup.pending[0].resolve(success);
    setup.pending[1].reject(new Error('Simulated upstream failure'));
    setup.pending[2].resolve(success);
    const statuses = await Promise.all(active.map(async request => { const result = await request; await result.arrayBuffer(); return result.status; }));
    assert.deepEqual(statuses.sort(), [200, 200, 502]);
    const next = setup.request('/api/model-request', payload);
    await until(() => setup.pending.length === 4);
    setup.pending[3].resolve(success);
    assert.equal((await next).status, 200);
});

test('public batch concurrency respects the proxy capacity without overwriting the administrator setting', async context => {
    const setup = await fixture(context, { maxConcurrency: 2, maxConcurrencyPerIp: 3 });
    const shared = await (await setup.request('/api/model-settings')).json();
    assert.equal(shared.settings.concurrencyLimit, 2);
    assert.deepEqual(shared.limits, { global: 2, perAccount: 3, effective: 2 });
    const admin = await (await setup.request('/api/admin/model-settings')).json();
    assert.equal(admin.settings.concurrencyLimit, 15);
    assert.deepEqual(admin.limits, shared.limits);
    assert.equal(setup.store.view(true).settings.concurrencyLimit, 15);
    const saved = await (await setup.request('/api/admin/model-settings', { settings: { ...admin.settings, concurrencyLimit: 1 }, revision: admin.revision })).json();
    assert.equal(saved.limits.effective, 1);
    assert.equal((await (await setup.request('/api/model-settings')).json()).settings.concurrencyLimit, 1);
});

test('explicit unlimited model mode accepts requests beyond local concurrency and frequency limits', { timeout: 10000 }, async context => {
    const setup = await fixture(context, { unlimitedModelRequests: true, maxConcurrency: 1, maxConcurrencyPerIp: 1, rateMax: 1, expensiveRateMax: 1 });
    const shared = await (await setup.request('/api/model-settings')).json();
    assert.equal(shared.settings.concurrencyLimit, 15);
    assert.deepEqual(shared.limits, { global: null, perAccount: null, effective: 15, unlimitedModels: true });
    const active = Array.from({ length: 6 }, () => setup.request('/api/model-request', payload));
    await until(() => setup.pending.length === 6);
    for (const request of setup.pending) request.resolve(success);
    for (const request of active) {
        const response = await request;
        assert.equal(response.status, 200);
        await response.arrayBuffer();
    }
    const next = setup.request('/api/model-request', payload);
    await until(() => setup.pending.length === 7);
    setup.pending[6].resolve(success);
    assert.equal((await next).status, 200);
    // Disabling model limits does not remove authentication or login rate limits.
    const anonymous = await setup.request('/api/model-request', payload, { headers: { 'content-type': 'application/json' } });
    assert.equal(anonymous.status, 401);
});

test('unlimited model requests require an explicit environment setting', () => {
    assert.equal(loadConfig({}).unlimitedModelRequests, false);
    assert.equal(loadConfig({ CANVAS_UNLIMITED_MODEL_REQUESTS: 'true' }).unlimitedModelRequests, true);
    assert.equal(loadConfig({ CANVAS_UNLIMITED_MODEL_REQUESTS: 'false' }).unlimitedModelRequests, false);
});

test('model deadline releases slots even when an upstream promise never settles', { timeout: 10000 }, async context => {
    const setup = await fixture(context, { maxConcurrencyPerIp: 1, requestTimeoutMs: 120, modelForwardRequest: () => new Promise(() => {}) });
    const response = await setup.request('/api/model-request', payload);
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.type, 'upstream_timeout');
    const next = await setup.request('/api/model-request', payload);
    assert.equal(next.status, 504);
    assert.equal((await next.json()).error.type, 'upstream_timeout');
});

test('client disconnect aborts forwarding and frees the account slot without retrying the model', { timeout: 10000 }, async context => {
    const setup = await fixture(context, { maxConcurrencyPerIp: 1 });
    const controller = new AbortController();
    const cancelled = setup.request('/api/model-request', payload, { signal: controller.signal }).catch(error => error);
    await until(() => setup.pending.length === 1);
    assert.ok(setup.pending[0].input.signal);
    controller.abort();
    assert.equal((await cancelled).name, 'AbortError');
    await until(() => setup.pending[0].input.signal.aborted);
    assert.equal(setup.pending[0].input.signal.reason.type, 'client_disconnected');
    await delay(20);
    assert.equal(setup.pending.length, 1);
    const next = setup.request('/api/model-request', payload);
    await until(() => setup.pending.length === 2);
    setup.pending[1].resolve(success);
    assert.equal((await next).status, 200);
});
