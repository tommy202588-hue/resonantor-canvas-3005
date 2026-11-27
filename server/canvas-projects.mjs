import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PROJECT_SETTINGS, validateProjectSettings, validateProjectData, encodeProjectFile, decodeProjectFile } from '../services/projectFile.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SNAPSHOT = /^snapshot-\d{13}-[0-9a-f-]{36}\.js$/;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function resolveProjectRoot() {
    if (process.platform !== 'win32') return path.join(os.homedir(), 'Desktop', '共智体画布工程');
    const encoded = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Environment]::GetFolderPath("DesktopDirectory"))))'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim();
    const desktop = Buffer.from(encoded, 'base64').toString('utf8');
    if (!desktop || !path.isAbsolute(desktop)) throw new Error('无法确定 Windows 桌面目录，请检查系统目录设置。');
    return path.join(desktop, '共智体画布工程');
}

export function createProjectStore({ rootDirectory, now = Date.now } = {}) {
    let root;
    const getRoot = () => {
        if (!root) {
            const requested = rootDirectory || resolveProjectRoot();
            fs.mkdirSync(requested, { recursive: true });
            root = fs.realpathSync(requested);
        }
        return root;
    };
    const directory = (id, create = false) => {
        if (!UUID.test(id)) throw fail('工程 ID 无效。');
        const folder = path.join(getRoot(), id);
        if (create) fs.mkdirSync(folder);
        if (!fs.existsSync(folder)) throw fail('工程不存在，可能已被移动或删除。', 404);
        if (fs.lstatSync(folder).isSymbolicLink() || fs.realpathSync(folder) !== folder) throw fail('工程目录不允许使用链接或重定向。', 403);
        return folder;
    };
    const read = id => {
        const meta = JSON.parse(fs.readFileSync(path.join(directory(id), 'project.json'), 'utf8'));
        if (meta.id !== id || !Array.isArray(meta.snapshots) || !meta.snapshots.length || meta.snapshots.some(item => !SNAPSHOT.test(item.filename))) throw fail('工程索引损坏，请从工程目录导入 .js 备份恢复。', 409);
        validateProjectSettings(meta.settings);
        if (!Number.isInteger(meta.revision) || meta.revision < 1 || new Set(meta.snapshots.map(item => item.filename)).size !== meta.snapshots.length) throw fail('工程版本索引无效，原备份文件未改动。', 409);
        return meta;
    };
    const publicProject = meta => ({
        id: meta.id, name: meta.name, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
        lastSavedAt: meta.lastSavedAt, settings: meta.settings, revision: meta.revision,
        snapshotCount: meta.snapshots.length, thumbnail: meta.thumbnail || '',
        nodeCount: meta.nodeCount || 0, directory: directory(meta.id), warning: meta.warning,
    });
    const writeMeta = meta => {
        const folder = directory(meta.id);
        const pending = path.join(folder, 'project.json.tmp');
        fs.writeFileSync(pending, JSON.stringify(meta), { encoding: 'utf8', flag: 'w' });
        fs.renameSync(pending, path.join(folder, 'project.json'));
    };
    const prune = meta => {
        const retained = meta.snapshots.slice(0, meta.settings.maxSnapshots);
        const expired = meta.snapshots.slice(meta.settings.maxSnapshots);
        meta.warning = undefined;
        for (const snapshot of expired) {
            const folder = directory(meta.id);
            const filename = path.resolve(folder, snapshot.filename);
            if (!SNAPSHOT.test(snapshot.filename) || path.dirname(filename) !== folder) throw fail('备份路径无效。', 403);
            try { fs.unlinkSync(filename); }
            catch (error) {
                if (error.code !== 'ENOENT') {
                    retained.push(snapshot);
                    meta.warning = '新备份已保存，但部分旧备份无法清理，请检查文件占用或权限。';
                }
            }
        }
        meta.snapshots = retained;
        writeMeta(meta);
    };
    const snapshot = (meta, data, thumbnail) => {
        validateProjectData(data);
        if (thumbnail !== undefined && (typeof thumbnail !== 'string' || thumbnail.length > 350_000 || (thumbnail && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(thumbnail)))) throw fail('工程封面无效。');
        const savedAt = now();
        const filename = 'snapshot-' + savedAt + '-' + randomUUID() + '.js';
        const folder = directory(meta.id);
        const content = encodeProjectFile({ ...data, canvasProject: { id: meta.id, name: meta.name, savedAt } });
        fs.writeFileSync(path.join(folder, filename + '.tmp'), content, { flag: 'wx' });
        fs.renameSync(path.join(folder, filename + '.tmp'), path.join(folder, filename));
        meta.snapshots.unshift({ filename, savedAt });
        meta.lastSavedAt = savedAt;
        meta.updatedAt = savedAt;
        meta.revision += 1;
        meta.nodeCount = data.nodes.length;
        if (thumbnail !== undefined) meta.thumbnail = thumbnail;
        writeMeta(meta);
        prune(meta);
        return publicProject(meta);
    };
    const checkRevision = (meta, revision) => {
        if (meta.revision !== revision) throw fail('该工程已在另一个页面更新。请先导出当前画布备份，再从首页重新打开工程。', 409);
    };
    return {
        list() {
            const projects = [];
            const warnings = [];
            for (const id of fs.readdirSync(getRoot())) {
                if (!UUID.test(id)) continue;
                try { projects.push(publicProject(read(id))); }
                catch { warnings.push('一个工程索引无法读取（' + id + '），原备份文件未改动。'); }
            }
            return { directory: getRoot(), projects: projects.sort((first, second) => second.updatedAt - first.updatedAt), warnings };
        },
        create({ name, data, thumbnail }) {
            if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw fail('工程名称应为 1–80 个字符。');
            validateProjectData(data);
            const id = randomUUID();
            directory(id, true);
            return snapshot({ id, name: name.trim(), createdAt: now(), revision: 0, settings: { ...DEFAULT_PROJECT_SETTINGS }, snapshots: [] }, data, thumbnail);
        },
        open(id) {
            const meta = read(id);
            const filename = path.join(directory(id), meta.snapshots[0].filename);
            if (fs.lstatSync(filename).isSymbolicLink()) throw fail('工程备份不允许使用链接。', 403);
            return { project: publicProject(meta), data: decodeProjectFile(fs.readFileSync(filename, 'utf8')) };
        },
        save(id, { revision, data, thumbnail }) {
            const meta = read(id);
            checkRevision(meta, revision);
            return snapshot(meta, data, thumbnail);
        },
        configure(id, { revision, settings }) {
            const meta = read(id);
            checkRevision(meta, revision);
            meta.settings = validateProjectSettings(settings);
            meta.revision += 1;
            writeMeta(meta);
            prune(meta);
            return publicProject(meta);
        },
        rename(id, { revision, name }) {
            const meta = read(id);
            checkRevision(meta, revision);
            if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw fail('工程名称应为 1–80 个字符。');
            meta.name = name.trim();
            meta.updatedAt = now();
            meta.revision += 1;
            writeMeta(meta);
            return publicProject(meta);
        },
        remove(id, { revision, confirmationId }) {
            const meta = read(id);
            checkRevision(meta, revision);
            if (confirmationId !== id) throw fail('请确认要删除的工程。');
            const source = directory(id);
            const trash = path.join(getRoot(), '已删除工程');
            fs.mkdirSync(trash, { recursive: true });
            if (fs.lstatSync(trash).isSymbolicLink() || fs.realpathSync(trash) !== trash) throw fail('已删除工程目录不能使用链接或重定向。', 403);
            const destination = path.resolve(trash, id + '-' + now() + '-' + randomUUID());
            if (path.dirname(source) !== getRoot() || path.dirname(destination) !== trash) throw fail('工程移除路径无效。', 403);
            fs.renameSync(source, destination);
            return { deletedId: id, directory: destination };
        },
    };
}

