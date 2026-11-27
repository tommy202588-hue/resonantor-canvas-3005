import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createDesktopCompanion } from './desktop-companion.mjs';
import { decodeProjectFile } from '../services/projectFile.mjs';

const data = () => ({ version: 1, nodes: [], connections: [], groups: [], viewport: { x: 0, y: 0, k: 1 } });
async function fixture(context) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resonantor-desktop-test-'));
    const publicDirectory = path.join(root, 'dist');
    fs.mkdirSync(publicDirectory);
    fs.writeFileSync(path.join(publicDirectory, 'index.html'), '<h1>desktop canvas</h1>');
    fs.writeFileSync(path.join(root, 'secret.txt'), 'not-public');
    const calls = [];
    const upstream = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        calls.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() });
        response.setHeader('content-type', 'application/json');
        if (request.url === '/api/auth/login') { response.setHeader('set-cookie', 'session=alice; HttpOnly; SameSite=Lax; Path=/'); response.end(JSON.stringify({ user: { id: 'alice' } })); return; }
        const id = /session=(alice|bob)/.exec(request.headers.cookie || '')?.[1];
        if (!id) { response.statusCode = 401; response.end(JSON.stringify({ error: { message: 'login required' } })); return; }
        response.end(JSON.stringify(request.url === '/api/auth/me' ? { user: { id, username: id } } : { ok: true }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const origin = 'http://127.0.0.1:' + upstream.address().port;
    const servers = [upstream];
    const start = async machine => {
        const projectRoot = path.join(root, machine, 'Desktop', '共智体画布工程');
        const server = createDesktopCompanion({ publicDirectory, projectRoot, upstream: origin });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        servers.push(server);
        return { base: 'http://127.0.0.1:' + server.address().port, projectRoot, server };
    };
    context.after(async () => {
        for (const server of servers) { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('resonantor-desktop-test-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, calls, start, origin, upstream, client: await start('computer-A') };
}
async function call(client, endpoint, { method = 'GET', payload, cookie = 'session=alice', headers = {}, raw } = {}) {
    const response = await fetch(client.base + endpoint, {
        method, headers: { cookie, 'x-canvas-project-client': randomUUID(), ...(method !== 'GET' ? { origin: client.base, 'content-type': 'application/json' } : {}), ...headers },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : raw !== undefined ? { body: raw } : {}),
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch {}
    return { status: response.status, result, text, headers: response.headers };
}
const create = (client, name = '我的工程') => call(client, '/api/canvas-projects', { method: 'POST', payload: { name, data: data() } });

test('desktop projects require server login and never create files for anonymous users', async context => {
    const { client, calls } = await fixture(context);
    const result = await call(client, '/api/canvas-projects', { cookie: '', method: 'POST', payload: { name: 'blocked', data: data() } });
    assert.equal(result.status, 401);
    assert.equal(fs.existsSync(client.projectRoot), false);
    assert.deepEqual(calls.map(item => item.url), ['/api/auth/me']);
});

test('two computers using the same account create and reopen only their own desktop projects', async context => {
    const { client, start, calls } = await fixture(context);
    const other = await start('computer-B');
    const created = await create(client);
    assert.equal(created.status, 200);
    const project = created.result.project;
    assert.ok(project.directory.startsWith(client.projectRoot + path.sep));
    assert.deepEqual(project.settings, { intervalMinutes: 5, maxSnapshots: 5 });
    assert.equal((await call(other, '/api/canvas-projects')).result.projects.length, 0);
    assert.equal((await call(other, '/api/canvas-projects/' + project.id)).status, 404);
    const restarted = await start('computer-A');
    assert.equal((await call(restarted, '/api/canvas-projects')).result.projects[0].id, project.id);
    assert.equal((await call(restarted, '/api/canvas-projects/' + project.id)).result.data.nodes.length, 0);
    assert.ok(calls.every(item => item.url === '/api/auth/me' && !item.body));
});

test('account identity cannot be forged to read another account desktop project', async context => {
    const { client } = await fixture(context);
    const project = (await create(client)).result.project;
    const bob = { cookie: 'session=bob', headers: { 'x-user-id': 'alice' } };
    assert.deepEqual((await call(client, '/api/canvas-projects', bob)).result.projects, []);
    assert.equal((await call(client, '/api/canvas-projects/' + project.id, bob)).status, 404);
    assert.equal((await call(client, '/api/canvas-projects/' + project.id + '/delete', { ...bob, method: 'POST', payload: { revision: project.revision, confirmationId: project.id } })).status, 404);
    assert.ok(fs.existsSync(project.directory));
});

test('local snapshot retention, rename, revision conflicts and soft delete preserve project data', async context => {
    const { client } = await fixture(context);
    let project = (await create(client)).result.project;
    const stale = project;
    for (let index = 0; index < 6; index++) project = (await call(client, '/api/canvas-projects/' + project.id + '/snapshots', { method: 'POST', payload: { revision: project.revision, data: data() } })).result.project;
    assert.equal(project.snapshotCount, 5);
    assert.equal(fs.readdirSync(project.directory).filter(name => name.endsWith('.js')).length, 5);
    assert.equal((await call(client, '/api/canvas-projects/' + project.id + '/snapshots', { method: 'POST', payload: { revision: stale.revision, data: data() } })).status, 409);
    project = (await call(client, '/api/canvas-projects/' + project.id + '/settings', { method: 'PATCH', payload: { revision: project.revision, settings: { intervalMinutes: 1, maxSnapshots: 2 } } })).result.project;
    assert.equal(project.snapshotCount, 2);
    project = (await call(client, '/api/canvas-projects/' + project.id + '/name', { method: 'PATCH', payload: { revision: project.revision, name: '新名字' } })).result.project;
    project = (await call(client, '/api/canvas-projects/' + project.id + '/snapshots', { method: 'POST', payload: { revision: project.revision, data: data() } })).result.project;
    const index = JSON.parse(fs.readFileSync(path.join(project.directory, 'project.json'), 'utf8'));
    assert.equal(decodeProjectFile(fs.readFileSync(path.join(project.directory, index.snapshots[0].filename), 'utf8')).canvasProject.name, '新名字');
    const deleted = await call(client, '/api/canvas-projects/' + project.id + '/delete', { method: 'POST', payload: { revision: project.revision, confirmationId: project.id } });
    assert.equal(deleted.status, 200);
    assert.ok(fs.existsSync(deleted.result.directory));
    assert.equal(fs.existsSync(project.directory), false);
});

test('cross-site requests and forged hosts never reach files or upstream', async context => {
    const { client, calls } = await fixture(context);
    for (const headers of [{ origin: 'http://attacker.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
        assert.equal((await call(client, '/api/canvas-projects', { headers })).status, 403, JSON.stringify(headers));
        assert.equal((await call(client, '/api/model-request', { method: 'POST', payload: {}, headers })).status, 403);
    }
    const forgedHost = await new Promise((resolve, reject) => {
        const request = http.get(client.base + '/api/canvas-projects', { headers: { host: 'attacker.invalid', cookie: 'session=alice' } }, response => {
            response.resume(); response.on('end', () => resolve(response.statusCode));
        });
        request.on('error', reject);
    });
    assert.equal(forgedHost, 403);
    assert.equal(calls.length, 0);
    assert.equal(fs.existsSync(client.projectRoot), false);
    assert.equal(client.server.address().address, '127.0.0.1');
});

test('login cookies and generation requests proxy only to the fixed upstream', async context => {
    const { client, calls, origin } = await fixture(context);
    const login = await call(client, '/api/auth/login', { method: 'POST', payload: { username: 'alice' }, cookie: '' });
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    const response = await call(client, '/api/model-request', { method: 'POST', payload: { prompt: 'test' }, headers: { 'x-forwarded-host': 'attacker.invalid', forwarded: 'for=attacker' } });
    assert.equal(response.status, 200);
    const forwarded = calls.at(-1);
    assert.equal(forwarded.headers.origin, origin);
    assert.equal(forwarded.headers.host, new URL(origin).host);
    assert.equal(forwarded.headers.cookie, 'session=alice');
    assert.equal(forwarded.headers['x-forwarded-host'], undefined);
    assert.equal(forwarded.headers.forwarded, undefined);
    assert.deepEqual(JSON.parse(forwarded.body), { prompt: 'test' });
    assert.equal((await call(client, '/api/upscale/jobs?scale=2', { method: 'POST', raw: 'image-bytes', headers: { 'content-type': 'application/octet-stream' } })).status, 200);
    assert.equal(calls.at(-1).body, 'image-bytes');
});

test('server desktop paths, admin, arbitrary proxies and private package files are not exposed', async context => {
    const { client, calls } = await fixture(context);
    for (const endpoint of ['/api/choose-save-directory', '/api/local-save/directory', '/api/save-generated-image', '/api/projects/default', '/api/admin/overview', '/secret.txt', '/server/desktop-companion.mjs', '/%2e%2e%2fsecret.txt']) assert.equal((await call(client, endpoint)).status, 404);
    assert.equal(calls.length, 0);
    assert.match((await call(client, '/')).text, /desktop canvas/);
});

test('server outage cannot delete or falsely save an existing local snapshot', async context => {
    const { client, upstream } = await fixture(context);
    const project = (await create(client)).result.project;
    const before = fs.readFileSync(path.join(project.directory, 'project.json'), 'utf8');
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    assert.equal((await call(client, '/api/canvas-projects/' + project.id + '/snapshots', { method: 'POST', payload: { revision: project.revision, data: data() } })).status, 503);
    assert.equal(fs.readFileSync(path.join(project.directory, 'project.json'), 'utf8'), before);
});
