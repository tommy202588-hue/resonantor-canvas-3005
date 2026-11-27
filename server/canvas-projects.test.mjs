import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createProjectStore, createCanvasProjectsMiddleware, isLocalProjectRequest } from './canvas-projects.mjs';
import { encodeProjectFile, decodeProjectFile, validateProjectSettings } from '../services/projectFile.mjs';
import { startProjectAutosave } from '../services/projectAutosave.mjs';

const empty = () => ({ version: 1, nodes: [], connections: [], groups: [], viewport: { x: 0, y: 0, k: 1 } });
function fixture(context) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gzt-project-test-'));
    context.after(() => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('gzt-project-test-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    let clock = 1_800_000_000_000;
    return { root, store: createProjectStore({ rootDirectory: root, now: () => clock++ }) };
}

test('new project writes a JS snapshot with five minute autosave and five versions by default', context => {
    const { root, store } = fixture(context);
    const project = store.create({ name: '我的第一份工程', data: empty() });
    assert.deepEqual(project.settings, { intervalMinutes: 5, maxSnapshots: 5 });
    assert.equal(project.snapshotCount, 1);
    const snapshots = fs.readdirSync(project.directory).filter(name => name.endsWith('.js'));
    assert.equal(snapshots.length, 1);
    const text = fs.readFileSync(path.join(project.directory, snapshots[0]), 'utf8');
    assert.ok(text.startsWith('export default '));
    assert.equal(decodeProjectFile(text).canvasProject.name, project.name);
    const reloaded = createProjectStore({ rootDirectory: root });
    assert.equal(reloaded.list().projects[0].id, project.id);
    assert.deepEqual(reloaded.open(project.id).data.nodes, []);
});

test('retention only removes the same project oldest registered snapshots', context => {
    const { store } = fixture(context);
    let first = store.create({ name: '同名工程', data: empty() });
    const second = store.create({ name: '同名工程', data: empty() });
    fs.writeFileSync(path.join(first.directory, '我自己的文件.js'), 'do not delete');
    first = store.configure(first.id, { revision: first.revision, settings: { intervalMinutes: 2, maxSnapshots: 2 } });
    for (let index = 0; index < 5; index += 1) first = store.save(first.id, { revision: first.revision, data: { ...empty(), marker: index } });
    assert.equal(first.snapshotCount, 2);
    assert.equal(fs.readdirSync(first.directory).filter(name => name.startsWith('snapshot-')).length, 2);
    assert.equal(fs.readFileSync(path.join(first.directory, '我自己的文件.js'), 'utf8'), 'do not delete');
    assert.equal(store.open(first.id).data.marker, 4);
    assert.equal(store.open(second.id).project.snapshotCount, 1);
    assert.equal(store.list().projects[0].id, first.id);
});

test('reducing retention immediately keeps the latest file and persists settings after reload', context => {
    const { root, store } = fixture(context);
    let project = store.create({ name: '备份设置', data: empty() });
    project = store.save(project.id, { revision: project.revision, data: { ...empty(), latest: true } });
    project = store.configure(project.id, { revision: project.revision, settings: { intervalMinutes: 15, maxSnapshots: 1 } });
    const reloaded = createProjectStore({ rootDirectory: root });
    assert.equal(project.snapshotCount, 1);
    assert.equal(reloaded.open(project.id).data.latest, true);
    assert.deepEqual(reloaded.open(project.id).project.settings, { intervalMinutes: 15, maxSnapshots: 1 });
});

test('stale page revisions cannot overwrite a newer save', context => {
    const { store } = fixture(context);
    const project = store.create({ name: '版本冲突', data: empty() });
    store.save(project.id, { revision: project.revision, data: { ...empty(), latest: true } });
    assert.throws(() => store.save(project.id, { revision: project.revision, data: empty() }), /另一个页面更新/);
    assert.equal(store.open(project.id).data.latest, true);
});

test('a failed snapshot write never deletes the previous usable snapshot', context => {
    const { store } = fixture(context);
    const project = store.create({ name: '保留旧备份', data: empty() });
    const write = fs.writeFileSync;
    context.mock.method(fs, 'writeFileSync', (filename, ...args) => {
        if (String(filename).endsWith('.js.tmp')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        return write(filename, ...args);
    });
    assert.throws(() => store.save(project.id, { revision: project.revision, data: empty() }), /disk full/);
    assert.equal(store.open(project.id).project.snapshotCount, 1);
});

test('JS files are data-only and preserve inline image payloads and Chinese text', () => {
    const data = { ...empty(), nodes: [{ id: 'photo', type: 'image', position: { x: 2, y: 3 }, width: 64, height: 32, blobData: 'data:image/png;base64,aGVsbG8=', title: '末日场景' }] };
    assert.deepEqual(decodeProjectFile(encodeProjectFile(data)), data);
    assert.deepEqual(decodeProjectFile(JSON.stringify(data)), data);
    assert.throws(() => decodeProjectFile('export default (() => { globalThis.pwned = true; })();'));
    assert.throws(() => decodeProjectFile(encodeProjectFile(data) + 'alert(1)'));
    assert.equal(globalThis.pwned, undefined);
});

test('settings and path traversal are rejected', context => {
    const { store } = fixture(context);
    for (const settings of [{ intervalMinutes: 0, maxSnapshots: 10 }, { intervalMinutes: 5, maxSnapshots: 0 }, { intervalMinutes: 1.5, maxSnapshots: 5 }, { intervalMinutes: 121, maxSnapshots: 101 }]) assert.throws(() => validateProjectSettings(settings));
    assert.throws(() => store.open('../outside'), /ID/);
    assert.throws(() => store.create({ name: '', data: empty() }), /名称/);
    assert.throws(() => store.create({ name: 'bad', data: { nodes: [null], connections: [] } }), /无效节点/);
});

test('corrupt indexes appear as warnings without changing files', context => {
    const { store } = fixture(context);
    const project = store.create({ name: '外部更改', data: empty() });
    fs.writeFileSync(path.join(project.directory, 'project.json'), '{broken');
    assert.equal(store.list().warnings.length, 1);
    assert.equal(fs.readdirSync(project.directory).filter(name => name.endsWith('.js')).length, 1);
});


test('desktop project access accepts own interface addresses but not other LAN computers', () => {
    const interfaces = { ethernet: [{ address: '192.168.0.228' }, { address: '2001:db8::228' }], missing: undefined };
    const request = (remoteAddress, host) => ({ socket: { remoteAddress, localPort: 3004 }, headers: { host } });
    for (const [remoteAddress, host] of [
        ['127.0.0.1', 'localhost:3004'],
        ['::1', '[::1]:3004'],
        ['192.168.0.228', '192.168.0.228:3004'],
        ['::ffff:192.168.0.228', '192.168.0.228:3004'],
        ['2001:db8::228', '[2001:db8::228]:3004'],
    ]) assert.equal(isLocalProjectRequest(request(remoteAddress, host), interfaces), true);
    for (const [remoteAddress, host] of [
        ['192.168.0.229', '192.168.0.228:3004'],
        ['::ffff:192.168.0.229', '192.168.0.228:3004'],
        ['192.168.0.228', 'attacker.example:3004'],
        ['192.168.0.228', '192.168.0.228:9999'],
        ['192.168.0.228', '192.168.0.229:3004'],
    ]) assert.equal(isLocalProjectRequest(request(remoteAddress, host), interfaces), false);
    const spoofed = request('192.168.0.229', '192.168.0.228:3004');
    spoofed.headers['x-forwarded-for'] = '127.0.0.1';
    assert.equal(isLocalProjectRequest(spoofed, interfaces), false);
});

test('own-IP project requests retain same-origin checks and support save/reopen', async context => {
    const address = Object.values(os.networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal)?.address;
    if (!address) return context.skip('No non-loopback IPv4 interface');
    const { root } = fixture(context);
    const api = createCanvasProjectsMiddleware({ rootDirectory: root });
    const headers = { host: address + ':3004', origin: 'http://' + address + ':3004' };
    const options = { remoteAddress: address, headers };
    assert.equal((await call(api, 'GET', '/', null, options)).status, 200);
    assert.equal((await call(api, 'POST', '/', { name: 'unsafe', data: empty() }, { ...options, headers: { ...headers, origin: 'http://attacker.example' } })).status, 403);
    const created = await call(api, 'POST', '/', { name: '本机 IP 工程', data: empty() }, options);
    assert.equal(created.status, 200);
    const saved = await call(api, 'POST', '/' + created.project.id + '/snapshots', { revision: created.project.revision, data: empty() }, options);
    assert.equal(saved.status, 200);
    assert.equal(saved.project.snapshotCount, 2);
    assert.equal((await call(api, 'GET', '/' + created.project.id, null, options)).project.name, '本机 IP 工程');
});

async function call(middleware, method, url, payload, overrides = {}) {
    const request = Readable.from(payload ? [Buffer.from(JSON.stringify(payload))] : []);
    Object.assign(request, { method, url, headers: { host: 'localhost:3004', origin: 'http://localhost:3004', 'content-type': 'application/json', 'x-canvas-project-client': randomUUID(), ...overrides.headers }, socket: { localPort: 3004, remoteAddress: overrides.remoteAddress || '127.0.0.1' } });
    let result;
    const response = { statusCode: 0, setHeader: () => {}, end: value => { result = JSON.parse(value); } };
    await middleware(request, response);
    return { status: response.statusCode, ...result };
}

test('local API supports create/open/save/settings and rejects remote or cross-origin access', async context => {
    const { root } = fixture(context);
    const api = createCanvasProjectsMiddleware({ rootDirectory: root });
    assert.equal((await call(api, 'GET', '/', null, { remoteAddress: '192.168.1.2' })).status, 403);
    assert.equal((await call(api, 'POST', '/', { name: 'bad', data: empty() }, { headers: { origin: 'https://example.com' } })).status, 403);
    assert.equal((await call(api, 'GET', '/', null, { headers: { host: 'evil.example:3004' } })).status, 403);
    const created = await call(api, 'POST', '/', { name: 'API 工程', data: empty() });
    assert.equal(created.status, 200);
    assert.equal((await call(api, 'GET', '/' + created.project.id)).project.id, created.project.id);
    const saved = await call(api, 'POST', '/' + created.project.id + '/snapshots', { revision: created.project.revision, data: empty() });
    const configured = await call(api, 'PATCH', '/' + created.project.id + '/settings', { revision: saved.project.revision, settings: { intervalMinutes: 1, maxSnapshots: 1 } });
    assert.equal(configured.project.snapshotCount, 1);
});

test('autosave cadence is five minutes and overlapping ticks cannot double-save', async () => {
    let tick;
    let period;
    let finish;
    let calls = 0;
    let cleared;
    const timers = { setInterval: (callback, milliseconds) => { tick = callback; period = milliseconds; return 7; }, clearInterval: id => { cleared = id; } };
    const stop = startProjectAutosave(() => { calls += 1; return new Promise(resolve => { finish = resolve; }); }, 5, () => {}, timers);
    assert.equal(period, 300_000);
    const running = tick();
    await tick();
    assert.equal(calls, 1);
    finish();
    await running;
    stop();
    assert.equal(cleared, 7);
    await tick();
    assert.equal(calls, 1);
});

test('autosave failures report errors and allow the next scheduled retry', async () => {
    let tick;
    let errors = 0;
    let attempts = 0;
    const stop = startProjectAutosave(async () => { attempts += 1; if (attempts === 1) throw new Error('save failed'); }, 2, () => { errors += 1; }, { setInterval: callback => { tick = callback; return 1; }, clearInterval: () => {} });
    await tick();
    await tick();
    assert.equal(errors, 1);
    assert.equal(attempts, 2);
    stop();
});

test('renaming keeps project identity, settings and snapshots and updates future backup names', context => {
    const { root, store } = fixture(context);
    let project = store.create({ name: '旧工程名称', data: empty() });
    const originalId = project.id;
    const before = fs.readdirSync(project.directory).filter(filename => filename.endsWith('.js'));
    const stale = project;
    project = store.rename(project.id, { revision: project.revision, name: '新的工程名称' });
    assert.equal(project.id, originalId);
    assert.deepEqual(fs.readdirSync(project.directory).filter(filename => filename.endsWith('.js')), before);
    assert.equal(createProjectStore({ rootDirectory: root }).open(project.id).project.name, '新的工程名称');
    assert.throws(() => store.rename(project.id, { revision: stale.revision, name: '过期页面' }), /另一个页面/);
    project = store.save(project.id, { revision: project.revision, data: empty() });
    assert.equal(store.open(project.id).data.canvasProject.name, '新的工程名称');
    assert.deepEqual(project.settings, { intervalMinutes: 5, maxSnapshots: 5 });
    assert.throws(() => store.rename(project.id, { revision: project.revision, name: '  ' }), /名称/);
});

test('deleting moves only the confirmed project to trash and cannot be revived by a stale autosave', context => {
    const { root, store } = fixture(context);
    const selected = store.create({ name: '选中的工程', data: empty() });
    const other = store.create({ name: '不应改动', data: empty() });
    fs.writeFileSync(path.join(selected.directory, '用户文件.txt'), 'keep');
    assert.throws(() => store.remove(selected.id, { revision: selected.revision, confirmationId: other.id }), /确认/);
    assert.throws(() => store.remove(selected.id, { revision: 0, confirmationId: selected.id }), /另一个页面/);
    const result = store.remove(selected.id, { revision: selected.revision, confirmationId: selected.id });
    assert.equal(result.deletedId, selected.id);
    assert.equal(path.dirname(result.directory), path.join(root, '已删除工程'));
    assert.equal(fs.existsSync(selected.directory), false);
    assert.equal(fs.readFileSync(path.join(result.directory, '用户文件.txt'), 'utf8'), 'keep');
    assert.equal(fs.readdirSync(result.directory).filter(filename => filename.endsWith('.js')).length, 1);
    assert.deepEqual(store.list().projects.map(project => project.id), [other.id]);
    assert.throws(() => store.save(selected.id, { revision: selected.revision, data: empty() }), /不存在/);
    assert.equal(store.open(other.id).project.name, '不应改动');
});

test('rename and delete APIs validate local access and use the selected project revision', async context => {
    const { root } = fixture(context);
    const api = createCanvasProjectsMiddleware({ rootDirectory: root });
    const created = (await call(api, 'POST', '/', { name: 'API 操作', data: empty() })).project;
    const renamed = await call(api, 'PATCH', '/' + created.id + '/name', { revision: created.revision, name: '更新后的名称' });
    assert.equal(renamed.project.name, '更新后的名称');
    const deletion = { revision: renamed.project.revision, confirmationId: created.id };
    assert.equal((await call(api, 'POST', '/' + created.id + '/delete', deletion, { headers: { origin: 'https://example.com' } })).status, 403);
    assert.equal((await call(api, 'POST', '/' + created.id + '/delete', deletion)).deletedId, created.id);
    assert.equal((await call(api, 'GET', '/' + created.id)).status, 404);
});
