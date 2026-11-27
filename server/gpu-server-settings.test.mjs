import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGpuServerSettingsStore, normalizeGpuServerSettings } from './gpu-server-settings.mjs';

const localServer = (overrides = {}) => ({
  id: 'local-gpu',
  name: '本机 GPU',
  kind: 'local',
  comfyUrl: 'http://127.0.0.1:8188',
  seedUrl: 'http://127.0.0.1:8190',
  installRoot: path.join(os.tmpdir(), 'resonantor-comfyui'),
  ...overrides,
});

const remoteServer = (overrides = {}) => ({
  id: 'remote-gpu',
  name: '局域网 GPU',
  kind: 'remote',
  comfyUrl: 'http://192.168.10.24:8188',
  seedUrl: 'http://192.168.10.24:8190',
  ...overrides,
});

const settings = (overrides = {}) => ({
  activeServerId: 'local-gpu',
  servers: [localServer(), remoteServer()],
  ...overrides,
});

test('GPU 服务配置限制为本机或局域网地址', () => {
  const normalized = normalizeGpuServerSettings(settings({ activeServerId: 'remote-gpu' }));
  assert.equal(normalized.activeServerId, 'remote-gpu');
  assert.equal(normalized.servers[1].installRoot, undefined);

  for (const invalid of [
    settings({ servers: [localServer({ comfyUrl: 'http://192.168.10.24:8188' })] }),
    settings({ servers: [remoteServer({ comfyUrl: 'http://localhost:8188' })], activeServerId: 'remote-gpu' }),
    settings({ servers: [remoteServer({ comfyUrl: 'https://gpu.example.com:8188' })], activeServerId: 'remote-gpu' }),
    settings({ servers: [remoteServer({ comfyUrl: 'http://8.8.8.8:8188' })], activeServerId: 'remote-gpu' }),
  ]) {
    assert.throws(() => normalizeGpuServerSettings(invalid), error => error?.statusCode === 400);
  }
});

test('GPU 服务只允许专用回环地址 18188/18190 作为 SSH 隧道', () => {
  const tunneled = remoteServer({ comfyUrl: 'http://127.0.0.1:18188', seedUrl: 'http://127.0.0.1:18190' });
  assert.equal(normalizeGpuServerSettings(settings({ servers: [tunneled], activeServerId: tunneled.id })).servers[0].comfyUrl, 'http://127.0.0.1:18188');
  assert.equal(normalizeGpuServerSettings(settings({ servers: [tunneled], activeServerId: tunneled.id })).servers[0].seedUrl, 'http://127.0.0.1:18190');

  for (const comfyUrl of ['http://127.0.0.1:18189', 'http://localhost:18188', 'https://127.0.0.1:18188']) {
    const invalid = remoteServer({ comfyUrl, seedUrl: comfyUrl });
    assert.throws(() => normalizeGpuServerSettings(settings({ servers: [invalid], activeServerId: invalid.id })), error => error?.statusCode === 400);
  }
});

test('GPU 服务存储使用修订版本并对普通查看隐藏连接细节', context => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resonantor-gpu-settings-'));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createGpuServerSettingsStore(dataDir);

  assert.equal(store.view(true).revision, 0);
  const saved = store.save(settings(), 0);
  assert.equal(saved.revision, 1);
  assert.equal(saved.settings.servers.length, 2);
  assert.throws(() => store.save(settings(), 0), error => error?.statusCode === 409 && error?.type === 'gpu_settings_conflict');

  const publicView = store.view(false);
  assert.equal(publicView.settings.servers[0].comfyUrl, undefined);
  assert.equal(publicView.settings.servers[0].installRoot, undefined);
  assert.equal(publicView.settings.servers[1].managed, false);

  const activated = store.activate('remote-gpu', saved.revision);
  assert.equal(activated.revision, 2);
  assert.equal(store.active().id, 'remote-gpu');
});

test('GPU 服务可从服务端部署配置读取本机 ComfyUI 根目录', context => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resonantor-gpu-default-'));
  context.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const installRoot = path.join(os.tmpdir(), 'configured-comfyui-root');
  const store = createGpuServerSettingsStore(dataDir, { defaultServer: localServer({ installRoot }) });
  assert.equal(store.active().installRoot, installRoot);
  assert.equal(store.view(true).settings.servers[0].installRoot, installRoot);
});
