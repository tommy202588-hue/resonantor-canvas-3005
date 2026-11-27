import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createCanvasAccessMiddleware, loadConfig, hashPassword } from './api-server.mjs';
import { provisionLocalAdministrator } from './admin-bootstrap.mjs';
import { replacePrivateFile } from './private-file.mjs';

async function fixture(context, overrides = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-login-gate-'));
    const config = { ...loadConfig({}), dataDir: root, adminUser: 'admin', adminPassword: 'TestAdminStrongPassword!', secureCookies: false, ...overrides };
    provisionLocalAdministrator(config);
    const usersFile = path.join(root, 'users.json');
    const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    users.push({ id: 'normal-test-user', username: 'member', displayName: '<script>untrusted name</script>', passwordHash: hashPassword('MemberStrongPassword!'), role: 'user', createdAt: Date.now() });
    fs.writeFileSync(usersFile, JSON.stringify(users));
    const middleware = createCanvasAccessMiddleware(config);
    const reached = [];
    const server = http.createServer((request, response) => middleware(request, response, () => {
        reached.push(request.url);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ reached: true }));
    }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    context.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('canvas-login-gate-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, config, base, reached };
}

async function request(setup, endpoint, { method = 'GET', cookie = '', payload, headers = {} } = {}) {
    const response = await fetch(setup.base + endpoint, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin: setup.base, 'content-type': 'application/json' } : {}), ...headers }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch {}
    return { status: response.status, data, text, cookie: response.headers.get('set-cookie') };
}
const login = (setup, username = 'admin', password = 'TestAdminStrongPassword!') => request(setup, '/api/auth/login', { method: 'POST', payload: { username, password } });

test('desktop companion downloads require login and are available to ordinary users', async context => {
    const setup = await fixture(context);
    const endpoint = '/api/desktop-companion/download';
    assert.equal((await request(setup, endpoint)).status, 401);
    assert.equal(setup.reached.length, 0);
    const authenticated = await login(setup, 'member', 'MemberStrongPassword!');
    assert.equal((await request(setup, endpoint, { cookie: authenticated.cookie })).status, 200);
    assert.deepEqual(setup.reached, [endpoint]);
});

test('registration creates a persistent ordinary user and signed session without accepting elevated fields', async context => {
    const setup = await fixture(context);
    const payload = { username: ' new_member ', password: 'NewMemberStrongPassword!', role: 'admin', id: 'admin' };
    const result = await request(setup, '/api/auth/register', { method: 'POST', payload });
    assert.equal(result.status, 201);
    assert.equal(result.data.user.role, 'user');
    assert.equal(result.data.user.username, 'new_member');
    assert.equal(result.data.user.id, 'new_member');
    assert.match(result.cookie, /HttpOnly/);
    assert.match(result.cookie, /SameSite=Lax/);
    assert.ok(!result.text.includes(payload.password));
    assert.ok(!result.text.includes('passwordHash'));
    const cookie = result.cookie.split(';')[0];
    assert.equal((await request(setup, '/api/canvas-projects', { cookie })).status, 200);
    assert.equal((await request(setup, '/api/admin/overview', { cookie })).status, 403);
    const users = JSON.parse(fs.readFileSync(path.join(setup.root, 'users.json'), 'utf8'));
    assert.equal(users.length, 3);
    const storedUser = users.find(user => user.username === result.data.user.username);
    assert.ok(storedUser.passwordHash);
    assert.match(storedUser.id, /^[0-9a-f-]{36}$/);
    assert.ok(!result.text.includes(storedUser.id));
    assert.ok(!JSON.stringify(users).includes(payload.password));
    await request(setup, '/api/auth/logout', { method: 'POST', cookie });
    assert.equal((await request(setup, '/api/canvas-projects', { cookie })).status, 401);
    const loggedIn = await login(setup, 'NEW_MEMBER', payload.password);
    assert.equal(loggedIn.status, 200);
    assert.equal(loggedIn.data.user.id, result.data.user.id);
});

