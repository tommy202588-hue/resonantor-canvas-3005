import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverProcessedImageOnce, downloadImageBlob, saveImageToUserComputer } from '../services/processedImageDownload.mjs';

const imageBlob = new Blob(['image'], { type: 'image/png' });
const unexpected = async () => { assert.fail('Unexpected folder access'); };

test('no selected folder or explicit browser preference downloads without requesting permissions', async () => {
    for (const directory of [null, { name: '浏览器下载目录', __download: true }]) {
        let downloads = 0;
        const result = await saveImageToUserComputer(imageBlob, 'generated.png', directory, {
            checkPermission: unexpected, writeFile: unexpected,
            download: (blob, filename) => {
                downloads += 1;
                assert.equal(blob, imageBlob);
                assert.equal(filename, 'generated.png');
            },
        });
        assert.equal(downloads, 1);
        assert.equal(result.browserState, 'requested');
        assert.match(result.browserMessage, /浏览器的下载设置/);
    }
});

test('selected folder receives generated images without duplicate browser downloads', async () => {
    const directory = { name: '我的图片' };
    let writes = 0;
    const result = await saveImageToUserComputer(imageBlob, 'generated.png', directory, {
        checkPermission: async (handle, request) => {
            assert.equal(handle, directory);
            assert.equal(request, false);
            return true;
        },
        writeFile: async (handle, filename, blob) => {
            writes += 1;
            assert.equal(handle, directory);
            assert.equal(filename, 'generated.png');
            assert.equal(blob, imageBlob);
        },
        download: unexpected,
    });
    assert.equal(writes, 1);
    assert.equal(result.browserState, 'saved');
    assert.match(result.browserMessage, /我的图片/);
});

test('revoked folder permission and failed writes fall back without claiming a folder save', async () => {
    for (const failure of ['denied', 'permission-error', 'write-error']) {
        let downloads = 0;
        const result = await saveImageToUserComputer(imageBlob, 'result.png', { name: '作品' }, {
            checkPermission: async (_handle, request) => {
                assert.equal(request, false);
                if (failure === 'permission-error') throw new Error('权限查询失败');
                return failure !== 'denied';
            },
            writeFile: async () => {
                assert.equal(failure, 'write-error');
                throw new Error('磁盘不可写');
            },
            download: () => { downloads += 1; },
        });
        assert.equal(downloads, 1);
        assert.equal(result.browserState, 'requested');
        assert.match(result.browserMessage, /重新授权|权限查询失败|磁盘不可写/);
        assert.doesNotMatch(result.browserMessage, /已自动保存到/);
    }
});

test('failed browser download is surfaced for manual retry', async () => {
    await assert.rejects(saveImageToUserComputer(imageBlob, 'result.png', null, {
        checkPermission: unexpected, writeFile: unexpected,
        download: () => { throw new Error('下载不可用'); },
    }), /下载不可用/);
});

const requested = { browserState: 'requested', browserMessage: '已触发浏览器下载' };
const storageFixture = () => {
    const values = new Map();
    return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
};

test('processing completion delivers once across concurrent polling and module reload', async () => {
    const storage = storageFixture();
    let saves = 0;
    const save = async () => { saves += 1; return requested; };
    await Promise.all([
        deliverProcessedImageOnce('concurrent', save, storage),
        deliverProcessedImageOnce('concurrent', save, storage),
    ]);
    const reloaded = await import('../services/processedImageDownload.mjs?reload');
    assert.deepEqual(await reloaded.deliverProcessedImageOnce('concurrent', save, storage), requested);
    assert.equal(saves, 1);
});

test('both processing modes and retries with new task IDs deliver independently', async () => {
    let saves = 0;
    for (const taskId of ['background', 'upscale', 'background-retry']) {
        await deliverProcessedImageOnce(taskId, async () => { saves += 1; return requested; }, storageFixture());
    }
    assert.equal(saves, 3);
});

test('download failure returns a warning instead of failing image processing', async () => {
    const result = await deliverProcessedImageOnce('failure', async () => { throw new Error('下载被阻止'); }, storageFixture());
    assert.equal(result.browserState, 'failed');
    assert.match(result.browserMessage, /下载被阻止/);
});

test('unavailable or corrupt storage does not prevent downloading', async () => {
    const unavailable = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    assert.deepEqual(await deliverProcessedImageOnce('unavailable', async () => requested, unavailable), requested);
    assert.deepEqual(await deliverProcessedImageOnce('corrupt', async () => requested, { getItem: () => '{', setItem: () => {} }), requested);
});

test('selected-folder success persists its accurate save status', async () => {
    const saved = { browserState: 'saved', browserMessage: '已自动保存到「作品」' };
    const storage = storageFixture();
    assert.deepEqual(await deliverProcessedImageOnce('folder', async () => saved, storage), saved);
    assert.deepEqual(JSON.parse(storage.getItem('canvas-processed-download:folder')), saved);
});

test('browser download clicks a PNG download link and releases resources later', context => {
    let clicks = 0;
    let removed = false;
    let cleanup;
    const link = { style: {}, click: () => { clicks += 1; }, remove: () => { removed = true; } };
    context.mock.method(URL, 'createObjectURL', () => 'blob:test-result');
    const revoke = context.mock.method(URL, 'revokeObjectURL', () => {});
    context.mock.method(globalThis, 'setTimeout', callback => { cleanup = callback; return 0; });
    const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
        createElement: tag => { assert.equal(tag, 'a'); return link; },
        body: { appendChild: element => assert.equal(element, link) },
    } });
    context.after(() => { if (original) Object.defineProperty(globalThis, 'document', original); else delete globalThis.document; });
    downloadImageBlob(new Blob(['png'], { type: 'image/png' }), '去背景-result.png');
    assert.equal(clicks, 1);
    assert.equal(link.download, '去背景-result.png');
    assert.equal(link.href, 'blob:test-result');
    assert.equal(removed, true);
    assert.equal(revoke.mock.callCount(), 0);
    cleanup();
    assert.equal(revoke.mock.callCount(), 1);
});
