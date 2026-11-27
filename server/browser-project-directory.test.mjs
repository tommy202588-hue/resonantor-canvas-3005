import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserProjectDirectoryStore, validateDirectoryMetadata, PROJECT_DIRECTORY_NAME } from '../services/browserProjectDirectoryStore.mjs';
import { createBrowserProjectDirectory, browserDirectoryError } from '../services/browserProjectDirectory.mjs';
import { decodeProjectFile } from '../services/projectFile.mjs';

class MemoryDirectory {
    constructor(name = 'Desktop', controls = { permission: 'granted' }) {
        this.name = name;
        this.kind = 'directory';
        this.children = new Map();
        this.controls = controls;
    }
    async queryPermission() { return this.controls.permission; }
    requestPermission() {
        this.controls.requested = (this.controls.requested || 0) + 1;
        this.controls.permission = this.controls.denyRequest ? 'denied' : 'granted';
        return Promise.resolve(this.controls.permission);
    }
    async isSameEntry(other) { return this === other; }
    check(name) {
        assert.ok(typeof name === 'string' && name && !name.includes('/') && !name.includes('\\') && name !== '..');
        if (this.controls.permission !== 'granted') throw new DOMException('Permission denied', 'NotAllowedError');
    }
    async getDirectoryHandle(name, { create = false } = {}) {
        this.check(name);
        if (!this.children.has(name) && create) this.children.set(name, new MemoryDirectory(name, this.controls));
        const child = this.children.get(name);
        if (!child) throw new DOMException('Missing directory', 'NotFoundError');
        assert.equal(child.kind, 'directory');
        return child;
    }
    async getFileHandle(name, { create = false } = {}) {
        this.check(name);
        if (!this.children.has(name) && create) {
            const file = { kind: 'file', name, text: '' };
            file.getFile = async () => { this.check(name); return new File([file.text], name); };
            file.createWritable = async () => {
                let pending = '';
                return {
                    write: async content => {
                        this.check(name);
                        if (this.controls.failWrite?.(name)) throw new DOMException('Full disk', 'QuotaExceededError');
                        pending = String(content);
                    },
                    close: async () => {
                        this.check(name);
                        if (this.controls.failClose?.(name)) throw new Error('Commit failed');
                        file.text = pending;
                    },
                    abort: async () => { pending = ''; this.controls.aborted = true; },
                };
            };
            this.children.set(name, file);
        }
        const child = this.children.get(name);
        if (!child) throw new DOMException('Missing file', 'NotFoundError');
        assert.equal(child.kind, 'file');
        return child;
    }
    async *entries() { for (const entry of this.children) { this.check(entry[0]); yield entry; } }
    async removeEntry(name, options) {
        this.check(name);
        assert.equal(options, undefined);
        if (this.controls.failRemove) throw new Error('File in use');
        if (!this.children.has(name)) throw new DOMException('Missing file', 'NotFoundError');
        assert.equal(this.children.get(name).kind, 'file');
        this.children.delete(name);
    }
}

const data = (text = '灵感') => ({
    version: 1, nodes: [{ id: 'text-node', type: 'text', position: { x: 20, y: 40 }, width: 300, height: 200, content: text }],
    connections: [], groups: [], viewport: { x: 15, y: 25, k: 1.2 },
});
const metadata = (root, id) => JSON.parse(root.children.get(id).children.get('project.json').text);
const snapshots = (root, id) => [...root.children.get(id).children.keys()].filter(name => name.endsWith('.js'));
const memoryStorage = () => {
    const values = new Map();
    return { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); } };
};
const setupController = (account = 'alice', desktop = new MemoryDirectory(), storage = memoryStorage()) => {
    const environment = { isSecureContext: true, crypto: globalThis.crypto, showDirectoryPicker: () => { environment.calls += 1; return Promise.resolve(desktop); }, calls: 0 };
    const controller = createBrowserProjectDirectory(account, { environment, storage });
    return { controller, environment, desktop, storage };
};

test('directory projects retain five compatible JS snapshots and reopen all canvas data', async () => {
    const root = new MemoryDirectory();
    const store = createBrowserProjectDirectoryStore(root);
    let { project } = await store.create('首个工程', data(), '');
    for (let revision = 2; revision <= 8; revision += 1) ({ project } = await store.save(project, data('保存 ' + revision), ''));
    assert.equal(project.revision, 8);
    assert.equal(project.snapshotCount, 5);
    assert.equal(snapshots(root, project.id).length, 5);
    assert.equal((await store.list()).projects.length, 1);
    const opened = await store.open(project.id);
    assert.equal(opened.data.nodes[0].content, '保存 8');
    assert.deepEqual(opened.data.viewport, data().viewport);
    assert.deepEqual(opened.data.canvasProject, { id: project.id, name: project.name, savedAt: project.lastSavedAt });
    assert.ok(root.children.get(project.id).children.get(metadata(root, project.id).snapshots[0].filename).text.startsWith('export default '));
});

