import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createUpscaleService, assertUpscaleRequest } from './upscale-service.mjs';
import { buildWorkflow, validateOptions, validateDimensions, BACKGROUND_NODE, BACKGROUND_MODEL, UPSCALE_MODEL, UPSCALE_VAE, UPSCALE_ENGINE } from './upscale-workflows.mjs';
import { saveProcessedImage } from './processed-image-download.mjs';

function fixture(context, { backgroundAvailable = true, upscaleAvailable = true, downloadFailure = false, width = 48, height = 32, offlinePorts = [], launchReady = true, launchFailure = false, gpuStore = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-processing-test-'));
  const downloadDirectory = path.join(root, 'downloads');
  const modelDirectory = path.join(root, 'ComfyUI', 'models', 'rembg');
  fs.mkdirSync(modelDirectory, { recursive: true });
  if (backgroundAvailable) fs.writeFileSync(path.join(modelDirectory, BACKGROUND_MODEL + '.pth'), 'fixture');
  const seedDirectory = path.join(root, 'ComfyUI', 'models', 'SEEDVR2');
  fs.mkdirSync(seedDirectory, { recursive: true });
  if (upscaleAvailable) for (const name of [UPSCALE_MODEL, UPSCALE_VAE]) fs.writeFileSync(path.join(seedDirectory, name), 'fixture');
  if (downloadFailure) fs.writeFileSync(downloadDirectory, 'not-a-directory');
  const pending = new Map();
  const calls = [];
  const imageActions = [];
  const owner = randomUUID();
  const offline = new Set(offlinePorts);
  const launches = [];
  const response = payload => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  const config = {
    installRoot: root, dataDir: path.join(root, 'jobs'), downloadDirectory,
    startPollMs: 5, startTimeoutMs: 50,
    launch: engine => {
      launches.push(engine);
      const child = new EventEmitter();
      if (launchFailure) queueMicrotask(() => child.emit('error', new Error('startup fixture failure')));
      else if (launchReady) offline.delete(engine === UPSCALE_ENGINE ? '8190' : '8188');
      return child;
    },
    fetch: async (url, init = {}) => {
      if (offline.has(new URL(url).port)) throw new Error('offline fixture');
      const endpoint = new URL(url).pathname;
      calls.push({ endpoint, port: new URL(url).port, host: new URL(url).host, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      if (endpoint.startsWith('/object_info/')) {
        const name = decodeURIComponent(endpoint.slice('/object_info/'.length));
        if (name === BACKGROUND_NODE) return response(backgroundAvailable ? { [name]: { input: { required: { rem_mode: [[BACKGROUND_MODEL]] } } } } : {});
        if (name === 'SeedVR2LoadDiTModel' || name === 'SeedVR2LoadVAEModel') return response({ [name]: { input: { required: { model: [upscaleAvailable ? [UPSCALE_MODEL, UPSCALE_VAE] : []] } } } });
        return response({ [name]: {} });
      }
      if (endpoint === '/upload/image') return response({ name: 'fixture.png', subfolder: 'canvas-upscale' });
      if (endpoint === '/prompt') {
        const body = JSON.parse(init.body);
        pending.set(body.prompt_id, { complete: false, graph: body.prompt });
        return response({ prompt_id: body.prompt_id });
      }
      if (endpoint.startsWith('/history/')) {
        const id = endpoint.slice('/history/'.length);
        return response(pending.get(id)?.complete ? { [id]: { status: { completed: true }, outputs: { '9': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } } } } : {});
      }
      if (endpoint === '/queue') {
        if (init.method === 'POST') {
          for (const id of JSON.parse(init.body).delete) pending.delete(id);
          return response({});
        }
        return response({ queue_running: [], queue_pending: [...pending].filter(([, value]) => !value.complete).map(([id]) => [0, id]) });
      }
      if (endpoint === '/interrupt') return response({});
      if (endpoint === '/view') return new Response(Buffer.from('generated-png'));
      throw new Error('Unexpected endpoint: ' + endpoint);
    },
    imageCommand: async (action, folder) => {
      imageActions.push(action);
      if (action === 'prepare' || action === 'prepare-background') fs.writeFileSync(path.join(folder, 'input.png'), 'fixture-png');
      else fs.writeFileSync(path.join(folder, 'result.png'), action + '-transparent-png');
      return { width, height };
    },
    ...(gpuStore ? { gpuStore } : {}),
  };
  const services = [];
  const create = () => { const service = createUpscaleService(config); services.push(service); return service; };
  context.after(() => {
    for (const service of services) service.dispose();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('canvas-processing-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { service: create(), create, root, downloadDirectory, pending, calls, imageActions, owner, launches };
}

const request = mode => ({ jobId: randomUUID(), mode, scale: mode === 'remove-background' ? 1 : 2, imageBase64: Buffer.from('fixture-image').toString('base64') });

for (const mode of ['faithful', 'remove-background']) {
  test(mode + ' routes its entire lifecycle and cancellation to its fixed runtime', async context => {
    const { service, owner, pending, calls, create } = fixture(context);
    const input = request(mode);
    const job = await service.submit(owner, { ...input, engine: 'https://untrusted.example', seed: 900 });
    assert.equal(job.engine, mode === 'faithful' ? UPSCALE_ENGINE : 'background');
    assert.equal(job.seed, mode === 'faithful' ? 42 : undefined);
    service.dispose();
    const restored = create();
    await restored.getJob(owner, input.jobId);
    pending.get(input.jobId).complete = true;
    assert.equal((await restored.getJob(owner, input.jobId)).state, 'success');
    const second = request(mode);
    await restored.submit(owner, second);
    await restored.cancel(owner, second.jobId);
    const taskCalls = calls.filter(call => !call.endpoint.startsWith('/object_info/'));
    assert.ok(taskCalls.some(call => call.endpoint === '/view'));
    assert.ok(taskCalls.some(call => call.endpoint === '/interrupt'));
    assert.ok(taskCalls.every(call => call.port === (mode === 'faithful' ? '8190' : '8188')));
  });
}

test('legacy in-flight RealESRGAN jobs resume on 8188 after service reload', async context => {
  const { service, owner, pending, calls, create, root } = fixture(context);
  const input = request('faithful');
  await service.submit(owner, input);
  service.dispose();
  const filename = path.join(root, 'jobs', input.jobId, 'job.json');
  const job = JSON.parse(fs.readFileSync(filename, 'utf8'));
  delete job.engine;
  delete job.seed;
  fs.writeFileSync(filename, JSON.stringify(job));
  pending.get(input.jobId).complete = true;
  calls.length = 0;
  assert.equal((await create().getJob(owner, input.jobId)).state, 'success');
  assert.ok(calls.length > 0 && calls.every(call => call.port === '8188'));
});

test('GPU 切换不会改变已提交任务绑定的 ComfyUI 服务', async context => {
  const primaryGpu = {
    id: 'primary-gpu', name: '主 GPU', kind: 'remote',
    comfyUrl: 'http://192.168.10.21:8188', seedUrl: 'http://192.168.10.21:8190',
  };
  const secondaryGpu = {
    id: 'secondary-gpu', name: '备用 GPU', kind: 'remote',
    comfyUrl: 'http://192.168.10.22:8188', seedUrl: 'http://192.168.10.22:8190',
  };
  let activeGpu = primaryGpu;
  const gpuStore = { active: () => structuredClone(activeGpu) };
  const { service, owner, pending, calls } = fixture(context, { gpuStore });
  const first = request('faithful');
  const firstJob = await service.submit(owner, first);
  assert.equal(firstJob.gpuServer.id, primaryGpu.id);

  activeGpu = secondaryGpu;
  assert.equal((await service.runtime()).gpuServer.id, secondaryGpu.id);
  pending.get(first.jobId).complete = true;
  assert.equal((await service.getJob(owner, first.jobId)).state, 'success');
  const firstCompletionHosts = calls
    .filter(call => ['/history/' + first.jobId, '/view'].some(endpoint => call.endpoint === endpoint))
    .map(call => call.host);
  assert.ok(firstCompletionHosts.length > 0);
  assert.ok(firstCompletionHosts.every(host => host === '192.168.10.21:8190'));

  const second = request('faithful');
  const secondJob = await service.submit(owner, second);
  assert.equal(secondJob.gpuServer.id, secondaryGpu.id);
  const secondPrompt = calls.findLast(call => call.endpoint === '/prompt' && call.body?.prompt_id === second.jobId);
  assert.equal(secondPrompt.host, '192.168.10.22:8190');
});

test('SeedVR startup is deduplicated and does not launch or require the background runtime', async context => {
  const { service, launches } = fixture(context, { offlinePorts: ['8190', '8188'] });
  const results = await Promise.all([service.startRuntime(), service.startRuntime(), service.startRuntime()]);
  assert.ok(results.every(state => state.faithfulReady && !state.starting && !state.backgroundRunning));
  assert.deepEqual(launches, [UPSCALE_ENGINE]);
  await service.startRuntime();
  assert.equal(launches.length, 1);
});

test('startup timeout leaves its process alone and retry cannot spawn a duplicate', async context => {
  const { service, launches } = fixture(context, { offlinePorts: ['8190'], launchReady: false });
  await assert.rejects(service.startRuntime(), error => error.code === 'startup_timeout');
  await assert.rejects(service.startRuntime(), error => error.code === 'startup_timeout');
  assert.equal(launches.length, 1);
});

test('startup failure is explicit and does not affect background readiness', async context => {
  const { service } = fixture(context, { offlinePorts: ['8190'], launchFailure: true });
  await assert.rejects(service.startRuntime(), error => error.code === 'startup_failed');
  assert.equal((await service.runtime()).backgroundReady, true);
});

test('a missing SeedVR file is reported even when a cached node lists the model', async context => {
  const { service, owner, root } = fixture(context);
  fs.unlinkSync(path.join(root, 'ComfyUI', 'models', 'SEEDVR2', UPSCALE_VAE));
  assert.deepEqual((await service.runtime()).missingFaithful, [UPSCALE_VAE]);
  await assert.rejects(service.submit(owner, request('faithful')), error => error.code === 'models_missing');
});


const lanRequest = (owner, overrides = {}) => ({
  method: 'POST', socket: { remoteAddress: '192.168.0.45', localPort: 3004 },
  ...overrides,
  headers: { host: '192.168.0.228:3004', origin: 'http://192.168.0.228:3004', 'x-upscale-client': owner, ...overrides.headers },
});

test('the fixed LAN entry accepts all originating browsers without requiring account login', () => {
  const owner = randomUUID();
  for (const remoteAddress of ['192.168.0.45', '192.168.0.228', '::ffff:192.168.0.46', '10.0.0.8', '127.0.0.1']) {
    assert.equal(assertUpscaleRequest(lanRequest(owner, { socket: { remoteAddress } })), owner);
  }
  assert.equal(assertUpscaleRequest(lanRequest(owner, { method: 'GET', headers: { origin: undefined } })), owner);
});

test('LAN permission does not bypass exact Host, Origin or owner validation', () => {
  const owner = randomUUID();
  for (const headers of [
    { host: '192.168.0.229:3004' }, { host: '192.168.0.228:3005' },
    { host: '192.168.0.228.evil.example:3004' }, { origin: 'http://evil.example' },
    { origin: undefined }, { origin: 'null' }, { 'x-upscale-client': undefined },
    { 'x-upscale-client': '../escape' }, { 'sec-fetch-site': 'cross-site' },
    { host: 'evil.example:3004', 'x-forwarded-host': '192.168.0.228:3004', 'x-forwarded-for': '127.0.0.1' },
  ]) assert.throws(() => assertUpscaleRequest(lanRequest(owner, { headers })), error => error.status === 403);
  assert.throws(() => assertUpscaleRequest(lanRequest(owner, { method: 'GET', headers: { origin: 'http://evil.example' } })), error => error.status === 403);
});

async function callProcessing(service, owner, endpoint, method = 'GET', payload, overrides = {}) {
  const incoming = payload instanceof Readable ? payload : Readable.from(payload ? [Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload))] : []);
  Object.assign(incoming, lanRequest(owner, { method, url: endpoint, ...overrides, headers: { 'content-type': 'application/json', ...overrides.headers } }));
  let status;
  let headers;
  let data;
  const response = {
    headersSent: false, destroyed: false,
    writeHead(code, values) { status = code; headers = values; this.headersSent = true; },
    end(body) { data = body; },
  };
  await service.middleware(incoming, response, overrides.authenticatedOwner);
  return { status, headers, ...(headers['content-type'].startsWith('application/json') ? { data: JSON.parse(String(data)) } : { image: data }) };
}

const binaryJobUrl = input => '/jobs?' + new URLSearchParams({ jobId: input.jobId, mode: input.mode, scale: String(input.scale) });
const binaryHeaders = { headers: { 'content-type': 'application/octet-stream' } };

for (const mode of ['faithful', 'remove-background']) {
  test(mode + ' streams uploads larger than the old image and JSON limits', async context => {
    const { service, owner, root, pending, calls } = fixture(context);
    const input = request(mode);
    const chunk = Buffer.alloc(1024 * 1024, 42);
    const stream = Readable.from((async function* () {
      for (let index = 0; index < 40; index += 1) yield chunk;
    })());
    const result = await callProcessing(service, owner, binaryJobUrl(input), 'POST', stream, binaryHeaders);
    assert.equal(result.status, 202);
    assert.equal(result.data.state, 'queued');
    assert.equal(fs.statSync(path.join(root, 'jobs', input.jobId, 'source.png')).size, 40 * 1024 * 1024);
    assert.equal(calls.filter(call => call.endpoint === '/prompt').length, 1);
    const duplicate = await callProcessing(service, owner, binaryJobUrl(input), 'POST', Buffer.from('duplicate'), binaryHeaders);
    assert.equal(duplicate.status, 202);
    assert.equal(fs.statSync(path.join(root, 'jobs', input.jobId, 'source.png')).size, 40 * 1024 * 1024);
    assert.equal((await callProcessing(service, randomUUID(), binaryJobUrl(input), 'POST', chunk, binaryHeaders)).status, 404);
    assert.equal((await callProcessing(service, owner, binaryJobUrl(request(mode)), 'POST', chunk, binaryHeaders)).status, 409);
    pending.get(input.jobId).complete = true;
    assert.equal((await service.getJob(owner, input.jobId)).state, 'success');
  });
}

test('binary uploads still validate ownership, source, job IDs and options', async context => {
  const { service, owner, calls } = fixture(context);
  const data = Buffer.from('image');
  const input = request('remove-background');
  assert.equal((await callProcessing(service, owner, binaryJobUrl(input), 'POST', data, { headers: { 'content-type': 'application/octet-stream', origin: 'http://evil.example' } })).status, 403);
  assert.equal((await callProcessing(service, owner, binaryJobUrl({ ...input, jobId: '../escape' }), 'POST', data, binaryHeaders)).status, 400);
  assert.equal((await callProcessing(service, owner, binaryJobUrl({ ...input, scale: 4 }), 'POST', data, binaryHeaders)).status, 400);
  assert.equal(calls.length, 0);
});

test('empty and interrupted uploads remove partial files and release the submission lock', async context => {
  const { service, owner, root, calls } = fixture(context);
  for (const interrupted of [false, true]) {
    const input = request('remove-background');
    const stream = Readable.from((async function* () {
      if (interrupted) { yield Buffer.from('partial'); throw new Error('connection lost'); }
    })());
    const result = await callProcessing(service, owner, binaryJobUrl(input), 'POST', stream, binaryHeaders);
    assert.equal(result.status, 400);
    assert.equal(result.data.error.code, 'upload_failed');
    assert.equal(fs.existsSync(path.join(root, 'jobs', input.jobId, 'source.png')), false);
    assert.equal((await service.getJob(owner, input.jobId)).state, 'error');
  }
  assert.equal(calls.some(call => call.endpoint === '/prompt'), false);
  const retry = request('remove-background');
  assert.equal((await callProcessing(service, owner, binaryJobUrl(retry), 'POST', Buffer.from('valid'), binaryHeaders)).status, 202);
});

for (const mode of ['faithful', 'remove-background']) {
  test('LAN middleware completes ' + mode + ' and isolates two browsers through result download', async context => {
    const { service, owner, pending, calls } = fixture(context);
    const otherOwner = randomUUID();
    const input = request(mode);
    assert.equal((await callProcessing(service, owner, '/runtime')).status, 200);
    assert.equal((await callProcessing(service, otherOwner, '/runtime/start', 'POST')).status, 200);
    const submitted = await callProcessing(service, owner, '/jobs', 'POST', input);
    assert.equal(submitted.status, 202);
    assert.equal(submitted.data.owner, undefined);
    const foreignSource = { socket: { remoteAddress: '192.168.0.46', localPort: 3004 } };
    assert.equal((await callProcessing(service, otherOwner, '/jobs', 'POST', request(mode), foreignSource)).status, 409);
    assert.equal((await callProcessing(service, otherOwner, '/jobs/' + input.jobId, 'GET', undefined, foreignSource)).status, 404);
    assert.equal((await callProcessing(service, otherOwner, '/jobs/' + input.jobId + '/cancel', 'POST', undefined, foreignSource)).status, 404);
    assert.equal((await callProcessing(service, otherOwner, '/jobs', 'POST', input, foreignSource)).status, 404);
    pending.get(input.jobId).complete = true;
    const completed = await callProcessing(service, owner, '/jobs/' + input.jobId);
    assert.equal(completed.status, 200);
    assert.equal(completed.data.state, 'success');
    assert.equal((await callProcessing(service, otherOwner, '/jobs/' + input.jobId + '/image', 'GET', undefined, foreignSource)).status, 404);
    const image = await callProcessing(service, owner, '/jobs/' + input.jobId + '/image');
    assert.equal(image.status, 200);
    assert.equal(image.headers['content-type'], 'image/png');
    assert.ok(image.image.length > 0);
    const next = request(mode);
    assert.equal((await callProcessing(service, otherOwner, '/jobs', 'POST', next, foreignSource)).status, 202);
    assert.equal((await callProcessing(service, owner, '/jobs/' + next.jobId + '/cancel', 'POST')).status, 404);
    assert.equal((await callProcessing(service, otherOwner, '/jobs/' + next.jobId + '/cancel', 'POST', undefined, foreignSource)).status, 200);
    assert.deepEqual(calls.filter(call => call.endpoint === '/interrupt').map(call => call.body), [{ prompt_id: next.jobId }]);
  });
}

test('rejected LAN origins cannot reach ComfyUI or start any task', async context => {
  const { service, owner, calls } = fixture(context);
  const previous = calls.length;
  const forbidden = { headers: { origin: 'http://evil.example' } };
  for (const endpoint of ['/runtime/start', '/jobs']) {
    assert.equal((await callProcessing(service, owner, endpoint, 'POST', request('faithful'), forbidden)).status, 403);
  }
  assert.equal(calls.length, previous);
});

test('background removal is a fixed local node graph without resizing', () => {
  const options = validateOptions({ mode: 'remove-background', scale: 1 });
  const graph = buildWorkflow(options, 'input.png', validateDimensions(1200, 800, 1, options.mode), 'fixture');
  assert.equal(graph['2'].class_type, BACKGROUND_NODE);
  assert.equal(graph['2'].inputs.rem_mode, BACKGROUND_MODEL);
  assert.equal(graph['2'].inputs.add_background, 'none');
  assert.equal(graph['2'].inputs.image_output, 'Hide');
  assert.deepEqual(graph['9'].inputs.images, ['2', 0]);
  assert.equal(Object.values(graph).some(node => node.class_type === 'ImageScale'), false);
  assert.throws(() => validateOptions({ mode: 'remove-background', scale: 2 }));
});

for (const scale of [2, 4]) {
  test('4800x6400 upscales complete at ' + scale + 'x without fixed-size graph limits', async context => {
    const { service, owner, pending, imageActions } = fixture(context, { width: 4800, height: 6400 });
    const input = { ...request('faithful'), scale };
    const job = await service.submit(owner, input);
    assert.deepEqual(job.dimensions, { width: 4800, height: 6400, outputWidth: 4800 * scale, outputHeight: 6400 * scale });
    const task = pending.get(input.jobId);
    assert.equal(task.graph['7'].class_type, 'SeedVR2VideoUpscaler');
    assert.equal(task.graph['5'].inputs.value, scale === 4);
    task.complete = true;
    assert.equal((await service.getJob(owner, input.jobId)).state, 'success');
    assert.deepEqual(imageActions, ['prepare', 'finish']);
  });
}

test('large background images preserve their dimensions through submission and completion', async context => {
  const { service, owner, pending, imageActions } = fixture(context, { width: 9000, height: 4000 });
  const input = request('remove-background');
  const job = await service.submit(owner, input);
  assert.deepEqual(job.dimensions, { width: 9000, height: 4000, outputWidth: 9000, outputHeight: 4000 });
  pending.get(input.jobId).complete = true;
  const result = await service.getJob(owner, input.jobId);
  assert.equal(result.state, 'success');
  assert.deepEqual(result.dimensions, job.dimensions);
  assert.deepEqual(imageActions, ['prepare-background', 'finish-background']);
});

for (const mode of ['faithful', 'remove-background']) {
  test(mode + ' returns a result and downloads exactly once across service reloads', async context => {
    const fixtureData = fixture(context);
    const { service, owner, pending, imageActions, downloadDirectory } = fixtureData;
    const input = request(mode);
    assert.equal((await service.submit(owner, input)).state, 'queued');
    await assert.rejects(service.submit(owner, request(mode)), error => error.code === 'busy');
    await assert.rejects(service.getJob(randomUUID(), input.jobId), error => error.status === 404);
    pending.get(input.jobId).complete = true;
    const result = await service.getJob(owner, input.jobId);
    assert.equal(result.state, 'success');
    assert.ok(result.download.path.startsWith(downloadDirectory + path.sep));
    assert.ok(fs.existsSync(result.download.path));
    assert.ok(imageActions.includes(mode === 'remove-background' ? 'finish-background' : 'finish'));
    assert.equal(result.dimensions.outputWidth, mode === 'remove-background' ? 48 : 96);
    const writtenAt = fs.statSync(result.download.path).mtimeMs;
    await service.getJob(owner, input.jobId);
    service.dispose();
    const restored = await fixtureData.create().getJob(owner, input.jobId);
    assert.equal(restored.download.path, result.download.path);
    assert.equal(fs.readdirSync(downloadDirectory).length, 1);
    assert.equal(fs.statSync(result.download.path).mtimeMs, writtenAt);
  });
}

test('save failure does not discard the successful image', async context => {
  const { service, owner, pending, root } = fixture(context, { downloadFailure: true });
  const input = request('remove-background');
  await service.submit(owner, input);
  pending.get(input.jobId).complete = true;
  const result = await service.getJob(owner, input.jobId);
  assert.equal(result.state, 'success');
  assert.match(result.download.error, /自动保存失败/);
  assert.ok(fs.existsSync(path.join(root, 'jobs', input.jobId, 'result.png')));
});

test('background readiness is independent of upscale model availability', async context => {
  const { service, owner } = fixture(context, { upscaleAvailable: false });
  const runtime = await service.runtime();
  assert.equal(runtime.faithfulReady, false);
  assert.equal(runtime.backgroundReady, true);
  assert.equal((await service.submit(owner, request('remove-background'))).state, 'queued');
});

test('missing background node is reported, not silently processed in the browser', async context => {
  const { service, owner } = fixture(context, { backgroundAvailable: false });
  assert.equal((await service.runtime()).backgroundReady, false);
  await assert.rejects(service.submit(owner, request('remove-background')), error => error.code === 'models_missing');
});

test('cancel only targets the owned job', async context => {
  const { service, owner, calls } = fixture(context);
  const input = request('remove-background');
  await service.submit(owner, input);
  await assert.rejects(service.cancel(randomUUID(), input.jobId), error => error.status === 404);
  assert.equal((await service.cancel(owner, input.jobId)).state, 'cancelled');
  assert.deepEqual(calls.filter(call => call.endpoint === '/interrupt').map(call => call.body), [{ prompt_id: input.jobId }]);
});

test('download names cannot escape the folder or overwrite different content', context => {
  const { root, downloadDirectory } = fixture(context);
  const source = path.join(root, 'output.png');
  fs.writeFileSync(source, 'first-image');
  const job = { id: randomUUID(), options: { mode: 'faithful', scale: 2 } };
  const saved = saveProcessedImage(job, source, downloadDirectory);
  assert.equal(saveProcessedImage(job, source, downloadDirectory).path, saved.path);
  fs.writeFileSync(source, 'second-image');
  assert.throws(() => saveProcessedImage(job, source, downloadDirectory), /未覆盖/);
  assert.equal(fs.readFileSync(saved.path, 'utf8'), 'first-image');
  assert.throws(() => saveProcessedImage({ ...job, id: '../escape' }, source, downloadDirectory));
});

test('loopback-only hosts still reject remote clients and cross-origin mutations', () => {
  const valid = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3004', origin: 'http://localhost:3004', 'x-upscale-client': randomUUID() } };
  assert.equal(assertUpscaleRequest(valid), valid.headers['x-upscale-client']);
  assert.throws(() => assertUpscaleRequest({ ...valid, socket: { remoteAddress: '192.168.1.2' } }));
  assert.throws(() => assertUpscaleRequest({ ...valid, headers: { ...valid.headers, origin: 'https://example.com' } }));
});

test('production API may dispatch an authenticated public-host request to the isolated job service', async context => {
  const { service, owner } = fixture(context, { offlinePorts: ['8188', '8190'] });
  const result = await callProcessing(service, owner, '/api/upscale/runtime', 'GET', undefined, {
    headers: { host: 'www.resonantor.cn', 'x-upscale-client': undefined, origin: undefined },
    authenticatedOwner: owner,
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.gpuServer.name, '主 GPU（当前服务器）');

  const directResult = await callProcessing(service, owner, '/api/upscale/runtime', 'GET', undefined, {
    headers: { host: 'www.resonantor.cn', origin: undefined },
  });
  assert.equal(directResult.status, 403);
});

test('authenticated account owners may use deterministic UUID v5 identities', async context => {
  const { service } = fixture(context, { offlinePorts: ['8188', '8190'] });
  const owner = '01234567-89ab-5cde-8123-456789abcdef';
  const result = await callProcessing(service, owner, '/api/upscale/runtime', 'GET', undefined, {
    headers: { host: 'www.resonantor.cn', 'x-upscale-client': undefined, origin: undefined },
    authenticatedOwner: owner,
  });
  assert.equal(result.status, 200);
});
