import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineArgument = process.argv.slice(2).find(argument => argument.startsWith('--backend-baseline='));
const backendRoot = baselineArgument ? path.resolve(root, baselineArgument.slice('--backend-baseline='.length)) : root;
if (baselineArgument) {
    const relative = path.relative(path.join(root, 'web-test-release'), backendRoot);
    if (!/^\d{8}T\d{6}Z$/.test(relative)) throw new Error('Backend baseline must be an existing local release.');
    const manifest = fs.readFileSync(path.join(backendRoot, 'SHA256SUMS'), 'utf8');
    for (const line of manifest.trim().split('\n')) {
        const [digest, filename] = line.split('  ');
        if (!/^[a-f0-9]{64}$/.test(digest) || !filename || filename.includes('\\')) throw new Error('Invalid baseline manifest.');
        const absolute = path.resolve(backendRoot, filename);
        if (!absolute.startsWith(backendRoot + path.sep)) throw new Error('Unsafe baseline manifest path.');
        if (createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') !== digest) throw new Error('Baseline checksum mismatch: ' + filename);
    }
}
const sourceDist = path.join(root, 'dist-web-test');
const html = fs.readFileSync(path.join(sourceDist, 'index.html'), 'utf8');
if (!html.includes('/resonantor-canvas/assets/') || html.includes('type="importmap"')) throw new Error('Run npm run build:web-test before packaging.');
const releaseId = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const output = path.join(root, 'web-test-release', releaseId);
fs.mkdirSync(output, { recursive: true });
fs.cpSync(sourceDist, path.join(output, 'dist'), { recursive: true, errorOnExist: true, force: false });
const copied = new Set();
const copySource = relative => {
    const absolute = path.resolve(backendRoot, relative);
    const normalized = path.relative(backendRoot, absolute).replaceAll('\\', '/');
    if (!/^(server|services)\/[a-zA-Z0-9_./-]+\.(mjs|js|html|py)$/.test(normalized) || normalized.includes('..') || normalized.includes('.test.')) throw new Error('Unsafe release source: ' + normalized);
    if (copied.has(normalized)) return;
    copied.add(normalized);
    const destination = path.join(output, normalized);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(absolute, destination, fs.constants.COPYFILE_EXCL);
    if (!normalized.endsWith('.mjs')) return;
    const source = fs.readFileSync(absolute, 'utf8');
    const references = [...source.matchAll(/(?:from\s*|import\s*\(|new URL\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)];
    for (const [, dependency] of references) copySource(path.relative(backendRoot, path.resolve(path.dirname(absolute), dependency)));
};
copySource('server/start-web-test.mjs');
copySource('server/upscale-image.py');
for (const filename of ['web-test-locations.conf', 'web-test-static-security.conf', 'resonantor-canvas-test.service']) {
    fs.mkdirSync(path.join(output, 'deploy'), { recursive: true });
    fs.copyFileSync(path.join(root, 'deploy', filename), path.join(output, 'deploy', filename), fs.constants.COPYFILE_EXCL);
}
fs.copyFileSync(path.join(root, 'docs', 'HTTPS-BROWSER-PROJECTS.md'), path.join(output, 'DEPLOY-README.md'));
fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify({ name: 'resonantor-canvas-web-test', private: true, type: 'module', scripts: { start: 'node server/start-web-test.mjs' }, engines: { node: '>=22' } }, null, 2) + '\n', { flag: 'wx' });
const hashes = [];
const inventory = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Release cannot contain symlinks.');
        if (entry.isDirectory()) inventory(absolute);
        else {
            const filename = path.relative(output, absolute).replaceAll('\\', '/');
            if (/(?:^|\/)(?:\.env.*|.*\.(?:pem|key)|users\.json|sessions\.json|model-settings\.json|admin-access\.json)$/.test(filename)) throw new Error('Release cannot contain runtime credentials.');
            hashes.push(createHash('sha256').update(fs.readFileSync(absolute)).digest('hex') + '  ' + filename);
        }
    }
};
inventory(output);
fs.writeFileSync(path.join(output, 'SHA256SUMS'), hashes.join('\n') + '\n');
const archive = output + '.tar.gz';
const packed = spawnSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-czf', archive, '-C', output, '.'], { stdio: 'inherit', windowsHide: true });
if (packed.status !== 0) throw new Error('Release archive could not be created.');
console.log(JSON.stringify({ releaseId, directory: output, archive, files: hashes.length, backendBaseline: baselineArgument ? path.basename(backendRoot) : null, sha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex') }, null, 2));
