import test from 'node:test';
import assert from 'node:assert/strict';
import { updateScriptGeneration, interruptOrphanScriptGeneration, scriptGenerationError } from '../services/scriptGenerationTask.mjs';

const node = () => ({ id: 'script-1', type: 'script', script: { sourceText: '原稿', shots: ['旧镜头'] }, status: 'loading', scriptGeneration: { id: 'task-1', status: 'running', progress: 25, stage: '等待模型' } });

test('task completion updates its node independent of an open editor', () => {
    const result = { sourceText: '原稿', shots: ['新镜头'] };
    const updated = updateScriptGeneration([node()], 'script-1', 'task-1', { status: 'success', progress: 100, stage: '完成' }, result)[0];
    assert.deepEqual(updated.script, result);
    assert.equal(updated.status, 'success');
    assert.equal(updated.progress, 100);
});

test('stale responses cannot overwrite replaced or deleted nodes', () => {
    const original = node(); original.scriptGeneration.id = 'new-task';
    assert.equal(updateScriptGeneration([original], original.id, 'task-1', { status: 'success' }, {})[0], original);
    assert.deepEqual(updateScriptGeneration([], 'script-1', 'task-1', { status: 'success' }, {}), []);
});

test('failure keeps original document and last verified progress', () => {
    const original = node();
    const updated = updateScriptGeneration([original], original.id, 'task-1', { status: 'error', error: '服务失败' })[0];
    assert.equal(updated.script, original.script);
    assert.equal(updated.progress, 25);
    assert.equal(updated.scriptGeneration.error, '服务失败');
});

test('reopening a live task preserves progress, reloading orphan task becomes retryable error', () => {
    const original = node();
    assert.equal(interruptOrphanScriptGeneration(original, new Map([[original.id, 'task-1']])), original);
    const restored = interruptOrphanScriptGeneration(original, new Map());
    assert.equal(restored.status, 'error');
    assert.equal(restored.script, original.script);
    assert.match(restored.scriptGeneration.error, /不会自动重试/);
});

test('successful snapshots stay successful and task errors redact credentials', () => {
    const original = node(); original.scriptGeneration.status = 'success';
    assert.equal(interruptOrphanScriptGeneration(original, new Map()), original);
    assert.ok(!scriptGenerationError(new Error('Bearer secretsecretsecret')).includes('secretsecretsecret'));
});
