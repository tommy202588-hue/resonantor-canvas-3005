import { generateText, generateImage } from './geminiService';
import { apiPath } from './apiClient';
import { buildStoryboardRequest, buildShotPromptRequest, buildAssetPrompt, parseStoryboard, parseShotPrompts, resolveScriptModel, SCRIPT_LIMITS, isScriptImage } from './scriptStoryboard.mjs';
import type { AppSettings } from '../types/settings';
import type { ScriptDocument, ScriptShot, ScriptAsset } from '../types/storyboard';

export async function generateStoryboard(doc: ScriptDocument, count: number, settings: AppSettings, selection: string, onProgress?: (percent: number, stage: string) => void) {
    const { provider, model } = resolveScriptModel(settings, 'text', selection);
    const request = buildStoryboardRequest(doc, count);
    onProgress?.(25, '原稿已校验 · 等待大模型生成分镜');
    const response = await generateText(request.user, model.id, provider, [], request.system);
    onProgress?.(50, '模型已返回 · 正在校验分镜与资产');
    const result = parseStoryboard(response, doc);
    onProgress?.(75, '分镜校验完成 · 正在写回画布节点');
    return result;
}

export async function generateShotPrompts(doc: ScriptDocument, shots: ScriptShot[], settings: AppSettings, selection: string) {
    const { provider, model } = resolveScriptModel(settings, 'text', selection);
    const request = buildShotPromptRequest(doc, shots);
    const response = await generateText(request.user, model.id, provider, [], request.system);
    return parseShotPrompts(response, shots);
}

export async function readScreenplay(file: File) {
    if (!/\.(txt|md|srt|fountain)$/i.test(file.name)) throw new Error('请上传 TXT、Markdown、SRT 或 Fountain 文本。Word / PDF 请先导出为 TXT，或复制正文粘贴。');
    if (file.size > 512 * 1024) throw new Error('文件不能超过 512 KB，请按集拆分后上传。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let source: string;
    if (bytes[0] === 255 && bytes[1] === 254) source = new TextDecoder('utf-16le').decode(bytes);
    else if (bytes[0] === 254 && bytes[1] === 255) source = new TextDecoder('utf-16be').decode(bytes);
    else {
        try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { source = new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
    }
    source = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    if (!source || source.includes('\0')) throw new Error('文件没有可识别的剧本文本。');
    if (source.length > SCRIPT_LIMITS.source) throw new Error('每次最多处理 40000 字符，请按集拆分剧本。不会自动截断原文。');
    return source;
}

export async function prepareScriptImage(blob: Blob): Promise<string> {
    if (!/^image\/(png|jpeg|webp)$/.test(blob.type) || blob.size > 12 * 1024 * 1024) throw new Error('请使用不超过 12 MB 的 PNG、JPG 或 WebP 图片。');
    const bitmap = await createImageBitmap(blob).catch(() => { throw new Error('无法解码图片，请换一张有效图片。'); });
    try {
        if (bitmap.width * bitmap.height > 40_000_000) throw new Error('资产参考图不能超过 4000 万像素。');
        const scale = Math.min(1, 1536 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('浏览器无法处理资产图片。');
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL('image/webp', 0.9);
        if (!isScriptImage(data)) throw new Error('图片转换后仍然过大，请选择较小的图片。');
        return data;
    } finally { bitmap.close(); }
}

export async function generateScriptAsset(doc: ScriptDocument, asset: ScriptAsset, settings: AppSettings, selection: string) {
    if (!asset.name.trim() || !asset.description.trim()) throw new Error('请先填写资产名称和外观设定。');
    const { provider, model } = resolveScriptModel(settings, 'image', selection);
    const result = await generateImage(buildAssetPrompt(doc, asset), model.id, asset.kind === 'scene' ? '16:9' : '1:1', '1k', provider);
    const image = result.primaryImage;
    if (!image || !/^(data:image\/|blob:|https?:\/\/)/i.test(image)) throw new Error('模型未返回有效图片。');
    let response: Response;
    try {
        response = await fetch(image, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error();
    } catch {
        if (!/^https?:/.test(image)) throw new Error('资产图片读取失败，请重试。');
        response = await fetch(apiPath('/api/openai-download-proxy?url=' + encodeURIComponent(image)), { credentials: 'include', signal: AbortSignal.timeout(60_000) });
    }
    if (!response.ok) throw new Error('资产生成成功但下载失败，请稍后重试或手动上传。');
    return prepareScriptImage(await response.blob());
}
