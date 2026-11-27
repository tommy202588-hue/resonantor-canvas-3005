import http from 'node:http';
import https from 'node:https';
import { pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { loadSessionSecret } from './auth-secrets.mjs';
import { createWechatAuth, wechatConfiguration } from './wechat-auth.mjs';
import { serveAdminConsole } from './admin-console.mjs';
import { replacePrivateFile } from './private-file.mjs';
import { createModelSettingsStore } from './model-settings.mjs';
import { resolveModelRequest } from './model-request.mjs';
import { createProxyRequestLifetime } from './proxy-request-lifetime.mjs';
import { createGeneratedImageDownloads } from './generated-image-downloads.mjs';
import { serveModelConsole } from './model-console.mjs';
import { createGpuServerSettingsStore, DEFAULT_GPU_SERVER } from './gpu-server-settings.mjs';
import { serveGpuConsole } from './gpu-console.mjs';
import { createUpscaleService } from './upscale-service.mjs';
import { normalizePublicBasePath } from './public-path.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  HttpError,
  createSafeLookup,
  parseHostPatterns,
  validateTargetUrl,
} from './security.mjs';

const DEFAULT_UPSTREAM_HOSTS = [
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'api.openlux.ai',
  'fourq.hk',
  'yunwu.ai',
  'api.minimaxi.com',
  'api.xwang.store',
];

const DEFAULT_DOWNLOAD_HOSTS = [
  ...DEFAULT_UPSTREAM_HOSTS,
  '*.openai.com',
  '*.oaistatic.com',
  'oaidalleapiprodscus.blob.core.windows.net',
  'oaidalleapiprodweu.blob.core.windows.net',
  'oaidalleapiprodwus.blob.core.windows.net',
  'storage.googleapis.com',
];

const numberFromEnv = (value, fallback, min, max) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
};

const normalizeCookiePath = value => {
  const raw = String(value || '/').trim() || '/';
  const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
  try {
    return encodeURI(decodeURI(prefixed)).replace(/[;\r\n]/g, '');
  } catch {
    return encodeURI(prefixed).replace(/[;\r\n]/g, '');
  }
};

const UPSCALE_CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const createAccountUpscaleOwner = (userId, clientId) => {
  if (!UPSCALE_CLIENT_ID.test(clientId || '')) throw new HttpError(400, '图像处理客户端身份无效，请刷新页面后重试。', 'invalid_upscale_client');
  const digest = createHash('sha256').update('resonantor-upscale-v1\0').update(userId).update('\0').update(clientId.toLowerCase()).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const value = digest.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
};

export const loadConfig = (env = process.env) => ({
  publicBasePath: normalizePublicBasePath(env.CANVAS_PUBLIC_BASE_PATH),
  host: env.API_HOST || '0.0.0.0',
  port: numberFromEnv(env.API_PORT, 5112, 1, 65535),
  upstreamHosts: parseHostPatterns(env.ALLOWED_UPSTREAM_HOSTS, DEFAULT_UPSTREAM_HOSTS),
  downloadHosts: parseHostPatterns(env.ALLOWED_DOWNLOAD_HOSTS, DEFAULT_DOWNLOAD_HOSTS),
  publicOrigins: String(env.PUBLIC_ORIGINS || '')
    .split(',')
    .map(value => value.trim().replace(/\/$/, ''))
    .filter(Boolean),
  uploadTarget: String(env.UPLOAD_PROXY_TARGET || '').trim(),
  managedModels: env.CANVAS_MANAGED_MODELS !== 'false',
  unlimitedModelRequests: env.CANVAS_UNLIMITED_MODEL_REQUESTS === 'true',
  requestTimeoutMs: numberFromEnv(env.REQUEST_TIMEOUT_MS, 300000, 5000, 900000),
  jsonBodyLimit: numberFromEnv(env.JSON_BODY_LIMIT_BYTES, 64 * 1024 * 1024, 1024, 128 * 1024 * 1024),
  uploadBodyLimit: numberFromEnv(env.UPLOAD_BODY_LIMIT_BYTES, 128 * 1024 * 1024, 1024, 512 * 1024 * 1024),
  responseBodyLimit: numberFromEnv(env.RESPONSE_BODY_LIMIT_BYTES, 64 * 1024 * 1024, 1024, 256 * 1024 * 1024),
  downloadResponseLimit: numberFromEnv(env.DOWNLOAD_RESPONSE_LIMIT_BYTES, 32 * 1024 * 1024, 1024, 128 * 1024 * 1024),
  rateWindowMs: numberFromEnv(env.RATE_LIMIT_WINDOW_MS, 60000, 1000, 3600000),
  rateMax: numberFromEnv(env.RATE_LIMIT_MAX, 120, 1, 10000),
  expensiveRateMax: numberFromEnv(env.EXPENSIVE_RATE_LIMIT_MAX, 30, 1, 10000),
  downloadRateMax: numberFromEnv(env.DOWNLOAD_RATE_LIMIT_MAX, 30, 1, 10000),
  maxConcurrency: numberFromEnv(env.MAX_CONCURRENCY, 8, 1, 128),
  maxConcurrencyPerIp: numberFromEnv(env.MAX_CONCURRENCY_PER_IP, 3, 1, 32),
  maxUploadConcurrency: numberFromEnv(env.MAX_UPLOAD_CONCURRENCY, 2, 1, 16),
  dataDir: env.CANVAS_DATA_DIR || path.join(process.cwd(), 'data'),
  adminUser: env.CANVAS_ADMIN_USER || 'admin',
  adminPassword: env.CANVAS_ADMIN_PASSWORD || '',
  sessionSecret: env.CANVAS_SESSION_SECRET || '',
  upscaleInstallRoot: env.CANVAS_UPSCALE_INSTALL_ROOT || '',
  upscaleImagePython: env.CANVAS_UPSCALE_IMAGE_PYTHON || '',
  upscaleComfyPython: env.CANVAS_UPSCALE_COMFY_PYTHON || '',
  secureCookies: env.CANVAS_COOKIE_SECURE !== 'false',
  wechatAppId: env.WECHAT_APP_ID || '',
  wechatAppSecret: env.WECHAT_APP_SECRET || '',
  wechatRedirectUri: env.WECHAT_REDIRECT_URI || '',
  adminDisplayName: env.CANVAS_ADMIN_DISPLAY_NAME || '管理员',
  sessionCookieName: env.CANVAS_SESSION_COOKIE || 'canvas_session',
  sessionCookiePath: normalizeCookiePath(env.CANVAS_SESSION_COOKIE_PATH || '/'),
  sessionTtlMs: numberFromEnv(env.CANVAS_SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000, 60 * 1000, 90 * 24 * 60 * 60 * 1000),
});

