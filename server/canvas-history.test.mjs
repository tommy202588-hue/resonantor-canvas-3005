import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasHistory } from '../services/canvasHistory.mjs';

const node = (id, overrides = {}) => ({ id, type: 'image', position: { x: 10, y: 20 }, width: 300, height: 240, status: 'idle', ...overrides });
const state = (nodes = [], overrides = {}) => ({ nodes, connections: [], groups: [], selectedNodeIds: [], selectedGroupId: null, selectedConnectionId: null, ...overrides });
const move = (original, id, position) => ({ ...original, nodes: original.nodes.map(item => item.id === id ? { ...item, position } : item) });

test('undo follows add, drag, add, delete in exact reverse operation order', () => {
    const history = createCanvasHistory();
    const initial = state();
    const added = state([node('first')]);
    const dragged = move(added, 'first', { x: 400, y: 120 });
    const secondAdded = { ...dragged, nodes: [...dragged.nodes, node('second')] };
    const deleted = { ...secondAdded, nodes: secondAdded.nodes.filter(item => item.id !== 'first') };
    const steps = [initial, added, dragged, secondAdded, deleted];
    for (let index = 1; index < steps.length; index += 1) history.record(steps[index - 1], steps[index]);
    let current = deleted;
    for (const expected of steps.slice(0, -1).reverse()) {
        current = history.undo(current);
        assert.deepEqual(current, expected);
    }
    assert.equal(history.undo(current), null);
});

test('a long multi-node drag including group membership is one step', () => {
    let time = 0;
    const history = createCanvasHistory({ now: () => time });
    const before = state([node('first'), node('second', { position: { x: 200, y: 400 } })], { groups: [{ id: 'group', position: { x: 600, y: 0 }, width: 500, height: 600 }] });
    let current = before;
    for (let frame = 1; frame <= 80; frame += 1) {
        time += 200;
        const after = { ...current, nodes: current.nodes.map(item => ({ ...item, position: { x: item.position.x + 5, y: item.position.y + 2 }, ...(frame === 80 ? { groupId: 'group' } : {}) })) };
        history.record(current, after, { key: 'drag', continuous: true, scope: { nodes: { ids: ['first', 'second'], fields: ['position', 'groupId'] } } });
        current = after;
    }
    assert.equal(history.size, 1);
    assert.deepEqual(history.undo(current), before);
});

test('separate gestures remain separate even on the same node', () => {
    const history = createCanvasHistory();
    const initial = state([node('first')]);
    const first = move(initial, 'first', { x: 80, y: 40 });
    const second = move(first, 'first', { x: 180, y: 90 });
    history.record(initial, first, { key: 'drag', continuous: true });
    history.breakMerge();
    history.record(first, second, { key: 'drag', continuous: true });
    assert.equal(history.size, 2);
    assert.deepEqual(history.undo(second), first);
    assert.deepEqual(history.undo(first), initial);
});

test('clicks, selection, equal params and a drag returning to start add no undo step', () => {
    const history = createCanvasHistory();
    const before = state([node('first', { params: { model: 'model', batchSize: 1 } })]);
    history.record(before, { ...before, selectedNodeIds: ['first'], nodes: before.nodes.map(item => ({ ...item, groupId: undefined, params: { ...item.params, voice: undefined }, position: { ...item.position } })) });
    assert.equal(history.size, 0);
    const moved = move(before, 'first', { x: 500, y: 300 });
    history.record(before, moved, { key: 'drag', continuous: true });
    history.record(moved, before, { key: 'drag', continuous: true });
    assert.equal(history.size, 0);
    assert.equal(history.undo(before), null);
});

test('undoing layout preserves both concurrent and later generation results', () => {
    const history = createCanvasHistory();
    const image = new Blob(['completed image'], { type: 'image/png' });
    const before = state([node('first', { status: 'loading', progress: 15 }), node('second', { status: 'loading' })]);
    const after = { ...move(before, 'first', { x: 200, y: 200 }), nodes: [node('first', { position: { x: 200, y: 200 }, status: 'success', progress: 100, blob: image, content: 'blob:first' }), before.nodes[1]] };
    history.record(before, after, { scope: { nodes: { ids: ['first'], fields: ['position'] } } });
    const completed = { ...after, nodes: [after.nodes[0], { ...after.nodes[1], status: 'success', content: 'blob:second', progress: 100 }] };
    const restored = history.undo(completed);
    assert.deepEqual(restored.nodes[0].position, before.nodes[0].position);
    assert.equal(restored.nodes[0].blob, image);
    assert.equal(restored.nodes[0].status, 'success');
    assert.deepEqual(restored.nodes[1], completed.nodes[1]);
});

