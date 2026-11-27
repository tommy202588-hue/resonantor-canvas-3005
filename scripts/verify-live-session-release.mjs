import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const site = 'https://www.resonantor.cn/resonantor-canvas/';
const releaseId = '20261020T020050Z';
const release = path.join(root, 'web-test-release', releaseId);
const result = { site, releaseId, completed: false, staticFiles: [], endpoints: [], browserChecks: [] };
const logFile = path.join(root, 'live-current-release-verification.log');
fs.writeFileSync(logFile, 'Live release verification ' + new Date().toISOString() + '\n');
const log = value => { fs.appendFileSync(logFile, value); process.stdout.write(value); };

try {
    for (const line of fs.readFileSync(path.join(release, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
        const [expected, name] = line.split('  ');
        if (!name.startsWith('dist/')) continue;
        const relative = name.slice(5);
        const response = await fetch(new URL(relative === 'index.html' ? '' : relative, site), { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
        assert.equal(response.status, 200, relative);
        const digest = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
        assert.equal(digest, expected, 'Live asset differs from verified release: ' + relative);
        if (relative === 'index.html') assert.match(response.headers.get('content-security-policy'), /connect-src[^;]*data:[^;]*blob:/);
        result.staticFiles.push({ path: relative, sha256: digest });
    }
    log('PASS 官网所有静态文件与已验收发布包 SHA256 一致\n');
    for (const [endpoint, expected] of [['healthz', 200], ['api/auth/me', 401], ['api/model-settings', 401], ['api/admin/overview', 401], ['admin', 200]]) {
        const response = await fetch(new URL(endpoint, site), { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
        assert.equal(response.status, expected, endpoint);
        await response.arrayBuffer();
        result.endpoints.push({ endpoint, status: response.status });
    }
    log('PASS 官网健康检查、登录门禁和管理入口状态正确\n');
    for (const script of ['verify-image-csp.mjs', 'verify-session-preservation.mjs', 'verify-browser-projects.mjs', 'verify-canvas-download.mjs', 'verify-canvas-undo.mjs']) {
        const child = spawn(process.execPath, [path.join(root, 'scripts', script)], {
            cwd: root,
            windowsHide: true,
            env: {
                ...process.env,
                CANVAS_VERIFY_URL: site,
                CANVAS_VERIFY_OUTPUT_PREFIX: 'live-current-',
                CANVAS_VERIFY_SKIP_LONG: '',
                PLAYWRIGHT_MODULE_PATH: process.env.PLAYWRIGHT_MODULE_PATH || 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', data => log(data.toString()));
        child.stderr.on('data', data => log(data.toString()));
        const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        result.browserChecks.push({ script, exitCode: code });
        assert.equal(code, 0, script);
    }
    result.completed = true;
} finally {
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(root, 'live-current-release-verification.json'), JSON.stringify(result, null, 2) + '\n');
}
