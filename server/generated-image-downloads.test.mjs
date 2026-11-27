import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeneratedImageDownloads } from './generated-image-downloads.mjs';
import { readGeneratedImageBlob } from '../services/generatedImageBlob.mjs';
import { loadConfig } from './api-server.mjs';
import { validateTargetUrl } from './security.mjs';

const imageUrl = 'https://cdn.example.com/generated.png?signature=exact';
const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];

test('reproduces configured model CDN rejection by the old independent download whitelist', async () => {
    await assert.rejects(validateTargetUrl(imageUrl, loadConfig({}).downloadHosts, publicLookup), error => error.type === 'target_not_allowed');
    const downloads = createGeneratedImageDownloads();
    downloads.remember('alice', Buffer.from(JSON.stringify({ data: [{ url: imageUrl }] })), 'application/json');
    assert.equal(downloads.allows('alice', imageUrl), true);
    await validateTargetUrl(imageUrl, [new URL(imageUrl).hostname], publicLookup);
    assert.equal(downloads.allows('bob', imageUrl), false);
    assert.equal(downloads.allows('alice', imageUrl + 'changed'), false);
});

test('generated URL permissions expire and stay bounded', () => {
    let time = 0;
    const downloads = createGeneratedImageDownloads({ now: () => time, ttlMs: 100, limit: 2 });
    downloads.remember('alice', Buffer.from(JSON.stringify([imageUrl, imageUrl + '2', imageUrl + '3'])), 'application/json');
    assert.equal(downloads.allows('alice', imageUrl), false);
    assert.equal(downloads.allows('alice', imageUrl + '2'), true);
    time = 100;
    assert.equal(downloads.allows('alice', imageUrl + '2'), false);
});

test('Gemini markdown and SSE image URLs are remembered, credential URLs are excluded', () => {
    for (const [body, mime] of [
        [JSON.stringify({ candidates: [{ content: { parts: [{ text: '![result](' + imageUrl + ')' }] } }] }), 'application/json'],
        ['data: ' + JSON.stringify({ choices: [{ delta: { content: imageUrl } }] }) + '\n\ndata: [DONE]', 'text/event-stream'],
    ]) {
        const downloads = createGeneratedImageDownloads();
        downloads.remember('alice', Buffer.from(body), mime);
        assert.equal(downloads.allows('alice', imageUrl), true);
        assert.equal(downloads.allows('alice', 'https://user:password@cdn.example.com/private'), false);
    }
});

test('generated CDN authorization still rejects private addresses and unsafe protocols', async () => {
    for (const address of ['127.0.0.1', '169.254.169.254', '192.168.1.1', '::1']) {
        await assert.rejects(validateTargetUrl(imageUrl, ['cdn.example.com'], async () => [{ address, family: address.includes(':') ? 6 : 4 }]), error => error.type === 'private_target_blocked');
    }
    await assert.rejects(validateTargetUrl('http://cdn.example.com/image.png', ['cdn.example.com'], publicLookup));
});

const options = { origin: 'https://canvas.example.com', apiPath: path => '/resonantor-canvas' + path };
const imageResponse = () => new Response(new Blob(['image'], { type: 'image/png' }));
test('image reads use the hosted subpath and authenticated same-origin proxy', async () => {
    const blob = await readGeneratedImageBlob(imageUrl, { ...options, fetchImage: async (url, init) => {
        assert.equal(url, '/resonantor-canvas/api/openai-download-proxy?url=' + encodeURIComponent(imageUrl));
        assert.equal(init.credentials, 'include');
        return imageResponse();
    } });
    assert.equal(blob.type, 'image/png');
});

test('CORS-enabled images can be downloaded when the proxy is unavailable, without credentials', async () => {
    let calls = 0;
    await readGeneratedImageBlob(imageUrl, { ...options, fetchImage: async (url, init) => {
        calls += 1;
        if (calls === 1) return new Response('{}', { status: 403 });
        assert.equal(url, imageUrl);
        assert.equal(init.credentials, 'omit');
        return imageResponse();
    } });
    assert.equal(calls, 2);
});

test('failed proxy and CORS reads retain actionable errors, not fake HTML downloads', async () => {
    await assert.rejects(readGeneratedImageBlob(imageUrl, { ...options, fetchImage: async url => {
        if (url.startsWith('/')) return new Response(JSON.stringify({ error: { type: 'target_not_allowed' } }), { status: 403 });
        throw new TypeError('CORS');
    } }), /未获服务器授权.*403/);
    await assert.rejects(readGeneratedImageBlob('/expired.png', { ...options, fetchImage: async () => new Response('<html>expired</html>', { headers: { 'content-type': 'text/html' } }) }), /不是有效的图片/);
});
