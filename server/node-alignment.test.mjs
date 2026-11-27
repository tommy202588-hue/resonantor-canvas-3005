import test from 'node:test';
import assert from 'node:assert/strict';
import { snapNodeDrag } from '../services/nodeAlignment.mjs';

const moving = { id: 'moving', position: { x: 0, y: 0 }, width: 100, height: 80 };
const target = { id: 'target', position: { x: 300, y: 400 }, width: 160, height: 120 };
const initial = [{ id: moving.id, x: 0, y: 0 }];
const snap = (delta, scale = 1, disabled = false, nodes = [moving, target]) => snapNodeDrag(nodes, initial, delta, scale, disabled);

test('snaps X and Y independently and guides span both nodes', () => {
    const horizontal = snap({ x: 294, y: 137 });
    assert.deepEqual(horizontal.delta, { x: 300, y: 137 });
    assert.deepEqual(horizontal.guides, [{ axis: 'x', coordinate: 300, targetId: 'target', start: 125, end: 532 }]);
    const vertical = snap({ x: 150, y: 395 });
    assert.deepEqual(vertical.delta, { x: 150, y: 400 });
    assert.equal(vertical.guides[0].axis, 'y');
    assert.equal(vertical.guides[0].coordinate, 400);
});

test('supports center, trailing edge and adjacent edge alignment with unequal node sizes', () => {
    assert.equal(snap({ x: 329, y: 137 }).delta.x, 330);
    assert.equal(snap({ x: 354, y: 137 }).delta.x, 360);
    assert.equal(snap({ x: 196, y: 137 }).delta.x, 200);
    assert.equal(snap({ x: 456, y: 137 }).delta.x, 460);
    assert.equal(snap({ x: 150, y: 417 }).delta.y, 420);
    assert.equal(snap({ x: 150, y: 437 }).delta.y, 440);
});

test('both axes snap together and guides use the final adjusted bounds', () => {
    const result = snap({ x: 294, y: 394 });
    assert.deepEqual(result.delta, { x: 300, y: 400 });
    assert.equal(result.guides.length, 2);
    assert.equal(result.guides.find(guide => guide.axis === 'x').start, 388);
    assert.equal(result.guides.find(guide => guide.axis === 'y').start, 288);
});

test('8 pixel screen threshold stays consistent across zoom levels', () => {
    assert.equal(snap({ x: 286, y: 137 }, 0.5).delta.x, 300);
    assert.equal(snap({ x: 282, y: 137 }, 0.5).delta.x, 282);
    assert.equal(snap({ x: 296, y: 137 }, 2).delta.x, 300);
    assert.equal(snap({ x: 295, y: 137 }, 2).delta.x, 295);
});

test('moving beyond the threshold or holding Alt releases snapping', () => {
    assert.deepEqual(snap({ x: 282, y: 137 }), { delta: { x: 282, y: 137 }, guides: [] });
    assert.deepEqual(snap({ x: 294, y: 137 }, 1, true), { delta: { x: 294, y: 137 }, guides: [] });
});

test('never snaps to itself, grid-only nodes or a multiselection', () => {
    assert.equal(snap({ x: 294, y: 137 }, 1, false, [moving]).guides.length, 0);
    assert.equal(snap({ x: 294, y: 137 }, 1, false, [moving, { ...target, source: 'grid' }]).guides.length, 0);
    assert.equal(snapNodeDrag([moving, target], [...initial, { id: target.id, x: 300, y: 400 }], { x: 294, y: 137 }, 1).guides.length, 0);
});

test('a simple click or tiny pointer movement does not snap the node', () => {
    const nearby = { ...target, position: { x: 5, y: 400 } };
    assert.deepEqual(snap({ x: 0, y: 0 }, 1, false, [moving, nearby]), { delta: { x: 0, y: 0 }, guides: [] });
    assert.equal(snap({ x: 1, y: 1 }, 1, false, [moving, nearby]).guides.length, 0);
});

test('equal snap distances favor the nearer reference node', () => {
    const nearby = { ...target, id: 'nearby', position: { x: 302, y: 150 } };
    const result = snap({ x: 301, y: 137 }, 1, false, [moving, target, nearby]);
    assert.equal(result.guides.find(guide => guide.axis === 'x').targetId, 'nearby');
});

test('repeated drag and release calculations do not accumulate corrections', () => {
    const delta = { x: 294, y: 137 };
    const first = snap(delta);
    const current = { ...moving, position: first.delta };
    assert.deepEqual(snap(delta, 1, false, [current, target]), first);
    assert.deepEqual(moving.position, { x: 0, y: 0 });
});
