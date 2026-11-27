import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createDesktopPackageMiddleware, resolveDesktopPackage } from './desktop-package.mjs';

test('resolves only fixed desktop package variants', () => {
    assert.equal(resolveDesktopPackage('win-x64')?.filename, 'resonantor-desktop-win-x64.zip');
    assert.equal(resolveDesktopPackage('mac-arm64')?.contentType, 'application/gzip');
    assert.equal(resolveDesktopPackage('single-html')?.filename, 'resonantor-canvas-double-click.html');
    assert.equal(resolveDesktopPackage('single-html')?.contentType, 'text/html; charset=utf-8');
    assert.equal(resolveDesktopPackage('missing'), null);
});

test('serves only the requested fixed desktop package', async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-package-'));
    const filename = 'resonantor-desktop-mac-arm64.tar.gz';
    const body = Buffer.from('package body');
    fs.writeFileSync(path.join(directory, filename), body);
    const packages = { 'mac-arm64': { filename, contentType: 'application/gzip', label: 'Mac Apple 芯片（M 系列）' } };
    const server = http.createServer(createDesktopPackageMiddleware({ packages, directory }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    context.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    });

    const ok = await fetch(base + '/?platform=mac-arm64');
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'application/gzip');
    assert.equal(ok.headers.get('content-disposition'), 'attachment; filename="' + filename + '"');
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), body);

    const invalid = await fetch(base + '/?platform=../../secret');
    assert.equal(invalid.status, 400);
});

test('serves the fixed single HTML download with an HTML content type', async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-html-package-'));
    const filename = 'resonantor-canvas-double-click.html';
    const body = Buffer.from('<!doctype html><title>共智体画布</title>');
    fs.writeFileSync(path.join(directory, filename), body);
    const packages = { 'single-html': { filename, contentType: 'text/html; charset=utf-8', label: '双击 HTML（Mac / Windows）' } };
    const server = http.createServer(createDesktopPackageMiddleware({ packages, directory }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    context.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    });

    const response = await fetch(base + '/?platform=single-html');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="' + filename + '"');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
});
