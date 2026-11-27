import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApiServer, loadConfig } from './api-server.mjs';
import { loadSessionSecret } from './auth-secrets.mjs';

const fixture = async (context, overrides = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resonantor-auth-test-'));
    const upstreamCalls = [];
    let clock = Date.now();
    const config = {
        ...loadConfig({}), dataDir: root, adminPassword: '', publicOrigins: [],
        wechatAppId: 'wx_test_application', wechatAppSecret: 'test-private-wechat-secret',
        wechatRedirectUri: 'https://canvas.example/api/auth/wechat/callback',
        wechatNow: () => clock,
        wechatFetch: async (url, options) => {
            upstreamCalls.push({ url: String(url), options });
            return new Response(JSON.stringify({ access_token: 'private-upstream-token', openid: 'test-openid', unionid: 'test-unionid', scope: 'snsapi_login' }), { status: 200 });
        }, ...overrides,
    };
    const servers = [];
    const start = async () => {
        const server = createApiServer(config);
        servers.push(server);
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        return { server, base: 'http://127.0.0.1:' + server.address().port };
    };
    const running = await start();
    context.after(async () => {
        for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('resonantor-auth-test-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { ...running, root, config, upstreamCalls, start, advance: milliseconds => { clock += milliseconds; } };
};

const call = async (fixture, endpoint, method = 'GET', cookie = '', headers = {}) => {
    const response = await fetch(fixture.base + '/api/auth/' + endpoint, {
        method, headers: { ...(method === 'POST' ? { origin: fixture.base, 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
        ...(method === 'POST' ? { body: '{}' } : {}),
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch {}
    return { status: response.status, cookie: response.headers.get('set-cookie'), text, data };
};
const begin = async setup => {
    const result = await call(setup, 'wechat/attempts', 'POST');
    assert.equal(result.status, 201);
    return { ...result.data, cookie: result.cookie.split(';')[0], state: new URL(result.data.authorizationUrl).searchParams.get('state') };
};
const approve = (setup, attempt) => call(setup, 'wechat/callback?code=test-code&state=' + attempt.state);
const complete = (setup, attempt) => call(setup, 'wechat/attempts/' + attempt.id + '/complete', 'POST', attempt.cookie);


test('wrong scope and malformed upstream identities cannot create an account', async context => {
    for (const invalid of [
        { access_token: 'token', openid: 'valid-id', scope: 'snsapi_base' },
        { access_token: 'token', openid: 12345, scope: 'snsapi_login' },
        { access_token: true, openid: 'valid-id', scope: 'snsapi_login' },
    ]) {
        const setup = await fixture(context, { wechatFetch: async () => new Response(JSON.stringify(invalid)) });
        const attempt = await begin(setup);
        assert.equal((await approve(setup, attempt)).status, 400);
        assert.equal((await complete(setup, attempt)).status, 409);
        assert.equal(fs.existsSync(path.join(setup.root, 'users.json')), false);
    }
});

test('cancelling while WeChat verification is pending prevents late registration', async context => {
    let resolveProvider;
    let reportStarted;
    const started = new Promise(resolve => { reportStarted = resolve; });
    const provider = new Promise(resolve => { resolveProvider = resolve; });
    const setup = await fixture(context, { wechatFetch: async () => { reportStarted(); return provider; } });
    const attempt = await begin(setup);
    const callback = approve(setup, attempt);
    await started;
    assert.equal((await call(setup, 'wechat/attempts/' + attempt.id + '/cancel', 'POST', attempt.cookie)).status, 200);
    resolveProvider(new Response(JSON.stringify({ access_token: 'token', openid: 'valid-id', scope: 'snsapi_login' })));
    assert.equal((await callback).status, 400);
    assert.equal((await complete(setup, attempt)).status, 410);
    assert.equal(fs.existsSync(path.join(setup.root, 'users.json')), false);
});

test('registration never overwrites corrupt existing user data', async context => {
    const setup = await fixture(context);
    const filename = path.join(setup.root, 'users.json');
    fs.writeFileSync(filename, 'invalid-original-data');
    const attempt = await begin(setup);
    await approve(setup, attempt);
    assert.equal((await complete(setup, attempt)).status, 500);
    assert.equal(fs.readFileSync(filename, 'utf8'), 'invalid-original-data');
});

test('unconfigured WeChat shows readiness without exposing secrets or minting fake users', async context => {
    const setup = await fixture(context, { wechatAppSecret: '' });
    const result = await call(setup, 'wechat/config');
    assert.equal(result.data.ready, false);
    assert.equal((await call(setup, 'wechat/attempts', 'POST')).status, 503);
    assert.equal(fs.existsSync(path.join(setup.root, 'users.json')), false);
    assert.equal(setup.upstreamCalls.length, 0);
    assert.equal(loadConfig({}).adminPassword, '');
});

test('first verified WeChat authorization registers a persistent UUID and a private session', async context => {
    const setup = await fixture(context);
    const attempt = await begin(setup);
    const authorization = new URL(attempt.authorizationUrl);
    assert.equal(authorization.origin, 'https://open.weixin.qq.com');
    assert.equal(authorization.searchParams.get('login_type'), 'jssdk');
    assert.equal(authorization.searchParams.get('self_redirect'), 'true');
    assert.equal(authorization.searchParams.get('scope'), 'snsapi_login');
    assert.equal((await complete(setup, attempt)).status, 409);
    assert.equal((await approve(setup, attempt)).status, 200);
    assert.equal(fs.existsSync(path.join(setup.root, 'users.json')), false);
    assert.equal((await call(setup, 'wechat/attempts/' + attempt.id, 'GET', attempt.cookie)).data.status, 'ready');
    const registered = await complete(setup, attempt);
    assert.equal(registered.status, 200);
    assert.equal(registered.data.user.id, registered.data.user.username);
    assert.match(registered.cookie, /HttpOnly/);
    assert.match(registered.cookie, /SameSite=Lax/);
    assert.match(registered.cookie, /Secure/);
    assert.equal((await call(setup, 'me', 'GET', registered.cookie.split(';')[0])).data.user.id, registered.data.user.id);
    for (const secret of ['test-private-wechat-secret', 'test-openid', 'test-unionid', 'private-upstream-token', 'passwordHash']) assert.ok(!registered.text.includes(secret));
    const sessions = fs.readFileSync(path.join(setup.root, 'sessions.json'), 'utf8');
    assert.ok(!sessions.includes(registered.cookie.split(';')[0].split('=')[1]));
    assert.ok(!fs.readFileSync(path.join(setup.root, 'users.json'), 'utf8').includes('private-upstream-token'));
    const upstream = new URL(setup.upstreamCalls[0].url);
    assert.equal(upstream.origin, 'https://api.weixin.qq.com');
    assert.equal(upstream.pathname, '/sns/oauth2/access_token');
    assert.equal(upstream.searchParams.get('secret'), setup.config.wechatAppSecret);
    assert.equal(setup.upstreamCalls[0].options.redirect, 'error');
});

test('repeat WeChat authorization reuses the user ID, including after server restart', async context => {
    const setup = await fixture(context);
    const first = await begin(setup);
    await approve(setup, first);
    const original = await complete(setup, first);
    const oldKey = fs.readFileSync(path.join(setup.root, 'session.key'), 'utf8');
    setup.server.closeAllConnections();
    await new Promise(resolve => setup.server.close(resolve));
    const restarted = { ...setup, ...await setup.start() };
    assert.equal((await call(restarted, 'me', 'GET', original.cookie.split(';')[0])).data.user.id, original.data.user.id);
    const second = await begin(restarted);
    await approve(restarted, second);
    assert.equal((await complete(restarted, second)).data.user.id, original.data.user.id);
    assert.equal(JSON.parse(fs.readFileSync(path.join(setup.root, 'users.json'), 'utf8')).length, 1);
    assert.equal(fs.readFileSync(path.join(setup.root, 'session.key'), 'utf8'), oldKey);
});

test('state, browser ownership, expiry and one-time completion are enforced', async context => {
    const setup = await fixture(context);
    const attempt = await begin(setup);
    assert.equal((await call(setup, 'wechat/callback?code=x&state=' + '0'.repeat(64))).status, 400);
    assert.equal((await call(setup, 'wechat/attempts/' + attempt.id)).status, 403);
    assert.equal((await call(setup, 'wechat/attempts/' + attempt.id + '/complete', 'POST', 'canvas_session_wechat=' + '0'.repeat(64))).status, 403);
    await approve(setup, attempt);
    assert.equal((await approve(setup, attempt)).status, 400);
    await complete(setup, attempt);
    assert.equal((await complete(setup, attempt)).status, 410);
    assert.equal(setup.upstreamCalls.length, 1);
    const expired = await begin(setup);
    setup.advance(300001);
    assert.equal((await call(setup, 'wechat/attempts/' + expired.id, 'GET', expired.cookie)).status, 410);
    assert.equal((await approve(setup, expired)).status, 400);
});

test('cross-origin requests, missing origin and non-JSON mutations cannot create scans', async context => {
    const setup = await fixture(context);
    assert.equal((await call(setup, 'wechat/attempts', 'POST', '', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await call(setup, 'wechat/attempts', 'POST', '', { origin: '' })).status, 403);
    assert.equal((await call(setup, 'wechat/attempts', 'POST', '', { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await call(setup, 'wechat/attempts')).status, 405);
});

test('provider failures are redacted and do not register users', async context => {
    const setup = await fixture(context, { wechatFetch: async () => { throw new Error('private-secret-in-upstream-error'); } });
    const attempt = await begin(setup);
    const callback = await approve(setup, attempt);
    assert.equal(callback.status, 400);
    assert.ok(!callback.text.includes('private-secret'));
    assert.equal((await call(setup, 'wechat/attempts/' + attempt.id, 'GET', attempt.cookie)).data.status, 'error');
    assert.equal((await complete(setup, attempt)).status, 409);
    assert.equal(fs.existsSync(path.join(setup.root, 'users.json')), false);
});

test('cancelling a scan invalidates its callback and respects ownership', async context => {
    const setup = await fixture(context);
    const attempt = await begin(setup);
    assert.equal((await call(setup, 'wechat/attempts/' + attempt.id + '/cancel', 'POST')).status, 403);
    assert.equal((await call(setup, 'wechat/attempts/' + attempt.id + '/cancel', 'POST', attempt.cookie)).status, 200);
    assert.equal((await approve(setup, attempt)).status, 400);
    assert.equal(setup.upstreamCalls.length, 0);
});

test('scan creation is rate-limited and insecure callback configuration is rejected', async context => {
    const setup = await fixture(context);
    for (let index = 0; index < 10; index += 1) await begin(setup);
    assert.equal((await call(setup, 'wechat/attempts', 'POST')).status, 429);
    const insecure = await fixture(context, { wechatRedirectUri: 'http://192.168.0.228:3004/api/auth/wechat/callback' });
    assert.equal((await call(insecure, 'wechat/config')).data.ready, false);
    assert.equal((await call(insecure, 'wechat/attempts', 'POST')).status, 503);
});

test('signed sessions reject tampering and logout invalidates the session', async context => {
    const setup = await fixture(context);
    const attempt = await begin(setup);
    await approve(setup, attempt);
    const result = await complete(setup, attempt);
    const session = result.cookie.split(';')[0];
    assert.equal((await call(setup, 'me', 'GET', session + 'tampered')).status, 401);
    assert.equal((await call(setup, 'logout', 'POST', session)).status, 200);
    assert.equal((await call(setup, 'me', 'GET', session)).status, 401);
});

test('session key persists privately and a corrupt key is never silently replaced', async context => {
    const setup = await fixture(context);
    const original = loadSessionSecret(setup.config);
    assert.match(original, /^[0-9a-f]{64}$/);
    assert.equal(loadSessionSecret(setup.config), original);
    fs.writeFileSync(path.join(setup.root, 'session.key'), 'corrupted');
    assert.throws(() => loadSessionSecret(setup.config), /invalid/);
    assert.equal(fs.readFileSync(path.join(setup.root, 'session.key'), 'utf8'), 'corrupted');
    assert.throws(() => loadSessionSecret({ sessionSecret: 'short' }), /at least 32/);
});