test('rename, retention settings and logical deletion never delete unrelated files', async () => {
    const root = new MemoryDirectory();
    const store = createBrowserProjectDirectoryStore(root);
    let { project } = await store.create('原名', data(), '');
    ({ project } = await store.save(project, data(), ''));
    ({ project } = await store.configure(project, { intervalMinutes: 2, maxSnapshots: 1 }));
    assert.equal(snapshots(root, project.id).length, 1);
    ({ project } = await store.rename(project, '新名'));
    ({ project } = await store.save(project, data(), ''));
    assert.equal((await store.open(project.id)).data.canvasProject.name, '新名');
    const directory = root.children.get(project.id);
    await directory.getFileHandle('重要资料.txt', { create: true });
    await store.remove(project);
    assert.equal((await store.list()).projects.length, 0);
    assert.ok(directory.children.has('重要资料.txt'));
    assert.equal(snapshots(root, project.id).length, 1);
    await assert.rejects(store.open(project.id), { code: 'project_deleted' });
    const backup = directory.children.get(snapshots(root, project.id)[0]);
    assert.equal(decodeProjectFile(backup.text).nodes.length, 1);
});

test('failed snapshot writes do not advance metadata or delete the last valid backup', async () => {
    const root = new MemoryDirectory();
    const store = createBrowserProjectDirectoryStore(root);
    const { project } = await store.create('保护备份', data('原版'), '');
    const previous = metadata(root, project.id);
    root.controls.failWrite = name => name.endsWith('.js');
    await assert.rejects(store.save(project, data('未保存'), ''), { name: 'QuotaExceededError' });
    assert.deepEqual(metadata(root, project.id), previous);
    assert.equal((await store.open(project.id)).data.nodes[0].content, '原版');
    assert.ok(root.controls.aborted);
});

test('failed metadata commit retains old index and recoverable newly written snapshot', async () => {
    const root = new MemoryDirectory();
    const store = createBrowserProjectDirectoryStore(root);
    const { project } = await store.create('保护索引', data('原版'), '');
    const previous = metadata(root, project.id);
    root.controls.failClose = name => name === 'project.json';
    await assert.rejects(store.save(project, data('新草稿'), ''), /Commit failed/);
    assert.deepEqual(metadata(root, project.id), previous);
    assert.equal(snapshots(root, project.id).length, 2);
    assert.equal((await store.open(project.id)).data.nodes[0].content, '原版');
});

test('prune failures warn and are retried without endangering retained snapshots', async () => {
    const root = new MemoryDirectory();
    const store = createBrowserProjectDirectoryStore(root);
    let { project } = await store.create('备份清理', data(), '');
    ({ project } = await store.save(project, data(), ''));
    root.controls.failRemove = true;
    ({ project } = await store.configure(project, { intervalMinutes: 5, maxSnapshots: 1 }));
    assert.match(project.warning, /旧备份/);
    assert.equal(snapshots(root, project.id).length, 2);
    root.controls.failRemove = false;
    ({ project } = await store.save(project, data('最新'), ''));
    assert.equal(snapshots(root, project.id).length, 1);
    assert.equal((await store.open(project.id)).data.nodes[0].content, '最新');
});

test('simultaneous writers serialize, with stale revisions rejected instead of overwritten', async () => {
    const root = new MemoryDirectory();
    const first = createBrowserProjectDirectoryStore(root);
    const second = createBrowserProjectDirectoryStore(root);
    const { project } = await first.create('并发', data(), '');
    const results = await Promise.allSettled([first.save(project, data('first'), ''), second.save(project, data('second'), '')]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.find(result => result.status === 'rejected').reason.code, 'revision_conflict');
    assert.equal((await first.open(project.id)).project.revision, 2);
});

test('browser Web Locks wrap both reads and mutations', async () => {
    const names = [];
    const root = new MemoryDirectory();
    const store = createBrowserProjectDirectoryStore(root, { locks: { request: async (name, options, operation) => { names.push(name); assert.equal(options.mode, 'exclusive'); return operation(); } } });
    const { project } = await store.create('锁', data(), '');
    await store.open(project.id);
    await store.save(project, data(), '');
    assert.deepEqual(names, Array(3).fill('gzt-project-directory:' + project.id));
});

test('malformed snapshot paths and metadata cannot access or remove unrelated entries', async () => {
    const root = new MemoryDirectory();
    const store = createBrowserProjectDirectoryStore(root);
    const { project } = await store.create('边界', data(), '');
    for (const field of ['snapshots', 'retiredSnapshots']) {
        const value = metadata(root, project.id);
        value[field] = field === 'snapshots' ? [{ filename: '../重要资料.js', savedAt: Date.now() }] : ['../重要资料.js'];
        assert.throws(() => validateDirectoryMetadata(value, project.id), { code: 'invalid_project' });
    }
    assert.throws(() => store.open('../other'), { code: 'invalid_project' });
    await root.getDirectoryHandle('私人文件夹', { create: true });
    assert.equal((await store.list()).projects.length, 1);
    assert.throws(() => store.configure(project, { intervalMinutes: 0, maxSnapshots: 0 }));
});

