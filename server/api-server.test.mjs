import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApiServer, extractModelIds, loadConfig, normalizeModelListUrl } from './api-server.mjs';
import { HttpError, isPublicIpAddress, matchesHostPattern, validateTargetUrl } from './security.mjs';

test('host patterns only match exact hosts or explicit suffixes', () => {
  assert.equal(matchesHostPattern('api.openai.com', 'api.openai.com'), true);
  assert.equal(matchesHostPattern('evil-api.openai.com', 'api.openai.com'), false);
  assert.equal(matchesHostPattern('cdn.openai.com', '*.openai.com'), true);
  assert.equal(matchesHostPattern('openai.com', '*.openai.com'), false);
  assert.equal(matchesHostPattern('openai.com', '.openai.com'), true);
});

test('private, reserved, and documentation IP ranges are blocked', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.103', '169.254.1.1', '100.64.0.1', '203.0.113.10', '::1', 'fd00::1', '::ffff:7f00:1']) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  assert.equal(isPublicIpAddress('8.8.8.8'), true);
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true);
});

test('target validation rejects a whitelisted hostname resolving privately', async () => {
  await assert.rejects(
    validateTargetUrl('https://api.example.com/v1', ['api.example.com'], async () => [
      { address: '192.168.1.10', family: 4 },
    ]),
    error => error instanceof HttpError && error.statusCode === 403 && error.type === 'private_target_blocked'
  );
});

test('target validation rejects non-HTTPS and non-whitelisted URLs before forwarding', async () => {
  await assert.rejects(
    validateTargetUrl('http://api.openai.com/v1', ['api.openai.com']),
    error => error instanceof HttpError && error.statusCode === 400
  );
  await assert.rejects(
    validateTargetUrl('https://example.com/v1', ['api.openai.com']),
    error => error instanceof HttpError && error.statusCode === 403
  );
});

test('model list helpers preserve existing provider response formats', () => {
  assert.equal(normalizeModelListUrl('https://api.openai.com/v1/chat/completions', 'openai'), 'https://api.openai.com/v1/models');
  assert.equal(normalizeModelListUrl('https://generativelanguage.googleapis.com/v1beta', 'gemini'), 'https://generativelanguage.googleapis.com/v1beta/models');
  assert.deepEqual(extractModelIds({
    data: [{ id: 'gpt-4.1' }],
    models: [{ name: 'models/gemini-2.5-pro' }],
  }), ['gpt-4.1', 'gemini-2.5-pro']);
});

test('cookie paths are URL-encoded once for non-ASCII subpaths', () => {
  const expected = '/%E5%85%B1%E6%8C%AF%E7%94%BB%E5%B8%83';
  assert.equal(loadConfig({ CANVAS_SESSION_COOKIE_PATH: '/共振画布' }).sessionCookiePath, expected);
  assert.equal(loadConfig({ CANVAS_SESSION_COOKIE_PATH: expected }).sessionCookiePath, expected);
});

