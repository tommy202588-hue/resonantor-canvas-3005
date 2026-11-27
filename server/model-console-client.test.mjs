import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { serveModelConsole } from './model-console.mjs';
import { emptyModelSettings } from './model-settings.mjs';

const importedSettings = () => ({ ...emptyModelSettings(), imageProviders: [{ id: 'imported-image', name: 'Imported image provider', type: 'openai', baseUrl: 'https://api.example.com', apiKey: 'test-import-secret', models: [{ id: 'image-model', displayName: 'Image' }] }], defaultImageProvider: 'imported-image' });
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function node(tagName = 'div') {
    return {
        tagName, children: [], listeners: new Map(), value: '', hidden: false, disabled: false, textContent: '',
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
        addEventListener(name, callback) { this.listeners.set(name, callback); },
        querySelectorAll(selector) { return this.children.flatMap(child => [...(child.tagName === selector ? [child] : []), ...child.querySelectorAll(selector)]); },
    };
}

async function clientFixture(respond, base = '/resonantor-canvas') {
    let html;
    serveModelConsole({ writeHead() {}, end(value) { html = value; } }, base);
    const elements = new Map();
    const getElementById = id => {
        if (!elements.has(id)) elements.set(id, node());
        return elements.get(id);
    };
    const button = node('button');
    getElementById('editor').append(button);
    const requests = [];
    const context = vm.createContext({
        document: { getElementById, createElement: node, createTextNode: text => ({ textContent: text }) },
        fetch: async (url, options = {}) => {
            const request = { url, ...options, payload: options.body ? JSON.parse(options.body) : undefined };
            requests.push(request);
            return respond(request);
        },
        localStorage: { getItem() { return null; } },
        confirm: () => true,
    });
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
    vm.runInContext(script, context);
    await new Promise(resolve => setImmediate(resolve));
    const importFile = async data => {
        const text = JSON.stringify(data);
        const input = { value: 'settings.json', files: [{ size: Buffer.byteLength(text), text: async () => text }] };
        await getElementById('file').listeners.get('change')({ target: input });
        assert.equal(input.value, '');
    };
    const submit = () => getElementById('editor').listeners.get('submit')({ preventDefault() {} });
    return { context, requests, getElementById, importFile, submit, button };
}

for (const wrapped of [false, true]) {
    test(`imported ${wrapped ? 'wrapped' : 'plain'} settings use POST at the deployed base path`, async () => {
        const fixture = await clientFixture(request => {
            if (request.method !== 'POST') return jsonResponse({ settings: emptyModelSettings(), revision: 7 });
            const saved = structuredClone(request.payload);
            saved.revision += 1;
            for (const provider of saved.settings.imageProviders) { provider.apiKey = ''; provider.hasApiKey = true; }
            return jsonResponse(saved);
        });
        const settings = importedSettings();
        await fixture.importFile(wrapped ? { settings, revision: 99 } : settings);
        await fixture.submit();
        assert.equal(fixture.requests.length, 2);
        const saved = fixture.requests[1];
        assert.equal(saved.method, 'POST');
        assert.equal(saved.url, '/resonantor-canvas/api/admin/model-settings');
        assert.equal(saved.credentials, 'same-origin');
        assert.equal(saved.headers['content-type'], 'application/json');
        assert.deepEqual(saved.payload.settings, settings);
        assert.equal(saved.payload.revision, 7);
        assert.match(fixture.getElementById('message').textContent, /已保存/);
        assert.match(fixture.getElementById('revision').textContent, /配置版本 8/);
        assert.equal(fixture.getElementById('editor').hidden, false);
        assert.equal(fixture.button.disabled, false);
        await fixture.submit();
        assert.equal(fixture.requests[2].payload.settings.imageProviders[0].apiKey, '');
        assert.equal(fixture.requests[2].payload.revision, 8);
    });
}

test('HTML save failures preserve the imported draft and do not trigger automatic retries', async () => {
    let allowSave = false;
    const fixture = await clientFixture(request => {
        if (!request.method) return jsonResponse({ settings: emptyModelSettings(), revision: 3 });
        if (!allowSave) return new Response('<html>405 Not Allowed</html>', { status: 405, headers: { 'content-type': 'text/html' } });
        return jsonResponse({ settings: emptyModelSettings(), revision: 4 });
    });
    await fixture.importFile(importedSettings());
    await fixture.submit();
    assert.equal(fixture.requests.length, 2);
    assert.match(fixture.getElementById('message').textContent, /HTTP 405/);
    assert.match(fixture.getElementById('message').textContent, /表单内容已保留/);
    assert.doesNotMatch(fixture.getElementById('message').textContent, /登录已失效/);
    assert.equal(fixture.getElementById('editor').hidden, false);
    assert.equal(fixture.button.disabled, false);
    allowSave = true;
    await fixture.submit();
    assert.deepEqual(fixture.requests[2].payload, fixture.requests[1].payload);
    assert.match(fixture.getElementById('message').textContent, /已保存/);
});

test('model console distinguishes authentication, method, size and gateway failures', async () => {
    const fixture = await clientFixture(() => jsonResponse({ settings: emptyModelSettings(), revision: 0 }));
    for (const [status, expected] of [[401, /登录已失效/], [403, /HTTP 403/], [405, /请求方法.*HTTP 405/], [413, /请求大小.*HTTP 413/], [502, /暂时不可用.*HTTP 502/], [200, /非 JSON 响应.*HTTP 200/]]) {
        const response = new Response('<html>proxy error</html>', { status, headers: { 'content-type': 'text/html' } });
        await assert.rejects(fixture.context.readJsonResponse(response), expected);
    }
    await assert.rejects(fixture.context.readJsonResponse(jsonResponse({ error: { message: 'Login required.' } }, 401)), /登录已失效/);
    await assert.rejects(fixture.context.readJsonResponse(new Response('{', { headers: { 'content-type': 'application/json' } })), /JSON 无法解析.*HTTP 200/);
    const conflict = { error: { message: '模型配置已在其他页面更新。' } };
    assert.equal(JSON.stringify(await fixture.context.readJsonResponse(jsonResponse(conflict, 409))), JSON.stringify(conflict));
});
