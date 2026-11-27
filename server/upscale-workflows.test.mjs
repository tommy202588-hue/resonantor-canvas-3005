import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkflow, validateDimensions, validateOptions, UpscaleError } from './upscale-workflows.mjs';

test('accepts faithful requests without redraw parameters', () => {
  assert.deepEqual(validateOptions({ mode: 'faithful', scale: 2 }), { mode: 'faithful', scale: 2 });
  assert.deepEqual(validateOptions({ mode: 'faithful', scale: 4, seed: 42, strength: 'light', prompt: 'legacy' }), { mode: 'faithful', scale: 4 });
  assert.throws(() => validateOptions({ mode: 'creative', scale: 2 }), UpscaleError);
  assert.throws(() => validateOptions({ mode: 'faithful', scale: 3 }), UpscaleError);
});

test('accepts large upscales without old input or output pixel limits', () => {
  assert.deepEqual(validateDimensions(1200, 800, 2), { width: 1200, height: 800, outputWidth: 2400, outputHeight: 1600 });
  for (const scale of [2, 4]) {
    assert.deepEqual(validateDimensions(4800, 6400, scale), { width: 4800, height: 6400, outputWidth: 4800 * scale, outputHeight: 6400 * scale });
  }
  for (const invalid of [0, -1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => validateDimensions(invalid, 6400, 2), UpscaleError);
    assert.throws(() => validateDimensions(4800, invalid, 4), UpscaleError);
  }
});

test('background dimensions have no upscale pixel limits but reject invalid sizes and scale', () => {
  for (const [width, height] of [[4096, 2160], [9000, 4000]]) {
    assert.deepEqual(validateDimensions(width, height, 1, 'remove-background'), { width, height, outputWidth: width, outputHeight: height });
  }
  for (const invalid of [0, -1, 2.5, NaN, Infinity]) {
    assert.throws(() => validateDimensions(invalid, 3000, 1, 'remove-background'), UpscaleError);
    assert.throws(() => validateDimensions(3000, invalid, 1, 'remove-background'), UpscaleError);
  }
  assert.throws(() => validateDimensions(4096, 2160, 2, 'remove-background'), UpscaleError);
});

test('both scales infer at the exact target size through SeedVR2, without a resolution cap', () => {
  for (const scale of [2, 4]) {
    const graph = buildWorkflow({ mode: 'faithful', scale }, 'canvas-upscale/a.png', validateDimensions(4800, 6400, scale), 'job');
    assert.equal(graph['2'].inputs.model, 'seedvr2_ema_3b_fp8_e4m3fn.safetensors');
    assert.equal(graph['3'].inputs.model, 'ema_vae_fp16.safetensors');
    assert.equal(graph['5'].inputs.value, scale === 4);
    assert.equal(graph['6'].inputs.expression, 'min(a, b) * (4 if c else 2)');
    assert.deepEqual(graph['6'].inputs['values.a'], ['4', 0]);
    assert.deepEqual(graph['6'].inputs['values.b'], ['4', 1]);
    assert.deepEqual(graph['6'].inputs['values.c'], ['5', 0]);
    assert.deepEqual(graph['7'].inputs.resolution, ['6', 1]);
    assert.equal(graph['7'].inputs.max_resolution, 0);
    assert.equal(graph['7'].inputs.seed, 42);
    assert.deepEqual(graph['9'].inputs.images, ['7', 0]);
    assert.ok(!Object.values(graph).some(node => /ImageScale|UpscaleModelLoader/.test(node.class_type)));
  }
});

test('removed redraw mode cannot construct a workflow', () => {
  assert.throws(() => buildWorkflow({ mode: 'creative', scale: 2 }, 'image.png', validateDimensions(640, 480, 2), 'job'), UpscaleError);
});