const startServer = async overrides => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-api-test-'));
  const server = createApiServer({
    ...loadConfig({}),
    host: '127.0.0.1',
    port: 0,
    publicOrigins: [],
    rateMax: 100,
    expensiveRateMax: 100,
    dataDir,
    adminUser: 'admin',
    adminPassword: 'Canvas@0970',
    managedModels: false,
    ...overrides,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}`, dataDir };
};

const readErrorType = async response => (await response.json()).error.type;

const login = async (baseUrl, expectedPath = null) => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Canvas@0970' }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /canvas_session=/);
  if (expectedPath) assert.match(cookie, expectedPath);
  return cookie.split(';')[0];
};

test('health endpoint works without a login', async t => {
  const { server, baseUrl, dataDir } = await startServer();
  t.after(() => server.close());
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
});

test('auth endpoints create and read a session with a subpath cookie', async t => {
  const { server, baseUrl, dataDir } = await startServer({ sessionCookiePath: '/共振画布' });
  t.after(() => server.close());
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const anonymous = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(anonymous.status, 401);
  assert.equal(await readErrorType(anonymous), 'login_required');

  const cookie = await login(baseUrl, /Path=\/%E5%85%B1%E6%8C%AF%E7%94%BB%E5%B8%83/);
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.username, 'admin');
});

test('project APIs require login and persist the default project', async t => {
  const { server, baseUrl, dataDir } = await startServer();
  t.after(() => server.close());
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const unauthenticated = await fetch(`${baseUrl}/api/projects/default`);
  assert.equal(unauthenticated.status, 401);
  assert.equal(await readErrorType(unauthenticated), 'login_required');

  const cookie = await login(baseUrl);

  const projectData = {
    nodes: [{ id: 'node-1', type: 'text', position: { x: 0, y: 0 }, width: 320, height: 240, content: 'hello' }],
    connections: [],
    groups: [],
    viewport: { x: 0, y: 0, k: 1 },
    settings: {},
  };

  const saved = await fetch(`${baseUrl}/api/projects/default`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: '默认画布', data: projectData }),
  });
  assert.equal(saved.status, 200);

  const loaded = await fetch(`${baseUrl}/api/projects/default`, { headers: { cookie } });
  assert.equal(loaded.status, 200);
  assert.deepEqual((await loaded.json()).project.data.nodes, projectData.nodes);
});

test('desktop file APIs stay disabled after login', async t => {
  const { server, baseUrl, dataDir } = await startServer();
  t.after(() => server.close());
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const desktop = await fetch(`${baseUrl}/api/choose-save-directory`, { method: 'POST' });
  assert.equal(desktop.status, 501);
  assert.equal(await readErrorType(desktop), 'desktop_api_disabled');
});

test('published image processing routes require login and scope jobs to each account', async t => {
  const calls = [];
  const upscaleService = {
    async middleware(request, response, owner) {
      calls.push({ path: request.url, method: request.method, owner });
      const body = Buffer.from(JSON.stringify({ path: request.url, owner }));
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
      response.end(body);
    },
    dispose() {},
  };
  const { server, baseUrl, dataDir } = await startServer({ upscaleService });
  t.after(() => server.close());
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const clientId = '9cb93ae8-2f11-4bc2-999f-9fb8b54fb9b9';
  const anonymous = await fetch(`${baseUrl}/api/upscale/runtime`, { headers: { 'x-upscale-client': clientId } });
  assert.equal(anonymous.status, 401);

  const adminCookie = await login(baseUrl);
  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'image-member', password: 'ImageMemberPassword123!' }),
  });
  assert.equal(registration.status, 201);
  const memberCookie = registration.headers.get('set-cookie').split(';')[0];

  const invalidClient = await fetch(`${baseUrl}/api/upscale/runtime`, { headers: { cookie: adminCookie, 'x-upscale-client': '../invalid' } });
  assert.equal(invalidClient.status, 400);
  const crossSite = await fetch(`${baseUrl}/api/upscale/runtime/start`, {
    method: 'POST', headers: { cookie: adminCookie, origin: 'http://evil.example', 'content-type': 'application/json', 'x-upscale-client': clientId }, body: '{}',
  });
  assert.equal(crossSite.status, 403);

  const adminRuntime = await fetch(`${baseUrl}/api/upscale/runtime`, { headers: { cookie: adminCookie, 'x-upscale-client': clientId } });
  const adminDocument = await adminRuntime.json();
  assert.equal(adminRuntime.status, 200);
  assert.equal(adminDocument.path, '/api/upscale/runtime');
  assert.match(adminDocument.owner, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const memberRuntime = await fetch(`${baseUrl}/api/upscale/runtime`, { headers: { cookie: memberCookie, 'x-upscale-client': clientId } });
  const memberDocument = await memberRuntime.json();
  assert.equal(memberRuntime.status, 200);
  assert.notEqual(memberDocument.owner, adminDocument.owner);
  const repeated = await fetch(`${baseUrl}/api/upscale/runtime`, { headers: { cookie: adminCookie, 'x-upscale-client': clientId } });
  assert.equal((await repeated.json()).owner, adminDocument.owner);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.owner !== clientId));
});

test('GPU 服务窗口接口仅管理员可配置和切换', async t => {
  const { server, baseUrl, dataDir } = await startServer();
  t.after(() => server.close());
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const anonymous = await fetch(`${baseUrl}/api/admin/gpu-servers`);
  assert.equal(anonymous.status, 401);

  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member-gpu', password: 'MemberPassword123!' }),
  });
  assert.equal(registration.status, 201);
  const memberCookie = registration.headers.get('set-cookie').split(';')[0];
  const forbidden = await fetch(`${baseUrl}/api/admin/gpu-servers`, { headers: { cookie: memberCookie } });
  assert.equal(forbidden.status, 403);

  const adminCookie = await login(baseUrl);
  const initial = await fetch(`${baseUrl}/api/admin/gpu-servers`, { headers: { cookie: adminCookie } });
  assert.equal(initial.status, 200);
  const document = await initial.json();
  document.settings.servers.push({
    id: 'lan-gpu',
    name: '局域网 GPU',
    kind: 'remote',
    comfyUrl: 'http://192.168.10.24:8188',
    seedUrl: 'http://192.168.10.24:8190',
  });
  document.settings.activeServerId = 'lan-gpu';

  const saved = await fetch(`${baseUrl}/api/admin/gpu-servers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ revision: document.revision, settings: document.settings }),
  });
  assert.equal(saved.status, 200);
  const savedDocument = await saved.json();
  assert.equal(savedDocument.settings.activeServerId, 'lan-gpu');

  const legacyPut = await fetch(`${baseUrl}/api/admin/gpu-servers`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ revision: savedDocument.revision, settings: savedDocument.settings }),
  });
  assert.equal(legacyPut.status, 200);
  const legacyDocument = await legacyPut.json();

  const activated = await fetch(`${baseUrl}/api/admin/gpu-servers/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ revision: legacyDocument.revision, id: 'primary-local-gpu' }),
  });
  assert.equal(activated.status, 200);
  assert.equal((await activated.json()).settings.activeServerId, 'primary-local-gpu');
});

test('cross-site API requests are rejected before auth', async t => {
  const { server, baseUrl, dataDir } = await startServer();
  t.after(() => server.close());
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const crossSite = await fetch(`${baseUrl}/api/openai-chat-proxy`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://attacker.example',
      'sec-fetch-site': 'cross-site',
    },
    body: '{}',
  });
  assert.equal(crossSite.status, 403);
  assert.equal(await readErrorType(crossSite), 'cross_site_request');
});

test('AI proxies require login before forwarding', async t => {
  const { server, baseUrl, dataDir } = await startServer();
  t.after(() => server.close());
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const response = await fetch(`${baseUrl}/api/openai-chat-proxy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetUrl: 'https://example.com/v1/chat/completions', apiKey: 'public', payload: {} }),
  });
  assert.equal(response.status, 401);
  assert.equal(await readErrorType(response), 'login_required');
});

