import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { buildWorkflow, validateOptions, validateDimensions, modelChoices, describeFailure, UpscaleError, UPSCALE_MODEL, UPSCALE_VAE, UPSCALE_ENGINE, UPSCALE_SEED, BACKGROUND_NODE, BACKGROUND_MODEL } from './upscale-workflows.mjs';
import { saveProcessedImage } from './processed-image-download.mjs';
import { DEFAULT_COMFY_INSTALL, DEFAULT_GPU_SERVER, createGpuServerSettingsStore } from './gpu-server-settings.mjs';

const execute = promisify(execFile);
const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINISHED = new Set(['success', 'error', 'cancelled']);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const LAN_HOSTS = new Set(['192.168.0.228:3004', '192.168.0.228:3005']);
const LOCAL_HOSTS = new Set(['localhost:3004', 'localhost:3005', '127.0.0.1:3004', '127.0.0.1:3005', '[::1]:3004', '[::1]:3005']);

export function assertUpscaleRequest(request) {
  const host = request.headers.host;
  if (!LOCAL_HOSTS.has(host) && !LAN_HOSTS.has(host)) {
    throw new UpscaleError('请通过 localhost:3005 或 192.168.0.228:3005 使用图像处理。', 403, 'invalid_host');
  }
  if (!LAN_HOSTS.has(host) && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) {
    throw new UpscaleError('远程用户请通过 http://192.168.0.228:3005/ 使用图像处理。', 403, 'local_only');
  }
  if (request.headers['sec-fetch-site'] === 'cross-site' || ((request.method !== 'GET' || request.headers.origin !== undefined) && request.headers.origin !== 'http://' + host)) {
    throw new UpscaleError('请求来源校验失败。', 403, 'invalid_origin');
  }
  const owner = request.headers['x-upscale-client'];
  if (typeof owner !== 'string' || !UUID_V4.test(owner)) throw new UpscaleError('缺少当前浏览器的任务身份。', 403, 'invalid_owner');
  return owner;
}

async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new UpscaleError('请使用 JSON 请求。', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new UpscaleError('上传图片过大，最大请求为 32 MB。', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new UpscaleError('请求 JSON 无效。'); }
}