const sendJson = (res, statusCode, payload, extraHeaders = {}) => {
  if (res.headersSent || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
};

const setSecurityHeaders = res => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
};

const getClientIp = req => {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
};

const requireSameOrigin = (req, config) => {
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site') {
    throw new HttpError(403, 'Cross-site API requests are not allowed.', 'cross_site_request');
  }

  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  if (!origin) return;
  if (config.publicOrigins.includes(origin)) return;

  let originHost = '';
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    throw new HttpError(403, 'Invalid request origin.', 'invalid_origin');
  }

  const requestHost = String(req.headers.host || '').toLowerCase();
  if (!requestHost || originHost !== requestHost) {
    throw new HttpError(403, 'Request origin does not match the public host.', 'origin_not_allowed');
  }
};

const readBody = (req, limit) => new Promise((resolve, reject) => {
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > limit) {
    req.resume();
    reject(new HttpError(413, 'Request body is too large.', 'request_too_large'));
    return;
  }

  const chunks = [];
  let received = 0;
  let settled = false;

  req.on('data', chunk => {
    if (settled) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > limit) {
      settled = true;
      req.resume();
      reject(new HttpError(413, 'Request body is too large.', 'request_too_large'));
      return;
    }
    chunks.push(buffer);
  });
  req.on('end', () => {
    if (settled) return;
    settled = true;
    resolve(Buffer.concat(chunks));
  });
  req.on('error', error => {
    if (settled) return;
    settled = true;
    reject(error);
  });
});

const readJson = async (req, limit) => {
  const raw = await readBody(req, limit);
  try {
    return JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.', 'invalid_json');
  }
};

const assertMethod = (req, method) => {
  if (req.method !== method) {
    throw new HttpError(405, 'Method not allowed.', 'method_not_allowed');
  }
};

