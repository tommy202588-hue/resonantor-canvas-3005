import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublicBasePath, withPublicBasePath } from './public-path.mjs';
import { serveAdminConsole } from './admin-console.mjs';
import { serveModelConsole } from './model-console.mjs';
import { serveGpuConsole } from './gpu-console.mjs';

test('public path validation cannot inject HTML, scripts or external origins', () => {
    assert.equal(normalizePublicBasePath(''), '');
    assert.equal(normalizePublicBasePath('/'), '');
    assert.equal(normalizePublicBasePath('/canvas-test/'), '/canvas-test');
    for (const value of ['//evil.test', '/canvas/../admin', '/canvas?key=value', '/canvas\'bad', '/canvas"bad', 'https://evil.test', '/canvas%2fadmin']) assert.throws(() => normalizePublicBasePath(value));
    assert.equal(withPublicBasePath('<a href="/admin">', ''), '<a href="/admin">');
});

test('isolated admin, model and GPU consoles stay under their own API and navigation prefix', () => {
    for (const render of [serveAdminConsole, serveModelConsole, serveGpuConsole]) {
        let html;
        let headers;
        render({ writeHead: (status, values) => { assert.equal(status, 200); headers = values; }, end: content => { html = content; } }, '/canvas-test');
        assert.match(html, /href="\/canvas-test\//);
        assert.match(html, /fetch\('\/canvas-test\/api\//);
        assert.doesNotMatch(html, /href="\/(?:admin|"|api)|fetch\('\/api\//);
        assert.match(headers['content-security-policy'], /script-src 'nonce-/);
    }
});

test('published admin consoles use POST for settings saves allowed by the site proxy', () => {
    let modelHtml;
    let gpuHtml;
    serveModelConsole({ writeHead() {}, end: content => { modelHtml = content; } }, '/canvas-test');
    serveGpuConsole({ writeHead() {}, end: content => { gpuHtml = content; } }, '/canvas-test');
    assert.match(modelHtml, /fetch\('\/canvas-test\/api\/admin\/model-settings', \{ method: 'POST'/);
    assert.doesNotMatch(modelHtml, /fetch\('\/canvas-test\/api\/admin\/model-settings', \{ method: 'PUT'/);
    assert.match(gpuHtml, /request\('admin\/gpu-servers', 'POST'/);
    assert.doesNotMatch(gpuHtml, /request\('admin\/gpu-servers', 'PUT'/);
});
