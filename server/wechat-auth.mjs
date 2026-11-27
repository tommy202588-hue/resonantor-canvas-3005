import { randomBytes, createHash } from 'node:crypto';
import { HttpError } from './security.mjs';

const TTL = 5 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
const error = (status, message, type) => new HttpError(status, message, type);
const identityPattern = /^[A-Za-z0-9_-]{1,128}$/;

export function wechatConfiguration(config) {
    const missing = ['wechatAppId', 'wechatAppSecret', 'wechatRedirectUri'].filter(name => !config[name]);
    let validCallback = false;
    try {
        const callback = new URL(config.wechatRedirectUri);
        validCallback = callback.protocol === 'https:' && !callback.username && !callback.password && !callback.search && !callback.hash && callback.pathname.endsWith('/api/auth/wechat/callback');
    } catch {}
    const ready = !missing.length && validCallback;
    return { ready, message: ready ? '使用微信扫描二维码，首次授权将自动注册账号。' : '微信扫码注册尚未启用，请管理员配置微信开放平台网站应用的 AppID、AppSecret 和 HTTPS 授权回调地址。' };
}

export function createWechatAuth(config, store, helpers) {
    const attempts = new Map();
    const limits = new Map();
    const now = config.wechatNow || Date.now;
    const fetchWechat = config.wechatFetch || fetch;
    const ownerCookie = config.sessionCookieName + '_wechat';
    const cookie = (owner, seconds) => [ownerCookie + '=' + owner, 'HttpOnly', 'SameSite=Lax', ...(config.secureCookies ? ['Secure'] : []), 'Path=' + config.sessionCookiePath, 'Max-Age=' + seconds].join('; ');
    const prune = () => {
        for (const [id, attempt] of attempts) if (attempt.expiresAt <= now()) attempts.delete(id);
        for (const [ip, limit] of limits) if (limit.until <= now()) limits.delete(ip);
    };
    const requireOwner = (request, id) => {
        const attempt = attempts.get(id);
        if (!attempt || attempt.expiresAt <= now()) throw error(410, '二维码已过期，请重新获取。', 'wechat_expired');
        const owner = helpers.parseCookies(request)[ownerCookie];
        if (!owner || hash(owner) !== attempt.ownerHash) throw error(403, '请在发起扫码的浏览器中完成登录。', 'wechat_owner_mismatch');
        return attempt;
    };
    const requireMutation = request => {
        if (request.method !== 'POST') throw error(405, 'Method not allowed.', 'method_not_allowed');
        if (!request.headers.origin) throw error(403, '缺少请求来源。', 'missing_origin');
        if (!request.headers['content-type']?.startsWith('application/json')) throw error(415, '请使用 JSON 请求。', 'invalid_content_type');
    };
    const callbackPage = (response, success) => {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.setHeader('cache-control', 'no-store');
        response.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
        response.statusCode = success ? 200 : 400;
        response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>微信授权</title><body style="background:#111a2b;color:#def7ee;font:16px sans-serif;text-align:center;padding:48px 20px"><h2>' + (success ? '微信授权成功' : '微信授权未完成') + '</h2><p>' + (success ? '请返回原页面，正在完成账号登录。' : '请返回原页面重新获取二维码。') + '</p></body></html>');
    };
    return async (request, response, url) => {
        const route = url.pathname.slice('/api/auth/wechat/'.length);
        if (route === 'config' && request.method === 'GET') {
            helpers.sendJson(response, 200, { ...wechatConfiguration(config), secureCookies: config.secureCookies });
            return;
        }
        if (!wechatConfiguration(config).ready) throw error(503, wechatConfiguration(config).message, 'wechat_not_configured');
        if (route === 'attempts') {
            requireMutation(request);
            prune();
            const ip = request.socket.remoteAddress || 'unknown';
            const limit = limits.get(ip) || { count: 0, until: now() + 60_000 };
            if (limit.count >= 10 || attempts.size >= 1000 || limits.size >= 5000) throw error(429, '二维码请求过于频繁，请稍后再试。', 'wechat_rate_limited');
            limit.count += 1;
            limits.set(ip, limit);
            const existingOwner = helpers.parseCookies(request)[ownerCookie];
            const owner = /^[0-9a-f]{64}$/.test(existingOwner || '') ? existingOwner : randomBytes(32).toString('hex');
            for (const [id, attempt] of attempts) if (attempt.ownerHash === hash(owner)) attempts.delete(id);
            const id = randomBytes(16).toString('hex');
            const state = randomBytes(32).toString('hex');
            const attempt = { id, state, ownerHash: hash(owner), expiresAt: now() + TTL, status: 'waiting', identity: null };
            attempts.set(id, attempt);
            const authorize = new URL('https://open.weixin.qq.com/connect/qrconnect');
            authorize.search = new URLSearchParams({ appid: config.wechatAppId, redirect_uri: config.wechatRedirectUri, response_type: 'code', scope: 'snsapi_login', state, login_type: 'jssdk', self_redirect: 'true', color_scheme: 'light' }).toString();
            authorize.hash = 'wechat_redirect';
            response.setHeader('set-cookie', cookie(owner, TTL / 1000));
            helpers.sendJson(response, 201, { id, authorizationUrl: authorize.href, expiresAt: attempt.expiresAt });
            return;
        }
        if (route === 'callback') {
            if (request.method !== 'GET') throw error(405, 'Method not allowed.', 'method_not_allowed');
            prune();
            const state = url.searchParams.get('state');
            if (!/^[0-9a-f]{64}$/.test(state || '')) throw error(400, '无效的微信授权状态。', 'wechat_invalid_state');
            const attempt = [...attempts.values()].find(entry => entry.state === state);
            if (!attempt || attempt.status !== 'waiting') throw error(400, '微信授权已过期或已使用，请重新扫码。', 'wechat_invalid_state');
            attempt.status = 'processing';
            try {
                const code = url.searchParams.get('code');
                if (!code || code.length > 512) throw new Error('Missing authorization code');
                const tokenUrl = new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
                tokenUrl.search = new URLSearchParams({ appid: config.wechatAppId, secret: config.wechatAppSecret, code, grant_type: 'authorization_code' }).toString();
                const upstream = await fetchWechat(tokenUrl, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
                const token = await upstream.json();
                if (!upstream.ok || token.errcode || typeof token.access_token !== 'string' || !token.access_token || typeof token.openid !== 'string' || !identityPattern.test(token.openid) || typeof token.scope !== 'string' || !token.scope.split(',').includes('snsapi_login')) throw new Error('Wechat authorization rejected');
                if (!attempts.has(attempt.id) || attempt.expiresAt <= now()) throw new Error('Expired authorization');
                attempt.identity = { openId: token.openid, ...(typeof token.unionid === 'string' && identityPattern.test(token.unionid) ? { unionId: token.unionid } : {}) };
                attempt.status = 'ready';
                callbackPage(response, true);
            } catch {
                attempt.status = 'error';
                callbackPage(response, false);
            }
            return;
        }
        const parts = route.split('/');
        if (parts[0] !== 'attempts' || !/^[0-9a-f]{32}$/.test(parts[1] || '') || parts.length > 3) throw error(404, '微信登录接口不存在。', 'not_found');
        const attempt = requireOwner(request, parts[1]);
        if (parts.length === 2 && request.method === 'GET') {
            helpers.sendJson(response, 200, { status: attempt.status, expiresAt: attempt.expiresAt });
            return;
        }
        requireMutation(request);
        if (parts[2] === 'cancel') {
            attempts.delete(attempt.id);
            helpers.sendJson(response, 200, { cancelled: true });
            return;
        }
        if (parts[2] !== 'complete') throw error(404, '微信登录接口不存在。', 'not_found');
        if (attempt.status !== 'ready' || !attempt.identity) throw error(409, '请先在微信中确认授权。', 'wechat_not_ready');
        attempt.status = 'completing';
        try {
            const user = store.upsertWechatUser(attempt.identity);
            const token = store.createSession(user);
            attempts.delete(attempt.id);
            response.setHeader('set-cookie', helpers.buildSessionCookie(config, token, Math.floor(config.sessionTtlMs / 1000)));
            helpers.sendJson(response, 200, { user: store.publicUser(user) });
        } catch {
            attempt.status = 'error';
            throw error(500, '账号保存失败，请联系管理员检查存储空间。', 'wechat_registration_failed');
        }
    };
}
