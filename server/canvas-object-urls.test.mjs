import test from 'node:test';
import assert from 'node:assert/strict';
import { createObjectUrlTracker } from '../services/canvasObjectUrls.mjs';
import { createCanvasHistory } from '../services/canvasHistory.mjs';

const state = nodes => ({ nodes, connections: [], groups: [], selectedNodeIds: [], selectedGroupId: null, selectedConnectionId: null });

test('deleted images remain readable through undo, then release on project replacement', async () => {
    const blob = new Blob(['original image'], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const tracker = createObjectUrlTracker();
    const history = createCanvasHistory();
    const before = state([{ id: 'image', type: 'image', content: url, blob }]);
    try {
        tracker.update(before);
        history.record(before, state([]));
        tracker.update(state([]), history.getObjectUrls());
        assert.equal(await (await fetch(url)).text(), 'original image');
        const restored = history.undo(state([]));
        tracker.update(restored, history.getObjectUrls());
        assert.equal(await (await fetch(restored.nodes[0].content)).text(), 'original image');
        history.clear();
        tracker.update(state([]), history.getObjectUrls());
        await assert.rejects(fetch(url));
    } finally { tracker.clear(); URL.revokeObjectURL(url); }
});

test('shared multi-image, preview and generation history references release only once', () => {
    const revoked = [];
    const tracker = createObjectUrlTracker(url => revoked.push(url));
    tracker.update([{ content: 'blob:first', allImages: ['blob:first', 'blob:second'] }]);
    tracker.update([], [{ content: 'blob:first' }], { url: 'blob:second' });
    assert.deepEqual(revoked, []);
    tracker.update([], [{ content: 'blob:first' }], null);
    assert.deepEqual(revoked, ['blob:second']);
    tracker.clear();
    tracker.clear();
    assert.deepEqual(revoked, ['blob:second', 'blob:first']);
});

test('expired undo entries release deleted media without affecting current nodes', () => {
    const revoked = [];
    const tracker = createObjectUrlTracker(url => revoked.push(url));
    const history = createCanvasHistory({ limit: 1 });
    const before = state([{ id: 'old', content: 'blob:old' }]);
    tracker.update(before);
    history.record(before, state([]));
    tracker.update(state([]), history.getObjectUrls());
    assert.deepEqual(revoked, []);
    const next = state([{ id: 'new', content: 'blob:new' }]);
    history.record(state([]), next);
    tracker.update(next, history.getObjectUrls());
    assert.deepEqual(revoked, ['blob:old']);
});
