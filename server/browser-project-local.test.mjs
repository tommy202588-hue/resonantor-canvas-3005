import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserProjectDirectory, isProjectStorageReady } from '../services/browserProjectDirectory.mjs';
import { decodeProjectFile, encodeProjectFile } from '../services/projectFile.mjs';

const data = (content = '局域网草稿') => ({
    version: 1, nodes: [{ id: 'text', type: 'text', position: { x: 10, y: 20 }, width: 300, height: 200, content }],
    connections: [], groups: [], viewport: { x: 12, y: 34, k: 0.8 },
});
const memoryStorage = () => {
    const values = new Map();
    let flight = Promise.resolve();
    return {
        values,
        failWrite: false,
        maxSnapshots: Infinity,
        async get(key) { return structuredClone(values.get(key)); },
        async keys() { return [...values.keys()]; },
        update(key, operation) {
            const next = flight.catch(() => {}).then(() => {
                const result = operation(structuredClone(values.get(key)));
                if (this.failWrite || result.snapshots.length > this.maxSnapshots) throw new DOMException('Storage full', 'QuotaExceededError');
                values.set(key, structuredClone(result));
            });
            flight = next;
            return next;
        },
    };
};
const controller = (storage, account = 'alice', environment = { isSecureContext: false }) => createBrowserProjectDirectory(account, { storage, environment });

test('LAN HTTP and browsers without a picker create, save and reopen local projects', async () => {
    for (const environment of [{ isSecureContext: false }, { isSecureContext: true, crypto: globalThis.crypto }]) {
        const storage = memoryStorage();
        const store = controller(storage, 'alice', environment);
        assert.equal(store.state, 'browser');
        assert.equal(isProjectStorageReady(store.state), true);
        assert.equal(await store.authorize(), false);
        let { project } = await store.create('局域网工程', data(), '');
        assert.deepEqual(project.settings, { intervalMinutes: 5, maxSnapshots: 5 });
        for (let revision = 2; revision <= 8; revision += 1) ({ project } = await store.save(project, data('第' + revision + '版'), ''));
        const reloaded = controller(storage, 'alice', environment);
        await reloaded.restore();
        assert.equal((await reloaded.list()).projects.length, 1);
        assert.equal(project.snapshotCount, 5);
        assert.equal([...storage.values.values()][0].snapshots.length, 5);
        const opened = await reloaded.open(project.id);
        assert.deepEqual(opened.data, data('第8版'));
        assert.deepEqual(decodeProjectFile(encodeProjectFile(opened.data)), opened.data);
    }
});

test('local snapshots preserve serialized media, connections, groups and viewport', async () => {
    const storage = memoryStorage();
    const store = controller(storage);
    const contents = data();
    contents.nodes.push({ id: 'image', type: 'image', position: { x: 400, y: 20 }, width: 100, height: 100, blobData: 'data:image/png;base64,dGVzdA==', groupId: 'group' });
    contents.connections.push({ id: 'connection', fromNodeId: 'text', toNodeId: 'image' });
    contents.groups.push({ id: 'group', title: '分组', position: { x: 0, y: 0 }, width: 800, height: 400 });
    const { project } = await store.create('媒体', contents, '');
    contents.nodes[0].content = '外部更改';
    const opened = await store.open(project.id);
    assert.equal(opened.data.nodes[0].content, '局域网草稿');
    assert.equal(opened.data.nodes[1].blobData, contents.nodes[1].blobData);
    assert.deepEqual(opened.data.connections, contents.connections);
    assert.deepEqual(opened.data.groups, contents.groups);
    assert.deepEqual(opened.data.viewport, contents.viewport);
});

test('account namespaces and anonymous guards protect project access and writes', async () => {
    const storage = memoryStorage();
    const alice = controller(storage);
    const bob = controller(storage, 'bob');
    const anonymous = controller(storage, '');
    const { project } = await alice.create('Alice 工程', data(), '');
    assert.equal((await bob.list()).projects.length, 0);
    await assert.rejects(bob.open(project.id), { code: 'not_found' });
    await assert.rejects(bob.save(project, data(), ''), { code: 'not_found' });
    await assert.rejects(bob.remove(project), { code: 'not_found' });
    await assert.rejects(anonymous.list(), { code: 'login_required' });
    await assert.rejects(anonymous.create('匿名', data(), ''), { code: 'login_required' });
    assert.equal((await alice.open(project.id)).project.revision, 1);
});