test('corrupt newest snapshot falls back to a validated older backup', async () => {
    const root = new MemoryDirectory();
    const store = createBrowserProjectDirectoryStore(root);
    let { project } = await store.create('回退', data('older'), '');
    ({ project } = await store.save(project, data('newer'), ''));
    root.children.get(project.id).children.get(metadata(root, project.id).snapshots[0].filename).text = 'throw new Error("never execute")';
    const result = await store.open(project.id);
    assert.equal(result.data.nodes[0].content, 'older');
    assert.match(result.project.warning, /较早/);
});

test('picker starts synchronously from click and existing project root is not nested twice', async () => {
    const fixture = setupController('alice', new MemoryDirectory(PROJECT_DIRECTORY_NAME));
    const flight = fixture.controller.authorize();
    assert.equal(fixture.environment.calls, 1);
    await flight;
    assert.equal(fixture.controller.state, 'ready');
    assert.equal(fixture.desktop.children.has(PROJECT_DIRECTORY_NAME), false);
    const created = await fixture.controller.create('本机', data(), '');
    assert.match(created.project.directory, /^共智体画布工程\/账户-/);
});

test('permission restoration never opens dialogs; revoked access requires explicit click', async () => {
    const fixture = setupController();
    await fixture.controller.authorize();
    const { project } = await fixture.controller.create('权限', data(), '');
    fixture.desktop.controls.permission = 'prompt';
    const reloaded = createBrowserProjectDirectory('alice', { storage: fixture.storage, environment: fixture.environment });
    await reloaded.restore();
    assert.equal(reloaded.state, 'permission');
    assert.equal(fixture.desktop.controls.requested, undefined);
    assert.equal(fixture.environment.calls, 1);
    await assert.rejects(reloaded.save(project, data(), ''), { code: 'directory_permission_required' });
    const authorization = reloaded.authorize();
    assert.equal(fixture.desktop.controls.requested, 1);
    await authorization;
    assert.equal(reloaded.state, 'ready');
    assert.equal((await reloaded.list()).projects[0].id, project.id);
    fixture.desktop.controls.permission = 'denied';
    await assert.rejects(reloaded.save(project, data(), ''), { code: 'directory_permission_required' });
    assert.equal(reloaded.state, 'permission');
});

test('accounts use separate handle keys, draft scopes and disk directories on the same desktop', async () => {
    const fixture = setupController();
    await fixture.controller.authorize();
    await fixture.controller.create('Alice 的工程', data(), '');
    const other = createBrowserProjectDirectory('bob', { storage: fixture.storage, environment: fixture.environment });
    await other.restore();
    assert.equal(other.state, 'unselected');
    await other.authorize();
    assert.notEqual(other.scope, fixture.controller.scope);
    assert.equal((await other.list()).projects.length, 0);
    assert.notEqual(other.directory, fixture.controller.directory);
    assert.equal((await fixture.controller.list()).projects.length, 1);
});

test('cancelled picker, double clicks and failed pre-switch save preserve original directory', async () => {
    const fixture = setupController();
    await fixture.controller.authorize();
    const original = fixture.controller.scope;
    fixture.environment.showDirectoryPicker = () => Promise.reject(new DOMException('Cancelled', 'AbortError'));
    await assert.rejects(fixture.controller.authorize({ change: true }), { code: 'directory_cancelled' });
    assert.equal(fixture.controller.scope, original);
    let release;
    fixture.environment.showDirectoryPicker = () => new Promise(resolve => { release = resolve; });
    const first = fixture.controller.authorize({ change: true, beforeSwitch: async () => { throw new Error('Unsaved edits'); } });
    assert.equal(await fixture.controller.authorize({ change: true }), false);
    release(new MemoryDirectory('OtherDesktop'));
    await assert.rejects(first, /Unsaved edits/);
    assert.equal(fixture.controller.scope, original);
    assert.equal(fixture.controller.state, 'ready');
});

test('unsupported directory contexts select browser storage without a picker; anonymous directory writes remain blocked', async () => {
    const fixture = setupController();
    const insecure = createBrowserProjectDirectory('alice', { storage: fixture.storage, environment: { ...fixture.environment, isSecureContext: false } });
    assert.equal(insecure.state, 'browser');
    assert.equal(await insecure.authorize(), false);
    const anonymous = createBrowserProjectDirectory('', { storage: fixture.storage, environment: fixture.environment });
    await assert.rejects(anonymous.authorize(), { code: 'login_required' });
    assert.equal(fixture.environment.calls, 0);
    assert.equal(browserDirectoryError(new DOMException('disk full', 'QuotaExceededError')).code, 'directory_full');
});