const base64Url = buffer => buffer.toString('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/g, '');

export const hashPassword = (password, salt = base64Url(randomBytes(18))) => {
  const iterations = 210000;
  const digest = pbkdf2Sync(String(password), salt, iterations, 32, 'sha256');
  return `pbkdf2_sha256$${iterations}$${salt}$${base64Url(digest)}`;
};

const verifyPassword = (password, storedHash) => {
  const [scheme, iterationsText, salt, expectedText] = String(storedHash || '').split('$');
  if (scheme !== 'pbkdf2_sha256' || !iterationsText || !salt || !expectedText) return false;
  const iterations = Number(iterationsText);
  if (!Number.isFinite(iterations) || iterations < 100000) return false;
  const actual = Buffer.from(base64Url(pbkdf2Sync(String(password), salt, iterations, 32, 'sha256')));
  const expected = Buffer.from(expectedText);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const ensureDirectory = dir => fs.mkdirSync(dir, { recursive: true });

const readJsonFile = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const writeJsonFile = (file, data) => {
  ensureDirectory(path.dirname(file));
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
  replacePrivateFile(tempFile, file);
};

const createAuthStore = config => {
  const sessionSecret = loadSessionSecret(config);
  const sessionHash = token => createHash('sha256').update(token).digest('hex');
  const signSession = token => createHmac('sha256', sessionSecret).update(token).digest('base64url');
  const usersFile = path.join(config.dataDir, 'users.json');
  const sessionsFile = path.join(config.dataDir, 'sessions.json');
  const projectsDir = path.join(config.dataDir, 'projects');
  ensureDirectory(projectsDir);

  const ensureDefaultUser = () => {
    let users;
    try { users = JSON.parse(fs.readFileSync(usersFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('用户数据无法读取，请检查备份，系统不会覆盖现有账号。'); users = []; }
    if (!Array.isArray(users)) throw new Error('用户数据格式无效。');
    if (users.length > 0 || !config.adminPassword) return users;
    const defaultUser = {
      id: 'admin',
      role: 'admin',
      username: config.adminUser,
      displayName: config.adminDisplayName,
      passwordHash: hashPassword(config.adminPassword),
      createdAt: Date.now(),
    };
    writeJsonFile(usersFile, [defaultUser]);
    return [defaultUser];
  };

  const upsertWechatUser = identity => {
    const users = ensureDefaultUser();
    const existing = users.find(user => user.wechat?.appId === config.wechatAppId && user.wechat.openId === identity.openId);
    if (existing) return existing;
    const id = randomUUID();
    const user = { id, username: 'wx_' + id, displayName: '微信用户 ' + id.slice(-6), createdAt: Date.now(), wechat: { appId: config.wechatAppId, openId: identity.openId, ...(identity.unionId ? { unionId: identity.unionId } : {}) } };
    users.push(user);
    writeJsonFile(usersFile, users);
    return user;
  };

  const registerUser = (username, password) => {
    const users = ensureDefaultUser();
    if (users.some(user => user.username.toLowerCase() === username.toLowerCase())) {
      throw new HttpError(409, '该用户名已被注册，请修改用户名后重试。', 'username_unavailable');
    }
    if (username.toLowerCase() === config.adminUser.toLowerCase()) {
      throw new HttpError(409, '该用户名不可用，请更换后重试。', 'username_unavailable');
    }
    const user = { id: randomUUID(), username, displayName: username, role: 'user', passwordHash: hashPassword(password), createdAt: Date.now() };
    writeJsonFile(usersFile, [...users, user]);
    return user;
  };

  const publicUser = user => ({
    id: user.username,
    role: user.role === 'admin' || user.id === 'admin' ? 'admin' : 'user',
    username: user.username,
    displayName: user.displayName || user.username,
  });

  const findUser = username => ensureDefaultUser()
    .find(user => user.username.toLowerCase() === String(username || '').trim().toLowerCase());

  const getSession = token => {
    if (!token) return null;
    const sessions = readJsonFile(sessionsFile, {});
    const [nonce, signature] = token.split('.');
    if (signature) {
      const expected = Buffer.from(signSession(nonce));
      const actual = Buffer.from(signature);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    }
    const key = signature ? sessionHash(token) : token;
    const session = sessions[key];
    if (!session || session.expiresAt <= Date.now()) {
      if (session) {
        delete sessions[key];
        writeJsonFile(sessionsFile, sessions);
      }
      return null;
    }
    const user = ensureDefaultUser().find(candidate => candidate.id === session.userId);
    return user ? { token, user } : null;
  };

  const createSession = user => {
    const sessions = readJsonFile(sessionsFile, {});
    const nonce = base64Url(randomBytes(32));
    const token = nonce + '.' + signSession(nonce);
    sessions[sessionHash(token)] = {
      userId: user.id,
      createdAt: Date.now(),
      expiresAt: Date.now() + config.sessionTtlMs,
    };
    writeJsonFile(sessionsFile, sessions);
    return token;
  };

  const deleteSession = token => {
    if (!token) return;
    const sessions = readJsonFile(sessionsFile, {});
    delete sessions[token];
    delete sessions[sessionHash(token)];
    writeJsonFile(sessionsFile, sessions);
  };

  const projectFile = (userId, projectId) => {
    const safeProjectId = String(projectId || '').replace(/[^a-z0-9_-]/gi, '');
    if (!safeProjectId) throw new HttpError(400, 'Invalid project id.', 'invalid_project_id');
    return path.join(projectsDir, `${userId}-${safeProjectId}.json`);
  };

  const listProjects = userId => {
    ensureDirectory(projectsDir);
    return fs.readdirSync(projectsDir)
      .filter(name => name.startsWith(`${userId}-`) && name.endsWith('.json'))
      .map(name => readJsonFile(path.join(projectsDir, name), null))
      .filter(Boolean)
      .map(project => ({
        id: project.id,
        name: project.name,
        updatedAt: project.updatedAt,
        createdAt: project.createdAt,
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  };

  const getProject = (userId, projectId) => {
    const file = projectFile(userId, projectId);
    if (!fs.existsSync(file)) return null;
    return readJsonFile(file, null);
  };

  const saveProject = (userId, projectId, name, data) => {
    const existing = getProject(userId, projectId);
    const now = Date.now();
    const project = {
      id: projectId,
      userId,
      name: String(name || existing?.name || '默认画布').slice(0, 120),
      data,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    writeJsonFile(projectFile(userId, projectId), project);
    return project;
  };

  return {
    publicUser,
    registerUser,
    upsertWechatUser,
    listUsers: () => ensureDefaultUser().map(user => ({ ...publicUser(user), createdAt: user.createdAt, provider: user.wechat ? 'wechat' : 'password' })),
    findUser,
    verifyPassword,
    getSession,
    createSession,
    deleteSession,
    listProjects,
    getProject,
    saveProject,
  };
};

const parseCookies = req => {
  const cookies = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const index = part.indexOf('=');
    if (index === -1) return;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  });
  return cookies;
};

const buildSessionCookie = (config, token, maxAgeSeconds) => [
  `${config.sessionCookieName}=${encodeURIComponent(token)}`,
  'HttpOnly',
  'SameSite=Lax',
  ...(config.secureCookies ? ['Secure'] : []),
  `Path=${config.sessionCookiePath}`,
  `Max-Age=${maxAgeSeconds}`,
].join('; ');

const getRequestUser = (req, config, authStore) => {
  const token = parseCookies(req)[config.sessionCookieName];
  const session = authStore.getSession(token);
  return session?.user || null;
};

const requireUser = (req, config, authStore) => {
  const user = getRequestUser(req, config, authStore);
  if (!user) throw new HttpError(401, 'Login required.', 'login_required');
  return user;
};

const collectResponse = (upstream, limit) => new Promise((resolve, reject) => {
  const declaredLength = Number(upstream.headers['content-length'] || 0);
  if (declaredLength > limit) {
    upstream.destroy();
    reject(new HttpError(502, 'Upstream response is too large.', 'upstream_response_too_large'));
    return;
  }

  const chunks = [];
  let received = 0;
  upstream.on('data', chunk => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > limit) {
      upstream.destroy(new Error('Upstream response is too large.'));
      return;
    }
    chunks.push(buffer);
  });
  upstream.on('end', () => resolve(Buffer.concat(chunks)));
  upstream.on('error', error => {
    if (received > limit) {
      reject(new HttpError(502, 'Upstream response is too large.', 'upstream_response_too_large'));
    } else {
      reject(error);
    }
  });
});

const forwardRequest = async ({
  targetUrl,
  patterns,
  method = 'GET',
  headers = {},
  body,
  timeoutMs,
  responseLimit,
  redirects = 0,
  generatedDownload = false,
  signal,
}) => {
  signal?.throwIfAborted();
  if (generatedDownload) patterns = [new URL(targetUrl).hostname];
  const target = await validateTargetUrl(targetUrl, patterns);
  signal?.throwIfAborted();
  const lookup = createSafeLookup(patterns);

  const response = await new Promise((resolve, reject) => {
    const request = https.request({
      protocol: 'https:',
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        accept: '*/*',
        'user-agent': 'X-tapnow-NAS/1.0',
        ...headers,
        ...(body ? { 'content-length': body.length } : {}),
      },
      lookup,
      servername: target.hostname,
      timeout: timeoutMs,
      signal,
    }, async upstream => {
      try {
        resolve({
          statusCode: upstream.statusCode || 502,
          headers: upstream.headers,
          body: await collectResponse(upstream, responseLimit),
        });
      } catch (error) {
        reject(error);
      }
    });

    request.on('timeout', () => request.destroy(new HttpError(504, 'Upstream request timed out.', 'upstream_timeout')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });

  const location = response.headers.location;
  if (redirects > 0 && [301, 302, 303, 307, 308].includes(response.statusCode) && location) {
    const nextUrl = new URL(String(location), target).toString();
    return forwardRequest({
      targetUrl: nextUrl,
      patterns,
      method: response.statusCode === 303 ? 'GET' : method,
      headers,
      body: response.statusCode === 303 ? undefined : body,
      timeoutMs,
      responseLimit,
      redirects: redirects - 1,
      generatedDownload,
      signal,
    });
  }

  return response;
};

const forwardJson = async (targetUrl, apiKey, payload, authHeader, config) => {
  const body = Buffer.from(JSON.stringify(payload));
  const headerName = authHeader === 'x-goog-api-key' ? 'x-goog-api-key' : 'authorization';
  const headers = {
    'content-type': 'application/json',
    [headerName]: headerName === 'x-goog-api-key' ? apiKey : `Bearer ${apiKey}`,
  };

  let upstream = await forwardRequest({
    targetUrl,
    patterns: config.upstreamHosts,
    method: 'POST',
    headers,
    body,
    timeoutMs: config.requestTimeoutMs,
    responseLimit: config.responseBodyLimit,
  });
  if (upstream.statusCode === 200 && upstream.body.length === 0) {
    upstream = await forwardRequest({
      targetUrl,
      patterns: config.upstreamHosts,
      method: 'POST',
      headers,
      body,
      timeoutMs: config.requestTimeoutMs,
      responseLimit: config.responseBodyLimit,
    });
  }
  return upstream;
};

const dataUrlToBuffer = (dataUrl, fallbackMime = 'application/octet-stream') => {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) throw new HttpError(400, 'Invalid form-data file payload.', 'invalid_file_payload');
  const candidateMime = match[1] || fallbackMime;
  const mimeType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(candidateMime)
    ? candidateMime
    : 'application/octet-stream';
  const data = match[2]
    ? Buffer.from(match[3] || '', 'base64')
    : Buffer.from(decodeURIComponent(match[3] || ''), 'utf8');
  return { data, mimeType };
};

const quoteDisposition = value => String(value || '').replace(/["\r\n]/g, '_');

const serializeFormData = entries => {
  const boundary = `xtapnow-${randomBytes(18).toString('hex')}`;
  const chunks = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.name !== 'string') continue;
    const name = quoteDisposition(entry.name);
    if (entry.kind === 'file') {
      const { data, mimeType } = dataUrlToBuffer(entry.dataUrl, entry.mimeType || 'image/png');
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${quoteDisposition(entry.fileName || 'image.png')}"\r\nContent-Type: ${mimeType}\r\n\r\n`
      ));
      chunks.push(data, Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(entry.value ?? '')}\r\n`
      ));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
};

export const normalizeModelListUrl = (baseUrl, providerType) => {
  let base = String(baseUrl || '').trim();
  if (!base) {
    base = providerType === 'gemini'
      ? 'https://generativelanguage.googleapis.com'
      : 'https://api.openai.com';
  }
  base = base.replace(/\/$/, '')
    .replace(/\/v1\/chat\/completions$/i, '')
    .replace(/\/v1\/models$/i, '')
    .replace(/\/v1beta\/models$/i, '')
    .replace(/\/v1beta$/i, '')
    .replace(/\/v1$/i, '');
  return providerType === 'gemini' ? `${base}/v1beta/models` : `${base}/v1/models`;
};

export const extractModelIds = data => {
  const ids = new Set();
  const add = value => {
    if (typeof value !== 'string') return;
    const normalized = value.trim().replace(/^models\//, '');
    if (normalized) ids.add(normalized);
  };
  if (Array.isArray(data)) data.forEach(item => add(typeof item === 'string' ? item : item?.id || item?.name));
  if (Array.isArray(data?.data)) data.data.forEach(item => add(item?.id || item?.name));
  if (Array.isArray(data?.models)) data.models.forEach(item => add(item?.id || item?.name));
  return [...ids];
};

const copyUpstreamResponse = (res, upstream, fallbackType = 'application/json; charset=utf-8') => {
  res.statusCode = upstream.statusCode;
  res.setHeader('content-type', String(upstream.headers['content-type'] || fallbackType));
  res.setHeader('cache-control', 'no-store');
  res.end(upstream.body);
};

const createLimiter = config => {
  const buckets = new Map();
  let checksSinceSweep = 0;
  let active = 0;
  let activeUploads = 0;
  const activeByIp = new Map();

  const checkRate = (ip, category = 'general') => {
    const now = Date.now();
    checksSinceSweep += 1;
    if (checksSinceSweep >= 500 || buckets.size > 10000) {
      checksSinceSweep = 0;
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(bucketKey);
      }
      while (buckets.size > 10000) {
        buckets.delete(buckets.keys().next().value);
      }
    }
    const key = `${ip}:${category}`;
    const limit = category === 'expensive'
      ? config.expensiveRateMax
      : category === 'download'
        ? config.downloadRateMax
        : config.rateMax;
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + config.rateWindowMs });
      return;
    }
    current.count += 1;
    if (current.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      throw new HttpError(429, `Rate limit exceeded. Retry after ${retryAfter} seconds.`, 'rate_limited');
    }
  };

  const acquire = (ip, category = 'general', ownerKind = 'client') => {
    const perIp = activeByIp.get(ip) || 0;
    if (active >= config.maxConcurrency
      || perIp >= config.maxConcurrencyPerIp
      || (category === 'upload' && activeUploads >= config.maxUploadConcurrency)) {
      const scope = perIp >= config.maxConcurrencyPerIp ? 'owner' : active >= config.maxConcurrency ? 'global' : 'upload';
      const message = scope === 'owner'
        ? `${ownerKind === 'account' ? '当前账号' : '当前连接来源'}已有 ${perIp} 个请求处理中（上限 ${config.maxConcurrencyPerIp}）。请等待现有任务完成后再提交；本次请求尚未发送到模型。`
        : scope === 'global' ? `代理服务已达到 ${config.maxConcurrency} 个同时处理请求的上限。请等待现有任务完成后再提交；本次请求尚未发送到模型。`
            : '上传请求正在处理中，请稍后再提交；本次请求尚未发送到模型。';
      throw Object.assign(new HttpError(503, message, 'concurrency_limit'), { retryAfter: 10, limitScope: scope, activeRequests: active, ownerActiveRequests: perIp });
    }
    active += 1;
    if (category === 'upload') activeUploads += 1;
    activeByIp.set(ip, perIp + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      if (category === 'upload') activeUploads = Math.max(0, activeUploads - 1);
      const next = Math.max(0, (activeByIp.get(ip) || 1) - 1);
      if (next === 0) activeByIp.delete(ip);
      else activeByIp.set(ip, next);
    };
  };

  return { checkRate, acquire };
};

const modelSettingsView = (store, config, admin = false) => {
  const document = store.view(admin);
  const configured = document.settings.concurrencyLimit || 3;
  const effective = config.unlimitedModelRequests ? configured : Math.min(configured, config.maxConcurrency, config.maxConcurrencyPerIp);
  return {
    ...document,
    settings: { ...document.settings, concurrencyLimit: admin ? configured : effective },
    limits: { global: config.unlimitedModelRequests ? null : config.maxConcurrency, perAccount: config.unlimitedModelRequests ? null : config.maxConcurrencyPerIp, effective, ...(config.unlimitedModelRequests ? { unlimitedModels: true } : {}) },
  };
};

const handleChatProxy = async (req, res, config) => {
  assertMethod(req, 'POST');
  const { targetUrl, apiKey, payload, authHeader } = await readJson(req, config.jsonBodyLimit);
  if (!targetUrl || !apiKey || payload == null) {
    throw new HttpError(400, 'Missing targetUrl, apiKey, or payload.', 'missing_proxy_fields');
  }
  const upstream = await forwardJson(targetUrl, String(apiKey), payload, authHeader, config);
  copyUpstreamResponse(res, upstream);
};

const handleImagesProxy = async (req, res, config) => {
  assertMethod(req, 'POST');
  const { targetUrl, apiKey, payloadType, payload } = await readJson(req, config.jsonBodyLimit);
  if (!targetUrl || !apiKey || payload == null) {
    throw new HttpError(400, 'Missing targetUrl, apiKey, or payload.', 'missing_proxy_fields');
  }

  if (payloadType === 'form-data') {
    const form = serializeFormData(payload);
    if (form.body.length > config.uploadBodyLimit) {
      throw new HttpError(413, 'Serialized image request is too large.', 'request_too_large');
    }
    const upstream = await forwardRequest({
      targetUrl,
      patterns: config.upstreamHosts,
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': form.contentType,
      },
      body: form.body,
      timeoutMs: config.requestTimeoutMs,
      responseLimit: config.responseBodyLimit,
    });
    copyUpstreamResponse(res, upstream);
    return;
  }

  const upstream = await forwardJson(targetUrl, String(apiKey), payload, 'authorization', config);
  copyUpstreamResponse(res, upstream);
};

const handleMiniMaxProxy = async (req, res, config) => {
  assertMethod(req, 'POST');
  const { action, baseUrl, apiKey, taskId, payload } = await readJson(req, config.jsonBodyLimit);
  if (!apiKey || !['create', 'query'].includes(action)) {
    throw new HttpError(400, 'Missing MiniMax API key or invalid action.', 'invalid_minimax_request');
  }
  if (action === 'create' && payload == null) {
    throw new HttpError(400, 'Missing MiniMax create payload.', 'invalid_minimax_request');
  }
  let base;
  try {
    base = new URL(baseUrl || 'https://api.minimaxi.com');
  } catch {
    throw new HttpError(400, 'Invalid MiniMax base URL.', 'invalid_minimax_request');
  }
  if (base.protocol !== 'https:' || base.hostname !== 'api.minimaxi.com') {
    throw new HttpError(403, 'MiniMax proxy only allows https://api.minimaxi.com.', 'target_not_allowed');
  }
  if (action === 'query' && !taskId) {
    throw new HttpError(400, 'Missing MiniMax taskId.', 'invalid_minimax_request');
  }

  const targetUrl = action === 'create'
    ? 'https://api.minimaxi.com/v2/video_generation'
    : `https://api.minimaxi.com/v2/video_generation/${encodeURIComponent(String(taskId))}`;
  const upstream = action === 'create'
    ? await forwardJson(targetUrl, String(apiKey), payload, 'authorization', config)
    : await forwardRequest({
        targetUrl,
        patterns: config.upstreamHosts,
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}` },
        timeoutMs: config.requestTimeoutMs,
        responseLimit: config.responseBodyLimit,
      });
  copyUpstreamResponse(res, upstream);
};

const handleModelList = async (req, res, config) => {
  assertMethod(req, 'POST');
  const { baseUrl, apiKey, providerType = 'openai' } = await readJson(req, config.jsonBodyLimit);
  if (!apiKey) throw new HttpError(400, 'Missing apiKey.', 'missing_api_key');
  const targetUrl = normalizeModelListUrl(baseUrl, providerType);
  const upstream = await forwardRequest({
    targetUrl,
    patterns: config.upstreamHosts,
    method: 'GET',
    headers: providerType === 'gemini'
      ? { 'x-goog-api-key': String(apiKey) }
      : { authorization: `Bearer ${apiKey}` },
    timeoutMs: config.requestTimeoutMs,
    responseLimit: config.responseBodyLimit,
  });

  const contentType = String(upstream.headers['content-type'] || 'application/json');
  const text = upstream.body.toString('utf8');
  if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
    throw new HttpError(upstream.statusCode, `Model list request failed: HTTP ${upstream.statusCode}.`, 'model_list_error');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(502, `Model list response is not JSON (${contentType}).`, 'model_list_parse_error');
  }
  sendJson(res, 200, { models: extractModelIds(data), targetUrl });
};

const handleDownload = async (req, res, config, requestUrl, user) => {
  assertMethod(req, 'GET');
  const targetUrl = requestUrl.searchParams.get('url');
  if (!targetUrl) throw new HttpError(400, 'Missing url.', 'missing_download_url');
  const generatedDownload = config.generatedImageDownloads.allows(user.id, targetUrl);
  const patterns = generatedDownload ? [new URL(targetUrl).hostname] : config.downloadHosts;
  await validateTargetUrl(targetUrl, patterns);
  const upstream = await (config.downloadForwardRequest || forwardRequest)({
    targetUrl,
    patterns,
    generatedDownload,
    method: 'GET',
    timeoutMs: config.requestTimeoutMs,
    responseLimit: config.downloadResponseLimit,
    redirects: 3,
  });
  const contentType = String(upstream.headers['content-type'] || 'application/octet-stream');
  if (upstream.statusCode < 200 || upstream.statusCode >= 300 || !contentType.toLowerCase().startsWith('image/')) {
    throw new HttpError(upstream.statusCode >= 400 ? upstream.statusCode : 502, 'Image download failed.', 'image_download_error');
  }
  res.statusCode = upstream.statusCode;
  res.setHeader('content-type', contentType);
  res.setHeader('cache-control', 'private, max-age=300');
  res.end(upstream.body);
};

const handleUpload = async (req, res, config) => {
  assertMethod(req, 'POST');
  if (!config.uploadTarget) {
    throw new HttpError(503, 'UPLOAD_PROXY_TARGET is not configured.', 'upload_proxy_disabled');
  }
  const body = await readBody(req, config.uploadBodyLimit);
  const headers = {};
  if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
  if (req.headers.authorization) headers.authorization = String(req.headers.authorization);
  const upstream = await forwardRequest({
    targetUrl: config.uploadTarget,
    patterns: config.upstreamHosts,
    method: 'POST',
    headers,
    body,
    timeoutMs: config.requestTimeoutMs,
    responseLimit: config.responseBodyLimit,
  });
  copyUpstreamResponse(res, upstream);
};

const handleLogin = async (req, res, config, authStore) => {
  assertMethod(req, 'POST');
  const { username, password } = await readJson(req, config.jsonBodyLimit);
  const user = authStore.findUser(username);
  if (!user || !authStore.verifyPassword(password, user.passwordHash)) {
    throw new HttpError(401, 'Invalid username or password.', 'invalid_credentials');
  }

  const token = authStore.createSession(user);
  res.setHeader('set-cookie', buildSessionCookie(config, token, Math.floor(config.sessionTtlMs / 1000)));
  sendJson(res, 200, { user: authStore.publicUser(user) });
};

const handleRegister = async (req, res, config, authStore) => {
  assertMethod(req, 'POST');
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, '请使用 JSON 提交注册信息。', 'invalid_content_type');
  const payload = await readJson(req, 4096);
  const username = typeof payload?.username === 'string' ? payload.username.trim() : '';
  const password = payload?.password;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,31}$/.test(username)) throw new HttpError(400, '用户名需为 3–32 位字母、数字、下划线或短横线，并以字母或数字开头。', 'invalid_username');
  if (typeof password !== 'string' || password.length < 12 || password.length > 128 || !password.trim()) throw new HttpError(400, '密码需为 12–128 个字符，不能全部为空格。', 'invalid_password');
  const user = authStore.registerUser(username, password);
  const token = authStore.createSession(user);
  res.setHeader('set-cookie', buildSessionCookie(config, token, Math.floor(config.sessionTtlMs / 1000)));
  sendJson(res, 201, { user: authStore.publicUser(user) });
};

const handleLogout = async (req, res, config, authStore) => {
  assertMethod(req, 'POST');
  const token = parseCookies(req)[config.sessionCookieName];
  authStore.deleteSession(token);
  res.setHeader('set-cookie', buildSessionCookie(config, '', 0));
  sendJson(res, 200, { ok: true });
};

const handleMe = async (req, res, config, authStore) => {
  assertMethod(req, 'GET');
  const user = getRequestUser(req, config, authStore);
  if (!user) throw new HttpError(401, 'Login required.', 'login_required');
  sendJson(res, 200, { user: authStore.publicUser(user) });
};

const handleListProjects = async (req, res, user, authStore) => {
  assertMethod(req, 'GET');
  sendJson(res, 200, { projects: authStore.listProjects(user.id) });
};

const handleGetProject = async (req, res, user, authStore, projectId) => {
  assertMethod(req, 'GET');
  const project = authStore.getProject(user.id, projectId);
  if (!project) throw new HttpError(404, 'Project not found.', 'project_not_found');
  sendJson(res, 200, {
    project: {
      id: project.id,
      name: project.name,
      data: project.data,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    }
  });
};

const handleSaveProject = async (req, res, config, user, authStore, projectId) => {
  assertMethod(req, 'PUT');
  const { name, data } = await readJson(req, config.jsonBodyLimit);
  if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.connections)) {
    throw new HttpError(400, 'Invalid project data.', 'invalid_project_data');
  }
  const project = authStore.saveProject(user.id, projectId, name, data);
  sendJson(res, 200, {
    project: {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    }
  });
};

const routeRequest = async (req, res, config, limiter, authStore, wechatAuth, modelStore, gpuStore, upscaleService) => {
  const requestUrl = new URL(req.url || '/', 'http://api.internal');
  if (requestUrl.pathname === '/healthz') {
    assertMethod(req, 'GET');
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  if (!requestUrl.pathname.startsWith('/api/')) {
    throw new HttpError(404, 'Not found.', 'not_found');
  }
  if (['/api/choose-save-directory', '/api/save-generated-image'].includes(requestUrl.pathname)) {
    throw new HttpError(501, 'Desktop file-system APIs are disabled in the public deployment.', 'desktop_api_disabled');
  }

  if (requestUrl.pathname.startsWith('/api/auth/wechat/')) {
    if (requestUrl.pathname !== '/api/auth/wechat/callback') requireSameOrigin(req, config);
    await wechatAuth(req, res, requestUrl);
    return;
  }

  requireSameOrigin(req, config);

  if (requestUrl.pathname === '/api/auth/login') {
    limiter.checkRate('login:' + (req.socket.remoteAddress || 'unknown'), 'expensive');
    await handleLogin(req, res, config, authStore);
    return;
  }
  if (requestUrl.pathname === '/api/auth/register') {
    limiter.checkRate('register:' + (req.socket.remoteAddress || 'unknown'), 'expensive');
    await handleRegister(req, res, config, authStore);
    return;
  }
  if (requestUrl.pathname === '/api/auth/logout') {
    await handleLogout(req, res, config, authStore);
    return;
  }
  if (requestUrl.pathname === '/api/auth/me') {
    await handleMe(req, res, config, authStore);
    return;
  }

  const user = requireUser(req, config, authStore);

  if (requestUrl.pathname.startsWith('/api/upscale/')) {
    if (!upscaleService) throw new HttpError(503, '服务器图像处理服务尚未配置。', 'upscale_unavailable');
    const owner = createAccountUpscaleOwner(user.id, String(req.headers['x-upscale-client'] || ''));
    limiter.checkRate(user.id, 'general');
    if (requestUrl.pathname === '/api/upscale/jobs' && req.method === 'POST' || requestUrl.pathname === '/api/upscale/runtime/start' && req.method === 'POST') limiter.checkRate(user.id, 'expensive');
    const release = limiter.acquire(user.id, requestUrl.pathname === '/api/upscale/jobs' ? 'upload' : 'general', 'account');
    try { await upscaleService.middleware(req, res, owner); }
    finally { release(); }
    return;
  }

  if (requestUrl.pathname === '/api/model-settings') {
    assertMethod(req, 'GET');
    sendJson(res, 200, modelSettingsView(modelStore, config));
    return;
  }
  if (requestUrl.pathname === '/api/admin/model-settings') {
    if (authStore.publicUser(user).role !== 'admin') throw new HttpError(403, '仅管理员可修改模型设置。', 'admin_required');
    if (req.method === 'GET') sendJson(res, 200, modelSettingsView(modelStore, config, true));
    else {
      if (req.method !== 'POST') assertMethod(req, 'PUT');
      if (!String(req.headers['content-type']).startsWith('application/json')) throw new HttpError(415, '请使用 JSON 配置模型。', 'invalid_content_type');
      const input = await readJson(req, 1024 * 1024);
      modelStore.save(input.settings, input.revision);
      sendJson(res, 200, modelSettingsView(modelStore, config, true));
    }
    return;
  }
  if (requestUrl.pathname === '/api/admin/gpu-servers') {
    if (authStore.publicUser(user).role !== 'admin') throw new HttpError(403, '仅管理员可修改 GPU 服务设置。', 'admin_required');
    if (req.method === 'GET') sendJson(res, 200, gpuStore.view(true));
    else {
      if (req.method !== 'POST') assertMethod(req, 'PUT');
      if (!String(req.headers['content-type']).startsWith('application/json')) throw new HttpError(415, '请使用 JSON 配置 GPU 服务。', 'invalid_content_type');
      const input = await readJson(req, 1024 * 1024);
      sendJson(res, 200, gpuStore.save(input.settings, input.revision));
    }
    return;
  }
  if (requestUrl.pathname === '/api/admin/gpu-servers/activate') {
    assertMethod(req, 'POST');
    if (authStore.publicUser(user).role !== 'admin') throw new HttpError(403, '仅管理员可切换 GPU 服务。', 'admin_required');
    if (!String(req.headers['content-type']).startsWith('application/json')) throw new HttpError(415, '请使用 JSON 指定 GPU 服务。', 'invalid_content_type');
    const input = await readJson(req, 64 * 1024);
    sendJson(res, 200, gpuStore.activate(input.id, input.revision));
    return;
  }
  if (requestUrl.pathname === '/api/model-request') {
    assertMethod(req, 'POST');
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, '请使用 JSON 请求模型。', 'invalid_content_type');
    if (!config.unlimitedModelRequests) limiter.checkRate(user.id, 'general');
    const release = config.unlimitedModelRequests ? () => {} : limiter.acquire(user.id, 'general', 'account');
    const lifetime = createProxyRequestLifetime(req, res, config.requestTimeoutMs);
    try {
      const input = await lifetime.run(() => readJson(req, config.jsonBodyLimit));
      const resolved = resolveModelRequest(modelStore, input);
      if (!config.unlimitedModelRequests && resolved.method !== 'GET') limiter.checkRate(user.id, 'expensive');
      const serialized = resolved.method === 'GET' ? null : resolved.payloadType === 'form-data' ? serializeFormData(resolved.payload) : { body: Buffer.from(JSON.stringify(resolved.payload)), contentType: 'application/json' };
      const upstream = await lifetime.run(() => (config.modelForwardRequest || forwardRequest)({ targetUrl: resolved.targetUrl, patterns: [new URL(resolved.provider.baseUrl).hostname], method: resolved.method, headers: { ...resolved.headers, ...(serialized ? { 'content-type': serialized.contentType } : {}) }, body: serialized?.body, timeoutMs: config.requestTimeoutMs, responseLimit: config.responseBodyLimit, signal: lifetime.signal }));
      const secret = resolved.provider.apiKey.replace(/^Bearer\s+/i, '');
      const contentType = String(upstream.headers['content-type'] || '');
      if (upstream.statusCode >= 300) throw new HttpError(upstream.statusCode >= 400 && upstream.statusCode < 600 ? upstream.statusCode : 502, '模型服务请求失败，请联系管理员检查密钥、余额或接口配置。', 'model_upstream_error');
      if (/(json|text|event-stream)/i.test(contentType) && secret) upstream.body = Buffer.from(upstream.body.toString('utf8').split(secret).join('[REDACTED]'));
      if (modelStore.view().settings.imageProviders.some(provider => provider.id === resolved.provider.id)) {
        config.generatedImageDownloads.remember(user.id, upstream.body, contentType);
      }
      copyUpstreamResponse(res, upstream);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, '无法连接后台配置的模型服务，请联系管理员。', 'model_upstream_error');
    } finally { lifetime.dispose(); release(); }
    return;
  }
  if (config.managedModels && ['/api/openai-chat-proxy', '/api/gemini-image-proxy', '/api/openai-images-proxy', '/api/minimax-video-proxy', '/api/model-list-proxy'].includes(requestUrl.pathname)) throw new HttpError(403, '模型设置已由后台统一管理，请刷新画布后重试。', 'managed_models_required');

  if (requestUrl.pathname === '/api/admin/overview') {
    assertMethod(req, 'GET');
    if (authStore.publicUser(user).role !== 'admin') throw new HttpError(403, '仅管理员可进入管理后台。', 'admin_required');
    sendJson(res, 200, { administrator: authStore.publicUser(user), users: authStore.listUsers(), wechat: wechatConfiguration(config), sessionKeyConfigured: true });
    return;
  }

  const ip = getClientIp(req);
  const isDownload = requestUrl.pathname === '/api/openai-download-proxy';
  const isUpload = requestUrl.pathname === '/api/upload';
  limiter.checkRate(ip, 'general');
  limiter.checkRate(ip, isDownload ? 'download' : 'expensive');
  const release = limiter.acquire(ip, isUpload ? 'upload' : 'general');
  try {
    const projectMatch = requestUrl.pathname.match(/^\/api\/projects\/([a-z0-9_-]+)$/i);
    if (requestUrl.pathname === '/api/projects') {
      await handleListProjects(req, res, user, authStore);
      return;
    }
    if (projectMatch && req.method === 'GET') {
      await handleGetProject(req, res, user, authStore, projectMatch[1]);
      return;
    }
    if (projectMatch && req.method === 'PUT') {
      await handleSaveProject(req, res, config, user, authStore, projectMatch[1]);
      return;
    }

    switch (requestUrl.pathname) {
      case '/api/openai-chat-proxy':
      case '/api/gemini-image-proxy':
        await handleChatProxy(req, res, config);
        break;
      case '/api/openai-images-proxy':
        await handleImagesProxy(req, res, config);
        break;
      case '/api/minimax-video-proxy':
        await handleMiniMaxProxy(req, res, config);
        break;
      case '/api/model-list-proxy':
        await handleModelList(req, res, config);
        break;
      case '/api/openai-download-proxy':
        await handleDownload(req, res, config, requestUrl, user);
        break;
      case '/api/upload':
        await handleUpload(req, res, config);
        break;
      default:
        throw new HttpError(404, 'Not found.', 'not_found');
    }
  } finally {
    release();
  }
};

const createApiRuntime = (overrides = {}) => {
  const config = { ...loadConfig(), ...overrides };
  config.generatedImageDownloads = createGeneratedImageDownloads();
  config.sessionCookiePath = normalizeCookiePath(config.sessionCookiePath);
  config.publicBasePath = normalizePublicBasePath(config.publicBasePath);
  const limiter = createLimiter(config);
  const authStore = createAuthStore(config);
  const modelStore = createModelSettingsStore(config.dataDir);
  const gpuStore = createGpuServerSettingsStore(config.dataDir, {
    ...(config.upscaleInstallRoot ? { defaultServer: { ...DEFAULT_GPU_SERVER, installRoot: config.upscaleInstallRoot } } : {}),
  });
  const upscaleService = config.upscaleService || (config.enableUpscaleApi === false ? null : createUpscaleService({
    gpuStore,
    dataDir: path.join(config.dataDir, 'upscale-jobs'),
    ...(config.upscaleInstallRoot ? { installRoot: config.upscaleInstallRoot } : {}),
    ...(config.upscaleImagePython ? { imagePython: config.upscaleImagePython } : {}),
    ...(config.upscaleComfyPython ? { comfyPython: config.upscaleComfyPython } : {}),
  }));
  const wechatAuth = createWechatAuth(config, authStore, { sendJson, buildSessionCookie, parseCookies });
  const handler = async (req, res) => {
    const startedAt = Date.now();
    const requestId = randomUUID();
    let errorDetails;
    let errorStatus;
    const pathname = new URL(req.url || '/', 'http://api.internal').pathname;
    setSecurityHeaders(res);
    res.setHeader('x-request-id', requestId);

    try {
      await routeRequest(req, res, config, limiter, authStore, wechatAuth, modelStore, gpuStore, upscaleService);
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 502;
      errorStatus = statusCode;
      const type = error instanceof HttpError ? error.type : 'proxy_error';
      const message = error instanceof Error ? error.message : 'Unexpected proxy error.';
      errorDetails = { errorType: type, ...(error.limitScope ? { limitScope: error.limitScope, activeRequests: error.activeRequests, ownerActiveRequests: error.ownerActiveRequests } : {}) };
      sendJson(res, statusCode, { error: { message, type, requestId } }, error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {});
    } finally {
      const statusCode = errorStatus || res.statusCode || 500;
      console.info(JSON.stringify({
        level: statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info',
        requestId,
        method: req.method,
        path: pathname,
        statusCode,
        durationMs: Date.now() - startedAt,
        clientIp: getClientIp(req),
        ...errorDetails,
      }));
    }
  };
  const middleware = (req, res, next) => {
    const pathname = new URL(req.url || '/', 'http://api.internal').pathname;
    if ((pathname === '/admin' || pathname === '/admin/') && req.method === 'GET') return serveAdminConsole(res, config.publicBasePath);
    if ((pathname === '/admin/models' || pathname === '/admin/models/') && req.method === 'GET') return serveModelConsole(res, config.publicBasePath);
    if ((pathname === '/admin/gpu' || pathname === '/admin/gpu/') && req.method === 'GET') return serveGpuConsole(res, config.publicBasePath);
    if (['/api/model-settings', '/api/model-request', '/api/openai-download-proxy'].includes(pathname) || (config.managedModels && ['/api/openai-chat-proxy', '/api/gemini-image-proxy', '/api/openai-images-proxy', '/api/minimax-video-proxy', '/api/model-list-proxy'].includes(pathname))) return void handler(req, res);
    if (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/admin/')) return void handler(req, res);
    if (!pathname.startsWith('/api/')) return next();
    try {
      requireSameOrigin(req, config);
      requireUser(req, config, authStore);
      next();
    } catch (error) {
      setSecurityHeaders(res);
      sendJson(res, error.statusCode || 401, { error: { type: error.type || 'login_required', message: error.statusCode === 403 ? error.message : '请先注册并登录后使用画布。' } });
    }
  };
  return { handler, middleware, publicBasePath: config.publicBasePath, upscaleService };
};

export const createApiHandler = (overrides = {}) => createApiRuntime(overrides).handler;
export const createCanvasAccessMiddleware = (overrides = {}) => {
  const runtime = createApiRuntime({ ...overrides, enableUpscaleApi: false });
  runtime.middleware.dispose = () => runtime.upscaleService?.dispose();
  return runtime.middleware;
};
export const createApiServer = (overrides = {}) => {
  const runtime = createApiRuntime(overrides);
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://api.internal').pathname;
    if ((pathname === '/admin' || pathname === '/admin/') && req.method === 'GET') return serveAdminConsole(res, runtime.publicBasePath);
    if ((pathname === '/admin/models' || pathname === '/admin/models/') && req.method === 'GET') return serveModelConsole(res, runtime.publicBasePath);
    if ((pathname === '/admin/gpu' || pathname === '/admin/gpu/') && req.method === 'GET') return serveGpuConsole(res, runtime.publicBasePath);
    return runtime.handler(req, res);
  });
  server.once('close', () => runtime.upscaleService?.dispose());
  return server;
};

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  const config = loadConfig();
  const server = createApiServer(config);
  server.listen(config.port, config.host, () => {
    console.info(JSON.stringify({
      level: 'info',
      message: 'X-tapnow API proxy listening',
      host: config.host,
      port: config.port,
      upstreamHostCount: config.upstreamHosts.length,
      downloadHostCount: config.downloadHosts.length,
      uploadEnabled: Boolean(config.uploadTarget),
    }));
  });
}