test('atomic updates reject simultaneous stale edits and preserve other projects', async () => {
    const storage = memoryStorage();
    const first = controller(storage);
    const second = controller(storage);
    const { project } = await first.create('并发', data(), '');
    const { project: other } = await first.create('另一个工程', data(), '');
    const results = await Promise.allSettled([first.save(project, data('第一版'), ''), second.save(project, data('第二版'), '')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'revision_conflict');
    assert.equal((await first.open(other.id)).project.revision, 1);
    await assert.rejects(second.rename(project, '过期名称'), { code: 'revision_conflict' });
    await assert.rejects(second.remove(project), { code: 'revision_conflict' });
});

test('quota failures retain previous data and report the failed save', async () => {
    const storage = memoryStorage();
    const store = controller(storage);
    const { project } = await store.create('空间不足', data('已保存'), '');
    storage.failWrite = true;
    await assert.rejects(store.save(project, data('未保存'), ''), { code: 'browser_storage_full' });
    const opened = await store.open(project.id);
    assert.equal(opened.project.revision, 1);
    assert.equal(opened.data.nodes[0].content, '已保存');
});

test('one unreadable project does not hide readable projects or delete stored records', async () => {
    const storage = memoryStorage();
    const store = controller(storage);
    const first = await store.create('暂不可读', data('旧内容'));
    const second = await store.create('正常工程', data('可读内容'));
    const originalGet = storage.get;
    storage.get = async key => {
        if (key.endsWith(first.project.id)) throw new Error('Simulated record read failure');
        return originalGet(key);
    };
    const listed = await store.list();
    assert.deepEqual(listed.projects.map(project => project.id), [second.project.id]);
    assert.ok(listed.warnings.some(warning => warning.includes('暂时读取失败')));
    assert.equal(storage.values.size, 2);
    storage.get = originalGet;
    assert.equal((await store.list()).projects.length, 2);
    assert.equal((await store.open(first.project.id)).data.nodes[0].content, '旧内容');
});

test('quota from accumulated backups atomically saves the latest snapshot and reports reduced retention', async () => {
    const storage = memoryStorage();
    const store = controller(storage);
    let { project } = await store.create('图片工程', data('初稿'));
    ({ project } = await store.save(project, data('第二稿')));
    storage.maxSnapshots = 2;
    const saved = await store.save(project, data('最新完整工程'));
    assert.equal(saved.project.snapshotCount, 1);
    assert.equal(saved.project.settings.maxSnapshots, 5);
    assert.match(saved.project.warning, /仅保留最新快照/);
    const reopened = await store.open(project.id);
    assert.equal(reopened.data.nodes[0].content, '最新完整工程');
    assert.equal(reopened.project.revision, project.revision + 1);
    storage.failWrite = true;
    await assert.rejects(store.save(saved.project, data('失败的写入')), { code: 'browser_storage_full' });
    assert.equal((await store.open(project.id)).data.nodes[0].content, '最新完整工程');
});

test('rename, settings and logical deletion respect validation and snapshot limits', async () => {
    const storage = memoryStorage();
    const store = controller(storage);
    let { project } = await store.create('原名', data(), '');
    ({ project } = await store.save(project, data('已更新'), ''));
    ({ project } = await store.configure(project, { intervalMinutes: 2, maxSnapshots: 1 }));
    assert.equal(project.snapshotCount, 1);
    await assert.rejects(store.configure(project, { intervalMinutes: 0, maxSnapshots: 1 }));
    await assert.rejects(store.rename(project, '   '), { code: 'invalid_name' });
    ({ project } = await store.rename(project, '新名'));
    assert.equal((await store.list()).projects[0].name, '新名');
    await store.remove(project);
    assert.equal((await store.list()).projects.length, 0);
    await assert.rejects(store.open(project.id), { code: 'not_found' });
    assert.equal([...storage.values.values()][0].snapshots[0].data.nodes[0].content, '已更新');
});

test('binary media snapshots reopen independently and coexist with legacy base64 backups', async () => {
    const storage = memoryStorage();
    const store = controller(storage);
    const legacy = data('旧版');
    legacy.nodes.push({ id: 'image', type: 'image', position: { x: 400, y: 20 }, width: 100, height: 100, blobData: 'data:image/png;base64,dGVzdA==' });
    let { project } = await store.create('兼容备份', legacy);
    const binary = data('新版');
    binary.nodes.push({ id: 'image', type: 'image', position: { x: 400, y: 20 }, width: 100, height: 100, allBlobs: [new Blob(['first'], { type: 'image/png' }), new Blob(['second'], { type: 'image/png' })], currentImageIndex: 1 });
    ({ project } = await store.save(project, binary));
    binary.nodes[0].content = '保存后的外部修改';
    binary.nodes[1].allBlobs.pop();
    const opened = await store.open(project.id);
    assert.equal(opened.data.nodes[0].content, '新版');
    assert.deepEqual(await Promise.all(opened.data.nodes[1].allBlobs.map(blob => blob.text())), ['first', 'second']);
    opened.data.nodes[1].allBlobs.length = 0;
    assert.equal((await store.open(project.id)).data.nodes[1].allBlobs.length, 2);
    const saved = [...storage.values.values()][0];
    assert.equal(saved.snapshots[0].data.nodes[1].blobData, legacy.nodes[1].blobData);
    storage.failWrite = true;
    await assert.rejects(store.configure(project, { intervalMinutes: 1, maxSnapshots: 1 }), { code: 'browser_storage_full' });
    assert.equal((await store.open(project.id)).project.snapshotCount, 2);
    assert.equal((await store.open(project.id)).project.settings.maxSnapshots, 5);
});