export function isLocalProjectRequest(request, interfaces = os.networkInterfaces()) {
    const normalize = address => address?.replace(/^::ffff:/, '');
    const localAddresses = new Set(['127.0.0.1', '::1']);
    for (const addresses of Object.values(interfaces)) {
        for (const entry of addresses || []) localAddresses.add(normalize(entry.address));
    }
    const remoteAddress = normalize(request.socket.remoteAddress);
    if (!localAddresses.has(remoteAddress)) return false;
    const hosts = ['localhost', ...localAddresses].map(address =>
        (address.includes(':') ? `[${address}]` : address) + ':' + request.socket.localPort);
    return hosts.includes(request.headers.host);
}

export function createCanvasProjectsMiddleware(options = {}) {
    const store = createProjectStore(options);
    return async (request, response) => {
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.setHeader('cache-control', 'no-store');
        try {
            const host = request.headers.host;
            if (!isLocalProjectRequest(request)) throw Object.assign(fail('请下载并运行本机保存启动器，再在自动打开的页面创建工程。工程将保存到你自己电脑的桌面，不会写入服务器。', 403), { code: 'desktop_companion_required' });
            if (request.method !== 'GET' && request.headers.origin !== 'http://' + host) throw fail('请求来源校验失败。', 403);
            if (!UUID.test(request.headers['x-canvas-project-client'] || '')) throw fail('缺少本机工程身份。', 403);
            const parts = new URL(request.url, 'http://localhost').pathname.split('/').filter(Boolean);
            let payload;
            if (request.method !== 'GET') {
                if (!request.headers['content-type']?.startsWith('application/json')) throw fail('请使用 JSON 数据。', 415);
                const chunks = [];
                let size = 0;
                for await (const chunk of request) {
                    size += chunk.length;
                    if (size > 512 * 1024 * 1024) throw fail('工程超过 512 MB，请拆分工程后再保存。', 413);
                    chunks.push(chunk);
                }
                payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            }
            let result;
            if (!parts.length && request.method === 'GET') result = store.list();
            else if (!parts.length && request.method === 'POST') result = { project: store.create(payload) };
            else if (parts.length === 1 && request.method === 'GET') result = store.open(parts[0]);
            else if (parts.length === 2 && parts[1] === 'snapshots' && request.method === 'POST') result = { project: store.save(parts[0], payload) };
            else if (parts.length === 2 && parts[1] === 'settings' && request.method === 'PATCH') result = { project: store.configure(parts[0], payload) };
            else if (parts.length === 2 && parts[1] === 'name' && request.method === 'PATCH') result = { project: store.rename(parts[0], payload) };
            else if (parts.length === 2 && parts[1] === 'delete' && request.method === 'POST') result = store.remove(parts[0], payload);
            else throw fail('工程接口不存在。', 404);
            response.statusCode = 200;
            response.end(JSON.stringify(result));
        } catch (error) {
            response.statusCode = error.status || (error.code ? 500 : 400);
            response.end(JSON.stringify({ error: { code: error.code, message: error.code === 'ENOSPC' ? '磁盘空间不足，工程未能保存。' : error.code === 'EACCES' || error.code === 'EPERM' ? '桌面工程目录无法写入，请检查文件夹权限。' : error.message || '工程保存失败。' } }));
        }
    };
}
