import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from './security.mjs';
import { replacePrivateFile } from './private-file.mjs';

export const MODEL_GROUPS = ['image', 'video', 'text', 'audio'];
const TYPES = new Set(['gemini', 'openai', 'sora', 'veo', 'univ2', 'grok', 'minimax']);
const problem = message => new HttpError(400, message, 'invalid_model_settings');
export const emptyModelSettings = () => ({ imageProviders: [], videoProviders: [], textProviders: [], audioProviders: [], concurrencyLimit: 3 });
const text = (value, label, max = 128) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw problem(label + '无效。');
    return value.trim();
};

export function normalizeModelSettings(input, previous = emptyModelSettings()) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw problem('模型配置无效');
    const result = emptyModelSettings();
    const ids = new Set();
    const oldProviders = MODEL_GROUPS.flatMap(group => previous[group + 'Providers'] || []);
    for (const group of MODEL_GROUPS) {
        const list = input[group + 'Providers'];
        if (!Array.isArray(list) || list.length > 30) throw problem('每类提供商最多 30 个');
        result[group + 'Providers'] = list.map(provider => {
            const id = text(provider?.id, '提供商 ID');
            if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) throw problem('提供商 ID 不可重复且仅支持字母、数字、下划线和短横线');
            ids.add(id);
            const name = text(provider.name, '提供商名称');
            if (!TYPES.has(provider.type)) throw problem('接口类型无效');
            let base;
            try { base = new URL(provider.baseUrl); } catch { throw problem('API 地址无效'); }
            if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || (base.port && base.port !== '443')) throw problem('API 地址必须为不含凭据或查询参数的 HTTPS 地址');
            const baseUrl = base.href.replace(/\/+$/, '');
            const old = oldProviders.find(item => item.id === id);
            const suppliedKey = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : '';
            if (suppliedKey.startsWith('managed:')) throw problem('不能导入前端模型标识作为 API 密钥');
            if (old?.apiKey && !suppliedKey && (old.baseUrl !== baseUrl || old.type !== provider.type)) throw problem('修改 API 地址或类型时必须重新输入密钥，避免旧密钥发送到新地址');
            const apiKey = provider.clearApiKey ? '' : suppliedKey || old?.apiKey || '';
            if (apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw problem('API 密钥无效');
            if (!Array.isArray(provider.models) || provider.models.length > 200) throw problem('模型列表无效');
            const modelIds = new Set();
            const models = provider.models.map(model => {
                const modelId = text(model?.id, '模型 ID');
                if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(modelId) || modelIds.has(modelId)) throw problem('模型 ID 无效或重复');
                modelIds.add(modelId);
                return { id: modelId, displayName: text(model.displayName || modelId, '模型名称') };
            });
            if (provider.customEndpoint !== undefined && typeof provider.customEndpoint !== 'string') throw problem('自定义路径无效');
            const customEndpoint = provider.customEndpoint?.trim() || '';
            if (customEndpoint && (!/^\/[a-zA-Z0-9/_:.-]+$/.test(customEndpoint) || customEndpoint.includes('..') || customEndpoint.startsWith('//'))) throw problem('自定义路径必须是以单个 / 开头的相对路径');
            return { id, name, type: provider.type, baseUrl, apiKey, models, endpointMode: provider.endpointMode === 'custom' ? 'custom' : 'chat', customEndpoint, isDefault: false };
        });
        const defaultKey = 'default' + group[0].toUpperCase() + group.slice(1) + 'Provider';
        const requested = input[defaultKey] || list.find(provider => provider.isDefault)?.id;
        const providers = result[group + 'Providers'];
        if (requested && !providers.some(provider => provider.id === requested)) throw problem('默认提供商不存在');
        result[defaultKey] = requested || providers[0]?.id;
        providers.forEach(provider => { provider.isDefault = provider.id === result[defaultKey]; });
    }
    const concurrency = input.concurrencyLimit ?? 3;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 15) throw problem('并发数应为 1–15');
    result.concurrencyLimit = concurrency;
    return result;
}

export function createModelSettingsStore(dataDir) {
    const filename = path.join(dataDir, 'model-settings.json');
    const read = () => {
        try { const document = JSON.parse(fs.readFileSync(filename, 'utf8')); if (!Number.isInteger(document.revision) || !MODEL_GROUPS.every(group => Array.isArray(document.settings?.[group + 'Providers']))) throw new Error(); return document; }
        catch (error) { if (error.code === 'ENOENT') return { revision: 0, settings: emptyModelSettings() }; throw new HttpError(503, '后台模型配置无法读取，请管理员检查备份。', 'model_settings_unavailable'); }
    };
    const view = (admin = false) => {
        const document = read();
        const settings = { ...document.settings };
        for (const group of MODEL_GROUPS) settings[group + 'Providers'] = settings[group + 'Providers'].map(provider => ({ ...provider, apiKey: admin ? '' : provider.apiKey ? 'managed:' + provider.id : '', hasApiKey: Boolean(provider.apiKey) }));
        return { revision: document.revision, settings };
    };
    const save = (input, revision) => {
        const previous = read();
        if (revision !== previous.revision) throw new HttpError(409, '模型配置已在其他页面更新，请重新加载后编辑。', 'model_settings_conflict');
        const settings = normalizeModelSettings(input, previous.settings);
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        const pending = filename + '.' + randomUUID() + '.tmp';
        fs.writeFileSync(pending, JSON.stringify({ revision: previous.revision + 1, settings }), { flag: 'wx', mode: 0o600 });
        replacePrivateFile(pending, filename);
        return view(true);
    };
    const resolve = id => {
        const document = read();
        const provider = MODEL_GROUPS.flatMap(group => document.settings[group + 'Providers']).find(item => item.id === id);
        if (!provider?.apiKey || !provider.models.length) throw new HttpError(503, '该模型服务尚未在后台配置，请联系管理员。', 'model_not_configured');
        return provider;
    };
    return { view, save, resolve };
}
