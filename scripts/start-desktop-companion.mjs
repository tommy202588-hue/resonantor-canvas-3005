import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createDesktopCompanion, DESKTOP_UPSTREAM } from '../server/desktop-companion.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = 'http://127.0.0.1:3006/';
const log = message => fs.appendFileSync(path.join(root, 'start.log'), new Date().toISOString() + ' ' + message + '\n');

const open = () => {
    const command = process.platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : process.platform === 'darwin'
            ? ['open', [url]]
            : ['xdg-open', [url]];
    execFile(command[0], command[1], { windowsHide: true }, error => { if (error) log('Unable to open browser: ' + error.message); });
};

const showStartupFailure = message => {
    log(message);
    console.error(message);
    if (process.platform === 'win32') {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show("本机画布启动失败，请检查 3006 端口占用，并查看启动器文件夹中的 start.log。", "共智体画布")'], { windowsHide: true }, () => {});
    }
};

const server = createDesktopCompanion({ publicDirectory: path.join(root, 'dist') });
server.on('error', async error => {
    if (error.code === 'EADDRINUSE') {
        try {
            const response = await fetch(url + 'desktop-health', { signal: AbortSignal.timeout(3000) });
            const health = await response.json();
            if (health.service === 'resonantor-desktop-v1' && health.upstream === DESKTOP_UPSTREAM) { open(); return; }
        } catch {}
    }
    showStartupFailure(error.stack || error.message);
});
server.listen(3006, '127.0.0.1', () => { log('Local desktop canvas ready. Upstream: ' + DESKTOP_UPSTREAM); open(); });

const stop = () => server.close(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
