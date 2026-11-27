import test from 'node:test';
import assert from 'node:assert/strict';
import { selectVideoReferenceImages, buildVideoReferencePrompt } from '../services/videoReferences.mjs';

const images = Array.from({ length: 12 }, (_,index) => ({ index, value: 'image-' + (index + 1) }));

test('video without image mentions retains all upstream references', () => {
    assert.equal(selectVideoReferenceImages('人物向前走 @actor', images), images);
    assert.deepEqual(selectVideoReferenceImages('', []), []);
    assert.equal(buildVideoReferencePrompt('人物向前走 @actor', images), '人物向前走 @actor');
});

test('video selects only mentioned images without duplicates and keeps upstream order', () => {
    const selected = selectVideoReferenceImages('@图3 中的人物，使用 @图1 的场景，保持 @图3 服装', images);
    assert.deepEqual(selected.map(image => image.index), [0, 2]);
    assert.equal(buildVideoReferencePrompt('@图3 中的人物，使用 @图1 的场景', selected), '参考图2 中的人物，使用 参考图1 的场景');
});

test('multi-digit reference IDs do not accidentally select the first image', () => {
    const selected = selectVideoReferenceImages('使用 @图12 和 @图10', images);
    assert.deepEqual(selected.map(image => image.index), [9, 11]);
    assert.equal(buildVideoReferencePrompt('使用 @图12 和 @图10', selected), '使用 参考图2 和 参考图1');
});

test('disconnected or empty image mentions fail before calling a model', () => {
    for (const prompt of ['@图0', '@图13', '@图2 @图99']) {
        assert.throws(() => buildVideoReferencePrompt(prompt, selectVideoReferenceImages(prompt, images)), /断开连接或没有可用图片/);
    }
    assert.throws(() => buildVideoReferencePrompt('@图1', []));
});

test('text-node references and video prompt references share a single selection', () => {
    const prompt = '场景采用 @图2 。 人物采用 @图1 ，保持 @character 外观。';
    const selected = selectVideoReferenceImages(prompt, images);
    assert.deepEqual(selected.map(image => image.index), [0, 1]);
    assert.equal(buildVideoReferencePrompt(prompt, selected).includes('@character'), true);
});
