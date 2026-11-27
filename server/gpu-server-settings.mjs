import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './security.mjs';
import { replacePrivateFile } from './private-file.mjs';

export const DEFAULT_COMFY_INSTALL = 'D:/other/comfyui/ComfyUI-aki-v1.7/ComfyUI-aki-v1.7';

export const DEFAULT_GPU_SERVER = Object.freeze({
    id: 'primary-local-gpu',
    name: '主 GPU（当前服务器）',
    kind: 'local',
    comfyUrl: 'http://127.0.0.1:8188',
    seedUrl: 'http://127.0.0.1:8190',
    installRoot: DEFAULT_COMFY_INSTALL,
});

const error = message => new HttpError(400, message, 'invalid_gpu_settings');
const text = (value, label, max = 128) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw error(label + '无效。');
    return value.trim();
};
const hostWithoutBrackets = host => host.toLowerCase().replace(/^\[|\]$/g, '');
const isLoopbackHost = host => ['localhost', '127.0.0.1', '::1'].includes(hostWithoutBrackets(host));

const isPrivateIpv4 = host => {
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    return parts[0] === 10
        || parts[0] === 127
        || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        || (parts[0] === 192 && parts[1] === 168);
};

const normalizeGpuUrl = (value, label, kind) => {
    let parsed;
    try { parsed = new URL(text(value, label, 512)); }
    catch { throw error(label + '必须是有效 URL。'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw error(label + '必须是无凭据、无路径参数的 HTTP(S) 根地址。');
    }
    const host = hostWithoutBrackets(parsed.hostname);
    if (kind === 'local' && !isLoopbackHost(host)) throw error('本机 GPU 仅允许使用回环地址。');
    const isolatedTunnel = kind === 'remote'
        && parsed.protocol === 'http:'
        && parsed.hostname === '127.0.0.1'
        && ['18188', '18190'].includes(parsed.port);
    if (kind === 'remote' && !isolatedTunnel && (isLoopbackHost(host) || !isPrivateIpv4(host))) {
        throw error('远程 GPU 仅允许使用内网 IPv4 地址或专用回环隧道端口 18188/18190。');
    }
    return parsed.href.replace(/\/$/, '');
};

const normalizeInstallRoot = value => {
    const root = text(value, 'ComfyUI 安装路径', 1024);
    if (!path.isAbsolute(root)) throw error('ComfyUI 安装路径必须是绝对路径。');
    return path.normalize(root);
};

const normalizeServer = (input, ids) => {
    const id = text(input?.id, 'GPU 服务 ID', 48);
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id) || ids.has(id)) throw error('GPU 服务 ID 不可重复且仅支持字母、数字、下划线和短横线。');
    ids.add(id);
    const kind = input?.kind;
    if (!['local', 'remote'].includes(kind)) throw error('GPU 服务类型无效。');
    const server = {
        id,
        name: text(input.name, 'GPU 服务名称', 80),
        kind,
        comfyUrl: normalizeGpuUrl(input.comfyUrl, 'ComfyUI 地址', kind),
        seedUrl: normalizeGpuUrl(input.seedUrl, 'SeedVR2 地址', kind),
    };
    if (kind === 'local') server.installRoot = normalizeInstallRoot(input.installRoot);
    return server;
};

export const emptyGpuServerSettings = (defaultServer = DEFAULT_GPU_SERVER) => ({
    activeServerId: defaultServer.id,
    servers: [{ ...defaultServer }],
});

export function normalizeGpuServerSettings(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw error('GPU 服务配置无效。');
    if (!Array.isArray(input.servers) || input.servers.length < 1 || input.servers.length > 12) throw error('GPU 服务数量应为 1–12 个。');
    const ids = new Set();
    const servers = input.servers.map(server => normalizeServer(server, ids));
    const activeServerId = text(input.activeServerId, '当前 GPU 服务 ID', 48);
    if (!servers.some(server => server.id === activeServerId)) throw error('当前 GPU 服务不存在。');
    return { activeServerId, servers };
}

const publicServer = server => ({ id: server.id, name: server.name, kind: server.kind, managed: server.kind === 'local' });
const clone = value => structuredClone(value);

export function createGpuServerSettingsStore(dataDir, { defaultServer = DEFAULT_GPU_SERVER } = {}) {
    const filename = path.join(dataDir, 'gpu-server-settings.json');
    const read = () => {
        try {
            const document = JSON.parse(fs.readFileSync(filename, 'utf8'));
            if (!Number.isInteger(document.revision)) throw new Error('Invalid revision');
            return { revision: document.revision, settings: normalizeGpuServerSettings(document.settings) };
        } catch (caught) {
            if (caught?.code === 'ENOENT') return { revision: 0, settings: emptyGpuServerSettings(defaultServer) };
            if (caught instanceof HttpError) throw new HttpError(503, 'GPU 服务配置无效，请管理员检查备份。', 'gpu_settings_unavailable');
            throw new HttpError(503, 'GPU 服务配置无法读取，请管理员检查备份。', 'gpu_settings_unavailable');
        }
    };
    const view = (admin = false) => {
        const document = read();
        const settings = clone(document.settings);
        if (!admin) settings.servers = settings.servers.map(publicServer);
        return { revision: document.revision, settings };
    };
    const persist = (settings, revision) => {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        const temporary = filename + '.' + randomUUID() + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify({ revision, settings }), { flag: 'wx', mode: 0o600 });
        replacePrivateFile(temporary, filename);
    };
    const save = (input, revision) => {
        const previous = read();
        if (revision !== previous.revision) throw new HttpError(409, 'GPU 服务配置已在其他页面更新，请重新加载后编辑。', 'gpu_settings_conflict');
        const settings = normalizeGpuServerSettings(input);
        persist(settings, previous.revision + 1);
        return view(true);
    };
    const activate = (id, revision) => {
        const previous = read();
        if (revision !== previous.revision) throw new HttpError(409, 'GPU 服务配置已在其他页面更新，请重新加载后切换。', 'gpu_settings_conflict');
        const activeServerId = text(id, '当前 GPU 服务 ID', 48);
        if (!previous.settings.servers.some(server => server.id === activeServerId)) throw error('要切换的 GPU 服务不存在。');
        persist({ ...previous.settings, activeServerId }, previous.revision + 1);
        return view(true);
    };
    const active = () => {
        const document = read();
        const server = document.settings.servers.find(item => item.id === document.settings.activeServerId);
        if (!server) throw new HttpError(503, '当前 GPU 服务配置不存在，请管理员修复后台设置。', 'gpu_settings_unavailable');
        return clone(server);
    };
    const publicActive = () => publicServer(active());
    return { view, save, activate, active, publicActive };
}