export function createUpscaleService(config = {}) {
  const fallbackGpuServer = {
    ...DEFAULT_GPU_SERVER,
    installRoot: config.installRoot || DEFAULT_COMFY_INSTALL,
    comfyUrl: config.comfyUrl || DEFAULT_GPU_SERVER.comfyUrl,
    seedUrl: config.seedUrl || DEFAULT_GPU_SERVER.seedUrl,
  };
  const activeGpuServer = () => config.gpuStore ? config.gpuStore.active() : structuredClone(fallbackGpuServer);
  const gpuForJob = job => job?.gpuServer || fallbackGpuServer;
  const publicGpuServer = server => ({ id: server.id, name: server.name, kind: server.kind, managed: server.kind === 'local' });
  const startKey = (server, engine) => server.id + ':' + engine;
  const comfyRootFor = server => path.join(server.kind === 'local' ? server.installRoot : fallbackGpuServer.installRoot, 'ComfyUI');
  const comfyPythonFor = server => config.comfyPython || (process.platform === 'win32'
    ? path.join(server.installRoot, 'python', 'python.exe')
    : path.join(server.installRoot, 'venv', 'bin', 'python'));
  const imagePythonFor = server => config.imagePython || (server.kind === 'local'
    ? comfyPythonFor(server)
    : process.platform === 'win32' ? 'python' : 'python3');
  const dataDir = config.dataDir || path.join(comfyRootFor(fallbackGpuServer), 'user', 'canvas-upscale');
  const fetchImpl = config.fetch || fetch;
  const jobs = new Map();
  const refreshing = new Map();
  const preparing = new Set();
  const starting = new Map();
  const launched = new Map();
  let submitting = false;
  fs.mkdirSync(dataDir, { recursive: true });
  for (const name of fs.readdirSync(dataDir)) {
    if (!UUID.test(name)) continue;
    try {
      const job = JSON.parse(fs.readFileSync(path.join(dataDir, name, 'job.json'), 'utf8'));
      if (job.id === name && UUID.test(job.owner) && UUID.test(job.promptId)) jobs.set(name, job);
    } catch {}
  }

  const directory = job => path.join(dataDir, job.id);
  const persist = job => {
    job.updatedAt = Date.now();
    const folder = directory(job);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'job.json.tmp'), JSON.stringify(job));
    fs.renameSync(path.join(folder, 'job.json.tmp'), path.join(folder, 'job.json'));
  };
  const publicJob = job => {
    const { owner, ...visible } = job;
    return { ...visible, gpuServer: publicGpuServer(gpuForJob(job)) };
  };
  const ownedJob = (id, owner) => {
    const job = jobs.get(id);
    if (!job || job.owner !== owner) throw new UpscaleError('任务不存在或不属于当前浏览器。', 404, 'job_not_found');
    return job;
  };
  const comfy = async (endpoint, init = {}, engine, gpuServer = activeGpuServer()) => {
    let response;
    try {
      response = await fetchImpl((engine === UPSCALE_ENGINE ? gpuServer.seedUrl : gpuServer.comfyUrl) + endpoint, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new UpscaleError('无法连接 ComfyUI，请检查本地服务后重试。', 503, 'runtime_unavailable');
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1600);
      throw new UpscaleError('ComfyUI 请求失败：' + detail, 502, 'comfy_error');
    }
    return response;
  };
  const post = (endpoint, body, engine, gpuServer) => comfy(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, engine, gpuServer);
  const imageCommand = config.imageCommand || (async (action, folder, dimensions = {}, gpuServer = activeGpuServer()) => {
    try {
      const args = [path.join(moduleRoot, 'upscale-image.py'), action, folder];
      if (action === 'finish' || action === 'finish-background') args.push(String(dimensions.outputWidth), String(dimensions.outputHeight));
      const result = await execute(imagePythonFor(gpuServer), args, { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
      return JSON.parse(result.stdout.trim());
    } catch (error) {
      throw new UpscaleError('图片处理失败：' + String(error.stderr || error.message).slice(-1400), 400, 'invalid_image');
    }
  });

  async function inspectRuntime(engine, gpuServer = activeGpuServer()) {
    const seed = engine === UPSCALE_ENGINE;
    const common = seed
      ? ['LoadImage', 'SeedVR2LoadDiTModel', 'SeedVR2LoadVAEModel', 'SeedVR2VideoUpscaler', 'GetImageSize', 'PrimitiveBoolean', 'ComfyMathExpression', 'SaveImage']
      : ['LoadImage', BACKGROUND_NODE, 'SaveImage'];
    try {
      const entries = await Promise.all(common.map(async name => {
        const data = await (await comfy('/object_info/' + encodeURIComponent(name), {}, engine, gpuServer)).json();
        return [name, data[name]];
      }));
      const nodes = Object.fromEntries(entries);
      const missing = common.filter(name => !nodes[name]);
      const models = seed
        ? [['SeedVR2LoadDiTModel', 'model', UPSCALE_MODEL, 'SEEDVR2', UPSCALE_MODEL], ['SeedVR2LoadVAEModel', 'model', UPSCALE_VAE, 'SEEDVR2', UPSCALE_VAE]]
        : [[BACKGROUND_NODE, 'rem_mode', BACKGROUND_MODEL, 'rembg', BACKGROUND_MODEL + '.pth']];
      for (const [node, field, model, folder, filename] of models) {
        if (!modelChoices(nodes[node], field).includes(model) || (gpuServer.kind === 'local' && !fs.existsSync(path.join(comfyRootFor(gpuServer), 'models', folder, filename)))) missing.push(filename);
      }
      return { running: true, ready: !missing.length, missing };
    } catch (error) {
      return { running: false, ready: false, missing: [], error: describeFailure(error) };
    }
  }

  async function runtime(gpuServer = activeGpuServer()) {
    const [seed, background] = await Promise.all([inspectRuntime(UPSCALE_ENGINE, gpuServer), inspectRuntime('background', gpuServer)]);
    let imageProcessorReady = true;
    let imageProcessorError;
    try {
      await execute(imagePythonFor(gpuServer), ['-c', 'from PIL import Image'], { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 });
    } catch {
      imageProcessorReady = false;
      imageProcessorError = '服务器端图像处理依赖未就绪（Python/Pillow）。请管理员配置 Python 与 Pillow。';
    }
    const comfyRoot = comfyRootFor(gpuServer);
    const canStartLocal = gpuServer.kind === 'local'
      && fs.existsSync(path.join(comfyRoot, 'main.py'))
      && fs.existsSync(comfyPythonFor(gpuServer));
    return { running: seed.running, starting: starting.has(startKey(gpuServer, UPSCALE_ENGINE)), engine: UPSCALE_ENGINE, gpuServer: publicGpuServer(gpuServer), startSupported: canStartLocal,
      faithfulReady: seed.ready, missingFaithful: seed.missing, error: seed.error,
      backgroundRunning: background.running, backgroundReady: background.ready, missingBackground: background.missing, backgroundError: background.error,
      imageProcessorReady, imageProcessorError };
  }

  const launch = config.launch || ((engine, gpuServer) => {
    if (gpuServer.kind !== 'local') throw new UpscaleError('当前 GPU 服务由远程主机管理，请先在远程主机启动 ComfyUI。', 503, 'remote_start_unsupported');
    const comfyRoot = comfyRootFor(gpuServer);
    const python = comfyPythonFor(gpuServer);
    if (!fs.existsSync(python) || !fs.existsSync(path.join(comfyRoot, 'main.py'))) {
      throw new UpscaleError('未找到配置的 D 盘 ComfyUI 环境，请检查安装路径。', 503, 'install_missing');
    }
    const seed = engine === UPSCALE_ENGINE;
    const output = fs.openSync(path.join(dataDir, seed ? 'seedvr-runtime.log' : 'runtime.log'), 'a');
    try {
      const args = ['-X', 'utf8', path.join(comfyRoot, 'main.py'), '--listen', '127.0.0.1', '--port', seed ? '8190' : '8188', '--preview-method', 'auto', '--cuda-malloc', '--cpu-vae'];
      if (seed) {
        const userDirectory = path.join(dataDir, 'seedvr-user');
        fs.mkdirSync(userDirectory, { recursive: true });
        args.push('--disable-all-custom-nodes', '--whitelist-custom-nodes', 'seedvr2_videoupscaler', '--user-directory', userDirectory);
      }
      const child = spawn(python, args, {
        cwd: comfyRoot, windowsHide: true, detached: true, stdio: ['ignore', output, output],
      });
      child.unref();
      return child;
    } finally { fs.closeSync(output); }
  });

  function startRuntime(engine = UPSCALE_ENGINE, gpuServer = activeGpuServer()) {
    const key = startKey(gpuServer, engine);
    if (starting.has(key)) return starting.get(key);
    const promise = (async () => {
      const current = await inspectRuntime(engine, gpuServer);
      if (current.running) return { ...await runtime(gpuServer), starting: false };
      let processState = launched.get(key);
      if (!processState) {
        processState = { child: launch(engine, gpuServer), error: null };
        launched.set(key, processState);
        processState.child.once('error', error => { processState.error = error; launched.delete(key); });
        processState.child.once('exit', code => {
          processState.error = new Error('ComfyUI 已退出，退出码 ' + code + '。请查看 ' + (engine === UPSCALE_ENGINE ? 'seedvr-runtime.log' : 'runtime.log') + '。');
          launched.delete(key);
        });
      }
      const deadline = Date.now() + (config.startTimeoutMs || 120_000);
      while (Date.now() < deadline) {
        if (processState.error) throw new UpscaleError(processState.error.message, 503, 'startup_failed');
        await pause(config.startPollMs || 1000);
        const state = await inspectRuntime(engine, gpuServer);
        if (state.running) return { ...await runtime(gpuServer), starting: false };
      }
      throw new UpscaleError('ComfyUI 启动超过 120 秒，请检查日志后重新检测；未关闭启动进程。', 504, 'startup_timeout');
    })().finally(() => { starting.delete(key); });
    starting.set(key, promise);
    return promise;
  }

  function fail(job, error) {
    job.state = 'error';
    job.error = describeFailure(error);
    job.finishedAt = Date.now();
    persist(job);
  }

  async function refreshInternal(job) {
    if (FINISHED.has(job.state) || preparing.has(job.id)) return;
    const gpuServer = gpuForJob(job);
    try {
      const history = await (await comfy('/history/' + job.promptId, {}, job.engine, gpuServer)).json();
      const entry = history[job.promptId];
      if (entry) {
        const failure = entry.status?.messages?.find(message => ['execution_error', 'execution_interrupted'].includes(message[0]));
        if (failure || entry.status?.status_str === 'error') {
          if (job.cancelRequested || failure?.[0] === 'execution_interrupted') {
            job.state = 'cancelled'; job.finishedAt = Date.now(); persist(job);
          } else fail(job, new Error(failure?.[1]?.exception_message || 'ComfyUI 执行失败，请查看本地日志。'));
          return;
        }
        const image = entry.outputs?.['9']?.images?.[0];
        if (image) {
          const response = await comfy('/view?' + new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: 'output' }), {}, job.engine, gpuServer);
          fs.writeFileSync(path.join(directory(job), 'generated.png'), Buffer.from(await response.arrayBuffer()));
          await imageCommand(job.options.mode === 'remove-background' ? 'finish-background' : 'finish', directory(job), job.dimensions, gpuServer);
          job.state = 'success'; job.finishedAt = Date.now(); job.warning = undefined;
          if (job.autoDownload) {
            try { job.download = saveProcessedImage(job, path.join(directory(job), 'result.png'), config.downloadDirectory); }
            catch (error) { job.download = { error: '自动保存失败：' + error.message + '。图片仍已回传，可点击节点下载按钮保存。' }; }
          }
          persist(job);
          return;
        }
        if (entry.status?.completed) { fail(job, new Error('工作流结束但没有返回高清图片。')); return; }
      }
      const queue = await (await comfy('/queue', {}, job.engine, gpuServer)).json();
      const running = queue.queue_running?.some(item => item[1] === job.promptId);
      const pending = queue.queue_pending?.some(item => item[1] === job.promptId);
      if (running || pending) {
        const nextState = running ? 'running' : 'queued';
        if (job.state !== nextState || job.warning) {
          job.state = nextState; job.warning = undefined; persist(job);
        }
      } else if (job.cancelRequested) {
        job.state = 'cancelled'; job.finishedAt = Date.now(); persist(job);
      } else if (Date.now() - job.createdAt > 15_000) {
        fail(job, new UpscaleError('ComfyUI 中未找到此任务，服务可能已重启或历史被清空，请重试。', 409, 'task_lost'));
      }
    } catch (error) {
      if (error.code === 'runtime_unavailable') {
        const message = 'ComfyUI 连接中断，正在等待恢复；可在高清放大面板启动服务。';
        if (job.warning !== message) { job.warning = message; persist(job); }
      } else fail(job, error);
    }
  }

  function refresh(job) {
    if (!refreshing.has(job.id)) refreshing.set(job.id, refreshInternal(job).finally(() => refreshing.delete(job.id)));
    return refreshing.get(job.id);
  }

  async function submit(owner, input, writeSource) {
    if (!UUID.test(input?.jobId || '')) throw new UpscaleError('无效的任务ID。');
    if (jobs.has(input.jobId)) return publicJob(ownedJob(input.jobId, owner));
    const options = validateOptions(input);
    if (submitting) throw new UpscaleError('已有图片处理任务正在提交。', 409, 'busy');
    submitting = true;
    try {
      await Promise.all([...jobs.values()].filter(job => !FINISHED.has(job.state)).map(refresh));
      if ([...jobs.values()].some(job => !FINISHED.has(job.state))) throw new UpscaleError('服务端 GPU 正在处理图片任务，请等待完成后再试。', 409, 'busy');
      const engine = options.mode === 'remove-background' ? 'background' : UPSCALE_ENGINE;
      const gpuServer = activeGpuServer();
      let state = await inspectRuntime(engine, gpuServer);
      if (!state.running) { await startRuntime(engine, gpuServer); state = await inspectRuntime(engine, gpuServer); }
      if (!state.running) throw new UpscaleError('无法连接图像处理服务。', 503, 'runtime_unavailable');
      if (state.missing.length) throw new UpscaleError('缺少节点或模型：' + state.missing.join('、'), 409, 'models_missing');
      if (!writeSource && (typeof input.imageBase64 !== 'string' || input.imageBase64.length > 30_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.imageBase64))) {
        throw new UpscaleError('图片数据无效或过大。');
      }
      const job = { id: input.jobId, promptId: input.jobId, owner, options, engine, gpuServer: structuredClone(gpuServer),
        ...(engine === UPSCALE_ENGINE ? { seed: UPSCALE_SEED } : {}),
        autoDownload: true, state: 'preparing', createdAt: Date.now() };
      jobs.set(job.id, job); preparing.add(job.id); persist(job);
      try {
        const sourcePath = path.join(directory(job), 'source.png');
        if (writeSource) {
          try {
            await writeSource(sourcePath);
            if (!fs.statSync(sourcePath).size) throw new Error('图片文件为空');
          } catch (error) {
            fs.rmSync(sourcePath, { force: true });
            throw new UpscaleError('图片上传失败，请重试：' + error.message, 400, 'upload_failed');
          }
        } else fs.writeFileSync(sourcePath, Buffer.from(input.imageBase64, 'base64'));
        if (job.cancelRequested) { job.state = 'cancelled'; job.finishedAt = Date.now(); persist(job); return publicJob(job); }
        const size = await imageCommand(options.mode === 'remove-background' ? 'prepare-background' : 'prepare', directory(job), {}, gpuServer);
        job.dimensions = validateDimensions(size.width, size.height, options.scale, options.mode);
        const form = new FormData();
        form.append('image', await fs.openAsBlob(path.join(directory(job), 'input.png'), { type: 'image/png' }), job.id + '.png');
        form.append('subfolder', 'canvas-upscale'); form.append('type', 'input'); form.append('overwrite', 'false');
        let uploaded;
        try { uploaded = await (await comfy('/upload/image', { method: 'POST', body: form }, job.engine, gpuServer)).json(); }
        catch (error) { throw new UpscaleError('上传至 ComfyUI 失败：' + error.message, 502, 'upload_failed'); }
        if (job.cancelRequested) { job.state = 'cancelled'; persist(job); return publicJob(job); }
        const image = uploaded.subfolder ? uploaded.subfolder + '/' + uploaded.name : uploaded.name;
        const graph = buildWorkflow(options, image, job.dimensions, job.id);
        fs.writeFileSync(path.join(directory(job), 'workflow.json'), JSON.stringify(graph, null, 2));
        job.state = 'submitting'; persist(job);
        const result = await (await post('/prompt', { prompt: graph, prompt_id: job.promptId, client_id: owner }, job.engine, gpuServer)).json();
        if (result.prompt_id !== job.promptId) throw new Error('ComfyUI 返回的任务ID不匹配。');
        job.state = 'queued'; persist(job);
        if (job.cancelRequested) await cancel(owner, job.id);
        return publicJob(job);
      } catch (error) {
        if (job.state === 'submitting' && error.code === 'runtime_unavailable') {
          job.warning = '提交响应中断，正在按任务ID确认状态。'; persist(job);
          return publicJob(job);
        }
        fail(job, error); throw error;
      } finally { preparing.delete(job.id); }
    } finally { submitting = false; }
  }

  async function cancel(owner, id) {
    const job = ownedJob(id, owner);
    if (FINISHED.has(job.state)) return publicJob(job);
    job.cancelRequested = true; persist(job);
    const gpuServer = gpuForJob(job);
    await post('/queue', { delete: [job.promptId] }, job.engine, gpuServer);
    await post('/interrupt', { prompt_id: job.promptId }, job.engine, gpuServer);
    await refresh(job);
    return publicJob(job);
  }

  async function getJob(owner, id) {
    const job = ownedJob(id, owner);
    await refresh(job);
    return publicJob(job);
  }

  async function middleware(request, response, authenticatedOwner) {
    const send = (status, body) => {
      if (response.destroyed || response.headersSent) return;
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(JSON.stringify(body));
    };
    try {
      const owner = authenticatedOwner || assertUpscaleRequest(request);
      if (!UUID.test(owner)) throw new UpscaleError('图像处理任务身份无效。', 403, 'invalid_owner');
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname.replace(/^\/api\/upscale/, '');
      if (pathname === '/runtime' && request.method === 'GET') return send(200, await runtime());
      if (pathname === '/runtime/start' && request.method === 'POST') return send(200, await startRuntime());
      if (pathname === '/jobs' && request.method === 'POST') {
        if (request.headers['content-type']?.split(';')[0].trim() === 'application/octet-stream') {
          const query = new URL(request.url, 'http://localhost').searchParams;
          const input = { jobId: query.get('jobId'), mode: query.get('mode'), scale: Number(query.get('scale')) };
          return send(202, await submit(owner, input, sourcePath => pipeline(request, fs.createWriteStream(sourcePath, { flags: 'wx' }))));
        }
        return send(202, await submit(owner, await readJson(request)));
      }
      const match = pathname.match(/^\/jobs\/([a-f0-9-]+)(\/image|\/cancel)?$/);
      if (match && UUID.test(match[1])) {
        if (!match[2] && request.method === 'GET') return send(200, await getJob(owner, match[1]));
        if (match[2] === '/cancel' && request.method === 'POST') return send(200, await cancel(owner, match[1]));
        if (match[2] === '/image' && request.method === 'GET') {
          const job = ownedJob(match[1], owner);
          if (job.state !== 'success') throw new UpscaleError('图片尚未完成。', 409);
          const image = fs.readFileSync(path.join(directory(job), 'result.png'));
          response.writeHead(200, { 'content-type': 'image/png', 'content-length': image.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          response.end(image); return;
        }
      }
      throw new UpscaleError('接口不存在或请求方法不支持。', 404);
    } catch (error) { send(error.status || 500, { error: describeFailure(error) }); }
  }

  const timer = setInterval(() => {
    for (const job of jobs.values()) if (!FINISHED.has(job.state)) void refresh(job).catch(() => {});
  }, 1000);
  timer.unref();
  return { runtime, startRuntime, submit, getJob, cancel, middleware, dispose: () => clearInterval(timer) };
}

export function upscalePlugin(config = {}) {
  return {
    name: 'canvas-local-upscale',
    configureServer(server) {
      const settingsDataDir = config.settingsDataDir || path.join(process.cwd(), 'data');
      const service = createUpscaleService({ ...config, gpuStore: config.gpuStore || createGpuServerSettingsStore(settingsDataDir) });
      server.middlewares.use('/api/upscale', service.middleware);
      server.httpServer?.once('close', service.dispose);
    },
  };
}