test('registration rejects duplicate names and invalid credentials without altering users', async context => {
    const setup = await fixture(context);
    for (const username of ['ADMIN', 'Member']) {
        assert.equal((await request(setup, '/api/auth/register', { method: 'POST', payload: { username, password: 'StrongPasswordForTest!' } })).status, 409);
    }
    for (const payload of [null, {}, { username: 'ab', password: 'StrongPasswordForTest!' }, { username: '../bad', password: 'StrongPasswordForTest!' }, { username: 'valid', password: 'short' }, { username: 'valid', password: ' ' .repeat(12) }, { username: 'valid', password: 'x'.repeat(129) }, { username: 'valid', password: {} }]) {
        assert.equal((await request(setup, '/api/auth/register', { method: 'POST', payload })).status, 400);
    }
    assert.equal((await request(setup, '/api/auth/register')).status, 405);
    assert.equal((await request(setup, '/api/auth/register', { method: 'POST', payload: {}, headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await request(setup, '/api/auth/register', { method: 'POST', payload: { username: 'x'.repeat(5000) } })).status, 413);
    assert.equal(JSON.parse(fs.readFileSync(path.join(setup.root, 'users.json'), 'utf8')).length, 2);
});

test('registration keeps origin protection and rate limits', async context => {
    const setup = await fixture(context, { expensiveRateMax: 2 });
    const payload = { username: 'new_member', password: 'StrongPasswordForTest!' };
    assert.equal((await request(setup, '/api/auth/register', { method: 'POST', payload, headers: { origin: 'http://evil.example' } })).status, 403);
    for (let attempt = 0; attempt < 2; attempt += 1) assert.equal((await request(setup, '/api/auth/register', { method: 'POST', payload: {} })).status, 400);
    assert.equal((await request(setup, '/api/auth/register', { method: 'POST', payload })).status, 429);
    assert.equal(JSON.parse(fs.readFileSync(path.join(setup.root, 'users.json'), 'utf8')).length, 2);
});

test('the first registration owns a username regardless of casing and whitespace', async context => {
    const setup = await fixture(context);
    const register = username => request(setup, '/api/auth/register', { method: 'POST', payload: { username, password: 'UniqueNamePassword!' } });
    const results = await Promise.all([register('First_Name'), register(' first_name ')]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
    assert.equal(results.find(result => result.status === 409).data.error.message, '该用户名已被注册，请修改用户名后重试。');
    const winner = results.find(result => result.status === 201).data.user;
    assert.equal(winner.id, winner.username);
    const users = JSON.parse(fs.readFileSync(path.join(setup.root, 'users.json'), 'utf8'));
    assert.equal(users.filter(user => user.username.toLowerCase() === 'first_name').length, 1);
    assert.equal((await register('available_name')).status, 201);
});

test('existing users expose usernames without rewriting internal IDs or sessions', async context => {
    const setup = await fixture(context);
    const before = fs.readFileSync(path.join(setup.root, 'users.json'), 'utf8');
    const result = await login(setup, 'MEMBER', 'MemberStrongPassword!');
    assert.equal(result.data.user.id, 'member');
    const cookie = result.cookie.split(';')[0];
    assert.equal((await request(setup, '/api/auth/me', { cookie })).data.user.id, 'member');
    assert.equal((await request(setup, '/api/canvas-projects', { cookie })).status, 200);
    const sessions = JSON.parse(fs.readFileSync(path.join(setup.root, 'sessions.json'), 'utf8'));
    assert.ok(Object.values(sessions).some(session => session.userId === 'normal-test-user'));
    assert.equal(fs.readFileSync(path.join(setup.root, 'users.json'), 'utf8'), before);
    const admin = await login(setup);
    const overview = await request(setup, '/api/admin/overview', { cookie: admin.cookie.split(';')[0] });
    assert.equal(overview.status, 200);
    assert.ok(overview.data.users.every(user => user.id === user.username));
});

test('anonymous users can browse the home and login pages but cannot reach any canvas API', async context => {
    const setup = await fixture(context);
    assert.equal((await request(setup, '/')).status, 200);
    const before = setup.reached.length;
    for (const endpoint of ['/api/canvas-projects', '/api/canvas-projects/project-id', '/api/upscale/runtime', '/api/upscale/jobs/id/image', '/api/local-save/directory', '/api/openai-chat-proxy', '/api/choose-save-directory']) {
        const result = await request(setup, endpoint);
        assert.equal(result.status, 401);
        assert.equal(result.data.error.type, 'login_required');
    }
    assert.equal((await request(setup, '/api/upscale/jobs', { method: 'POST', payload: {} })).status, 401);
    assert.equal(setup.reached.length, before);
    assert.equal((await request(setup, '/api/auth/wechat/config')).status, 200);
    const adminPage = await request(setup, '/admin');
    assert.equal(adminPage.status, 200);
    assert.match(adminPage.text, /管理员登录/);
    assert.ok(!adminPage.text.includes('TestAdminStrongPassword!'));
});

test('valid member sessions can reach canvas APIs and cross-origin requests remain blocked', async context => {
    const setup = await fixture(context);
    const result = await login(setup, 'member', 'MemberStrongPassword!');
    assert.equal(result.status, 200);
    const cookie = result.cookie.split(';')[0];
    for (const endpoint of ['/api/canvas-projects', '/api/upscale/runtime', '/api/local-save/directory']) assert.equal((await request(setup, endpoint, { cookie })).status, 200);
    assert.equal((await request(setup, '/api/upscale/jobs', { method: 'POST', cookie, payload: {}, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await request(setup, '/api/upscale/runtime', { cookie: cookie + 'tampered' })).status, 401);
    await request(setup, '/api/auth/logout', { method: 'POST', cookie });
    assert.equal((await request(setup, '/api/canvas-projects', { cookie })).status, 401);
});

test('administrator APIs require the admin role and never expose password hashes or keys', async context => {
    const setup = await fixture(context);
    assert.equal((await request(setup, '/api/admin/overview')).status, 401);
    const member = await login(setup, 'member', 'MemberStrongPassword!');
    assert.equal((await request(setup, '/api/admin/overview', { cookie: member.cookie.split(';')[0] })).status, 403);
    const admin = await login(setup);
    const result = await request(setup, '/api/admin/overview', { cookie: admin.cookie.split(';')[0] });
    assert.equal(result.status, 200);
    assert.equal(result.data.users.length, 2);
    assert.equal(result.data.administrator.role, 'admin');
    for (const sensitive of ['passwordHash', 'TestAdminStrongPassword!', 'MemberStrongPassword!', fs.readFileSync(path.join(setup.root, 'session.key'), 'utf8')]) assert.ok(!result.text.includes(sensitive));
});

test('expired sessions cannot resume editing even if a browser still holds the cookie', async context => {
    const setup = await fixture(context);
    const admin = await login(setup);
    const filename = path.join(setup.root, 'sessions.json');
    const sessions = JSON.parse(fs.readFileSync(filename, 'utf8'));
    for (const entry of Object.values(sessions)) entry.expiresAt = 0;
    fs.writeFileSync(filename, JSON.stringify(sessions));
    assert.equal((await request(setup, '/api/canvas-projects', { cookie: admin.cookie.split(';')[0] })).status, 401);
});

test('admin provisioning preserves existing users, passwords and generated credentials on rerun', async context => {
    const setup = await fixture(context);
    const usersFile = path.join(setup.root, 'users.json');
    const credentialsFile = path.join(setup.root, 'admin-access.json');
    const before = fs.readFileSync(usersFile, 'utf8');
    const credentials = fs.readFileSync(credentialsFile, 'utf8');
    const result = provisionLocalAdministrator({ ...setup.config, adminPassword: 'DoNotReplaceExistingPassword!' });
    assert.equal(result.created, false);
    assert.equal(fs.readFileSync(usersFile, 'utf8'), before);
    assert.equal(fs.readFileSync(credentialsFile, 'utf8'), credentials);
    assert.ok(!before.includes('TestAdminStrongPassword!'));
});

test('private file replacement is confined to one directory and supports encrypted Windows folders', async context => {
    const setup = await fixture(context);
    const source = path.join(setup.root, 'replacement.tmp');
    const destination = path.join(setup.root, 'replacement.json');
    fs.writeFileSync(source, 'new contents');
    fs.writeFileSync(destination, 'old contents');
    assert.throws(() => replacePrivateFile(source, path.join(os.tmpdir(), 'unsafe.json')), /same directory/);
    if (process.platform === 'win32') context.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('Encrypted rename'), { code: 'EXDEV' }); });
    replacePrivateFile(source, destination);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'new contents');
    assert.equal(fs.existsSync(source), false);
});
