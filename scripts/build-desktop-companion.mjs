import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as tar from 'tar';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'desktop-companion-dist');
const staging = path.join(output, 'build-' + Date.now());
const nodeVersion = process.versions.node;
const variantArg = process.argv.find(argument => argument.startsWith('--variant='))?.slice('--variant='.length) || 'win-x64';
const variants = {
    'win-x64': { platform: 'win32', arch: 'x64', archiveName: 'resonantor-desktop-win-x64.zip', archiveType: 'zip', runtimeName: 'node.exe', launcherSource: 'scripts/start-desktop-companion.vbs', launcherName: '启动画布.vbs' },
    'mac-arm64': { platform: 'darwin', arch: 'arm64', archiveName: 'resonantor-desktop-mac-arm64.tar.gz', archiveType: 'tar.gz', runtimeName: 'node', launcherSource: 'scripts/start-desktop-companion.command', launcherName: '启动画布.command' },
    'mac-x64': { platform: 'darwin', arch: 'x64', archiveName: 'resonantor-desktop-mac-x64.tar.gz', archiveType: 'tar.gz', runtimeName: 'node', launcherSource: 'scripts/start-desktop-companion.command', launcherName: '启动画布.command' },
};
const variant = variants[variantArg];

if (!variant) throw new Error('Unsupported package variant: ' + variantArg + '. Use win-x64, mac-arm64, or mac-x64.');
if (variant.platform === 'win32' && (process.platform !== 'win32' || process.arch !== 'x64')) throw new Error('The Windows x64 package requires the Windows x64 Node runtime.');

const run = (command, args, options = {}) => execute(command, args, { windowsHide: true, ...options });
const fileExists = async filePath => {
    try { await fs.access(filePath); return true; }
    catch { return false; }
};
const quoteForPowerShell = value => "'" + value.replaceAll("'", "''") + "'";
const curlCommand = process.platform === 'win32' ? 'curl.exe' : 'curl';
const tarCommand = process.platform === 'win32' ? 'tar.exe' : 'tar';

const copyDesktopFiles = async bundle => {
    for (const filename of [
        'server/desktop-companion.mjs',
        'server/canvas-projects.mjs',
        'services/projectFile.mjs',
        'services/scriptStoryboard.mjs',
        'services/randomId.mjs',
        'scripts/start-desktop-companion.mjs',
    ]) {
        const destination = path.join(bundle, filename);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(path.join(root, filename), destination);
    }
};

const copyMacRuntime = async destination => {
    const cacheDirectory = path.join(output, 'node-runtime-cache');
    const cachePath = path.join(cacheDirectory, 'node-v' + nodeVersion + '-darwin-' + variant.arch);
    if (await fileExists(cachePath)) {
        await fs.copyFile(cachePath, destination);
        await fs.chmod(destination, 0o755);
        return;
    }

    const archiveName = 'node-v' + nodeVersion + '-darwin-' + variant.arch + '.tar.gz';
    const archivePath = path.join(staging, archiveName);
    const extractionDirectory = path.join(staging, 'node-extract-' + variant.arch);
    const sourceDirectory = 'node-v' + nodeVersion + '-darwin-' + variant.arch;
    const url = 'https://nodejs.org/dist/v' + nodeVersion + '/' + archiveName;
    console.log('Downloading ' + url);
    await run(curlCommand, ['--fail', '--location', '--retry', '3', '--connect-timeout', '30', '--max-time', '300', '--output', archivePath, url]);
    await fs.mkdir(extractionDirectory, { recursive: true });
    await run(tarCommand, ['-xzf', archivePath, '-C', extractionDirectory, sourceDirectory + '/bin/node']);
    const runtime = path.join(extractionDirectory, sourceDirectory, 'bin', 'node');
    if (!(await fileExists(runtime))) throw new Error('Downloaded macOS Node runtime is incomplete.');
    await fs.mkdir(cacheDirectory, { recursive: true });
    await fs.copyFile(runtime, cachePath);
    await fs.copyFile(cachePath, destination);
    await fs.chmod(destination, 0o755);
};

const copyRuntimeLicense = async destination => {
    const cachePath = path.join(output, 'node-' + nodeVersion + '-LICENSE.txt');
    let license = await fs.readFile(cachePath, 'utf8').catch(() => '');
    if (!license) {
        const response = await fetch('https://raw.githubusercontent.com/nodejs/node/v' + nodeVersion + '/LICENSE', { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error('Unable to fetch the official Node runtime license.');
        license = await response.text();
        if (!license.startsWith('Node.js is licensed')) throw new Error('Invalid Node runtime license response.');
        await fs.writeFile(cachePath, license);
    }
    await fs.writeFile(destination, license);
};

await fs.mkdir(staging, { recursive: true });
await fs.mkdir(path.join(staging, 'empty-env'), { recursive: true });
const staticBuild = path.join(staging, 'dist');
await build({
    configFile: false,
    root,
    base: '/',
    envDir: path.join(staging, 'empty-env'),
    envPrefix: 'RESONANTOR_PUBLIC_UNUSED_',
    plugins: [react()],
    define: Object.fromEntries(['API_KEY', 'GEMINI_API_KEY', 'VITE_COMFLY_API_KEY', 'COMFLY_API_KEY', 'VITE_DEFAULT_IMAGE_API_KEY', 'DEFAULT_IMAGE_API_KEY'].map(name => ['process.env.' + name, '""'])),
    resolve: { alias: { '@': root } },
    build: { outDir: staticBuild, emptyOutDir: true },
});

const bundle = path.join(staging, 'Resonantor-Desktop');
await fs.mkdir(path.join(bundle, 'runtime'), { recursive: true });
await fs.cp(staticBuild, path.join(bundle, 'dist'), { recursive: true });
await copyDesktopFiles(bundle);
await fs.copyFile(path.join(root, variant.launcherSource), path.join(bundle, variant.launcherName));
if (variant.platform === 'darwin') await fs.chmod(path.join(bundle, variant.launcherName), 0o755);

const runtimeDestination = path.join(bundle, 'runtime', variant.runtimeName);
if (variant.platform === 'win32') await fs.copyFile(process.execPath, runtimeDestination);
else await copyMacRuntime(runtimeDestination);
await copyRuntimeLicense(path.join(bundle, 'runtime', 'NODE-LICENSE.txt'));
await fs.copyFile(path.join(root, 'docs/DESKTOP-COMPANION.md'), path.join(bundle, '使用说明.md'));

const archive = path.join(staging, variant.archiveName);
if (variant.archiveType === 'zip') {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath ' + quoteForPowerShell(bundle) + ' -DestinationPath ' + quoteForPowerShell(archive) + ' -CompressionLevel Optimal'], { timeout: 180_000 });
} else {
    await tar.c({
        cwd: staging,
        file: archive,
        gzip: true,
        portable: true,
        onWriteEntry: entry => {
            const normalizedPath = entry.path.replace(/\\/g, '/');
            const executable = normalizedPath.endsWith('/启动画布.command') || normalizedPath.endsWith('/runtime/node');
            entry.stat.mode = entry.type === 'Directory' || executable ? 0o755 : 0o644;
        },
    }, ['Resonantor-Desktop']);
}
await fs.copyFile(archive, path.join(output, variant.archiveName));

console.log('Desktop package: ' + path.join(output, variant.archiveName));
console.log('Unpacked validation directory: ' + bundle);
