import { validateScriptDocument } from './scriptStoryboard.mjs';

export const DEFAULT_PROJECT_SETTINGS = { intervalMinutes: 5, maxSnapshots: 5 };

export function validateProjectSettings(settings) {
    if (!Number.isInteger(settings?.intervalMinutes) || settings.intervalMinutes < 1 || settings.intervalMinutes > 120) throw new Error('自动保存频率应为 1–120 分钟的整数。');
    if (!Number.isInteger(settings?.maxSnapshots) || settings.maxSnapshots < 1 || settings.maxSnapshots > 100) throw new Error('最大保存数目应为 1–100 的整数。');
    return { intervalMinutes: settings.intervalMinutes, maxSnapshots: settings.maxSnapshots };
}

export function validateProjectData(data) {
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.connections)) throw new Error('工程文件缺少有效的节点或连接数据。');
    if (data.nodes.some(node => !node || typeof node.id !== 'string' || !['image', 'video', 'audio', 'text', 'script'].includes(node.type) || !Number.isFinite(node.position?.x) || !Number.isFinite(node.position?.y) || !Number.isFinite(node.width) || !Number.isFinite(node.height))) throw new Error('工程文件包含无效节点。');
    for (const node of data.nodes) if (node.type === 'script') validateScriptDocument(node.script);
    if (new Set(data.nodes.map(node => node.id)).size !== data.nodes.length) throw new Error('工程文件中存在重复节点 ID。');
    if (data.groups !== undefined && !Array.isArray(data.groups)) throw new Error('工程分组数据无效。');
    return data;
}

export function encodeProjectFile(data) {
    return 'export default ' + JSON.stringify(validateProjectData(data)) + ';\n';
}

export function decodeProjectFile(text) {
    const source = text.replace(/^\uFEFF/, '').trim();
    const json = source.startsWith('export default ') ? source.slice('export default '.length).replace(/;\s*$/, '') : source;
    return validateProjectData(JSON.parse(json));
}
