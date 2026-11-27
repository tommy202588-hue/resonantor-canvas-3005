import { HttpError } from './security.mjs';

export function resolveModelRequest(store, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '模型请求格式无效。', 'invalid_model_request');
    const provider = store.resolve(input?.providerId);
    let target;
    try { target = new URL(input.targetUrl); } catch { throw new HttpError(400, '模型请求地址无效。', 'invalid_model_request'); }
    const base = new URL(provider.baseUrl);
    if (target.origin !== base.origin || target.username || target.password || target.hash || /%2f|%5c|%2e/i.test(target.pathname)) throw new HttpError(403, '模型请求地址不属于管理员配置。', 'model_target_denied');
    const basePath = base.pathname.replace(/\/+$/, '');
    const root = basePath.replace(/\/(?:v1|v1beta|v2)(?:\/.*)?$/, '');
    if (root && target.pathname !== root && !target.pathname.startsWith(root + '/')) throw new HttpError(403, '模型请求路径不属于管理员配置。', 'model_target_denied');
    const route = target.pathname.slice(root.length).replace(/^\/(?:v1|v1beta|v2)(?=\/)/, '');
    const method = input.method || 'POST';
    const isSpeech = method === 'POST' && provider.type === 'minimax' && route === '/t2a_v2';
    const isRead = method === 'GET' && /^\/(?:videos\/(?:generations\/)?[a-zA-Z0-9_-]+(?:\/content)?|video\/query|video_generation\/[a-zA-Z0-9_-]+)$/.test(route);
    const isCreate = method === 'POST' && (/^\/(?:chat\/completions|images\/(?:generations|edits)|audio\/speech|videos(?:\/generations)?|video\/(?:create|generations)|video_generation|models\/[a-zA-Z0-9._:/-]+:(?:generateContent|streamGenerateContent))$/.test(route) || (provider.customEndpoint && target.pathname === basePath + provider.customEndpoint));
    const isRemix = method === 'POST' && /^\/videos\/[a-zA-Z0-9_-]+\/remix$/.test(route);
    if (!isRead && !isCreate && !isRemix && !isSpeech) throw new HttpError(403, '该接口未开放给画布模型调用。', 'model_endpoint_denied');
    const payloadType = input.payloadType || 'json';
    if (!['json', 'form-data'].includes(payloadType) || (payloadType === 'form-data' && !Array.isArray(input.payload))) throw new HttpError(400, '模型请求格式无效。', 'invalid_model_request');
    if (payloadType === 'form-data' && input.payload.some(field => !field || typeof field.name !== 'string' || !['field', 'file'].includes(field.kind) || (field.kind === 'field' ? typeof field.value !== 'string' : typeof field.dataUrl !== 'string'))) throw new HttpError(400, '模型表单字段无效。', 'invalid_model_request');
    if (method === 'POST' && payloadType === 'json' && (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload))) throw new HttpError(400, '模型 JSON 内容无效。', 'invalid_model_request');
    let modelId = payloadType === 'form-data' ? input.payload.find(field => field.name === 'model')?.value : input.payload?.model;
    if (isSpeech && (payloadType !== 'json' || typeof input.payload.text !== 'string' || !input.payload.text.trim() || input.payload.text.length >= 10000 || input.payload.stream === true || (input.payload.output_format && input.payload.output_format !== 'hex'))) throw new HttpError(400, '请提交少于 10000 字符的文本，并使用非流式 hex 音频输出。', 'invalid_audio_request');
    const gemini = route.match(/\/models\/(.+):(?:generateContent|streamGenerateContent)$/);
    if (gemini) modelId = gemini[1];
    if ((!isRead && !isRemix && !modelId) || (modelId && !provider.models.some(model => model.id === modelId || model.id === 'models/' + modelId))) throw new HttpError(403, '该模型未在后台开放，请重新选择模型。', 'model_not_allowed');
    if (payloadType === 'form-data' && input.payload.filter(field => field.name === 'model').length > 1) throw new HttpError(400, '模型字段不能重复。', 'invalid_model_request');
    target.searchParams.delete('key');
    target.searchParams.delete('api_key');
    const authHeader = gemini && base.hostname === 'generativelanguage.googleapis.com' ? 'x-goog-api-key' : 'authorization';
    return { provider, targetUrl: target.href, method, payloadType, payload: input.payload, headers: { [authHeader]: authHeader === 'authorization' ? 'Bearer ' + provider.apiKey.replace(/^Bearer\s+/i, '') : provider.apiKey } };
}