test('field-level undo does not overwrite newer non-history changes', () => {
    const history = createCanvasHistory();
    const before = state([node('first', { title: 'Original' })]);
    const after = state([{ ...before.nodes[0], title: 'Renamed', width: 500 }]);
    history.record(before, after);
    const completed = state([{ ...after.nodes[0], title: 'Generated title', status: 'success', content: 'blob:new' }]);
    const restored = history.undo(completed);
    assert.equal(restored.nodes[0].width, before.nodes[0].width);
    assert.equal(restored.nodes[0].title, 'Generated title');
    assert.equal(restored.nodes[0].content, 'blob:new');
});

test('node deletion restores associated connections and selection in a single step', () => {
    const history = createCanvasHistory();
    const before = state([node('first'), node('second'), node('third')], { connections: [{ id: 'edge', fromNodeId: 'first', toNodeId: 'second' }], selectedNodeIds: ['first', 'second'] });
    const deleted = state([before.nodes[2]]);
    history.record(before, deleted);
    assert.deepEqual(history.undo(deleted), before);
    assert.equal(history.size, 0);
});

test('group creation, movement with children, and dissolution undo as whole operations', () => {
    const history = createCanvasHistory();
    const initial = state([node('first'), node('second')]);
    const grouped = state(initial.nodes.map(item => ({ ...item, groupId: 'group' })), { groups: [{ id: 'group', title: 'Group', position: { x: 0, y: 0 }, width: 500, height: 600 }] });
    const moved = { ...grouped, nodes: grouped.nodes.map(item => ({ ...item, position: { x: 300, y: 320 } })), groups: [{ ...grouped.groups[0], position: { x: 290, y: 300 } }] };
    const dissolved = { ...moved, nodes: moved.nodes.map(item => { const copy = { ...item }; delete copy.groupId; return copy; }), groups: [] };
    history.record(initial, grouped);
    history.record(grouped, moved);
    history.record(moved, dissolved);
    assert.deepEqual(history.undo(dissolved), moved);
    assert.deepEqual(history.undo(moved), grouped);
    assert.deepEqual(history.undo(grouped), initial);
});

test('typing merges within a session, but blur and timeout split steps', () => {
    let time = 0;
    const history = createCanvasHistory({ now: () => time });
    const original = state([node('text', { type: 'text', content: '' })]);
    let current = original;
    for (const text of ['H', 'He', 'Hey']) {
        const after = state([{ ...current.nodes[0], content: text }]);
        history.record(current, after, { key: 'content:text' });
        current = after;
        time += 100;
    }
    assert.equal(history.size, 1);
    history.breakMerge();
    const newSession = state([{ ...current.nodes[0], content: 'Hey!' }]);
    history.record(current, newSession, { key: 'content:text' });
    time += 1000;
    const paused = state([{ ...newSession.nodes[0], content: 'Hey! More' }]);
    history.record(newSession, paused, { key: 'content:text' });
    assert.equal(history.size, 3);
    assert.deepEqual(history.undo(paused), newSession);
    assert.deepEqual(history.undo(newSession), current);
    assert.deepEqual(history.undo(current), original);
});

test('nested snapshots are isolated while immutable image blobs remain shared', () => {
    const history = createCanvasHistory();
    const blob = new Blob(['media']);
    const before = state([node('first', { blob, allBlobs: [blob], script: { shots: [{ id: 'shot', prompt: 'before' }] } })]);
    const after = state([]);
    history.record(before, after);
    before.nodes[0].script.shots[0].prompt = 'mutated outside history';
    before.nodes[0].allBlobs.push(new Blob(['another']));
    const restored = history.undo(after);
    assert.equal(restored.nodes[0].script.shots[0].prompt, 'before');
    assert.equal(restored.nodes[0].blob, blob);
    assert.deepEqual(restored.nodes[0].allBlobs, [blob]);
});

test('history clears on project switch and retains only configured number of operations', () => {
    const history = createCanvasHistory({ limit: 3 });
    let current = state();
    for (let index = 0; index < 6; index += 1) {
        const after = { ...current, nodes: [...current.nodes, node('node-' + index)] };
        history.record(current, after);
        current = after;
    }
    assert.equal(history.size, 3);
    for (let index = 0; index < 3; index += 1) current = history.undo(current);
    assert.equal(current.nodes.length, 3);
    assert.equal(history.undo(current), null);
    history.record(current, state());
    history.clear();
    assert.equal(history.undo(state([node('other-project')])), null);
});

test('restoring an aborted node does not resurrect a fake running task', () => {
    const history = createCanvasHistory();
    const before = state([node('first', { status: 'loading', taskId: 'old-task', progress: 30 })]);
    history.record(before, state());
    const restored = history.undo(state());
    assert.equal(restored.nodes[0].status, 'error');
    assert.equal(restored.nodes[0].taskId, undefined);
    assert.match(restored.nodes[0].errorDetails, /重新生成/);
});