test('authenticated non-whitelisted targets are rejected', async t => {
  const { server, baseUrl, dataDir } = await startServer();
  t.after(() => server.close());
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const cookie = await login(baseUrl);
  const blocked = await fetch(`${baseUrl}/api/openai-chat-proxy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ targetUrl: 'https://example.com/v1/chat/completions', apiKey: 'logged', payload: {} }),
  });
  assert.equal(blocked.status, 403);
  assert.equal(await readErrorType(blocked), 'target_not_allowed');
});

test('upload proxy is off until an approved target is configured', async t => {
  const { server, baseUrl, dataDir } = await startServer({ uploadTarget: '' });
  t.after(() => server.close());
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const cookie = await login(baseUrl);
  const response = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { cookie },
    body: 'test',
  });
  assert.equal(response.status, 503);
  assert.equal(await readErrorType(response), 'upload_proxy_disabled');
});

test('rate limiting returns 429 without contacting an upstream service', async t => {
  const { server, baseUrl, dataDir } = await startServer({ rateMax: 1, expensiveRateMax: 1 });
  t.after(() => server.close());
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const cookie = await login(baseUrl);
  const first = await fetch(`${baseUrl}/api/not-found`, {
    method: 'POST',
    headers: { cookie },
  });
  assert.equal(first.status, 404);
  const second = await fetch(`${baseUrl}/api/not-found`, {
    method: 'POST',
    headers: { cookie },
  });
  assert.equal(second.status, 429);
  assert.equal(await readErrorType(second), 'rate_limited');
});
