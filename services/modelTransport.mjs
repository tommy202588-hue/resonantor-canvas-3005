const providerId = value => {
    const match = String(value || '').replace(/^Bearer\s+/i, '').match(/^managed:([a-zA-Z0-9_-]+)$/);
    return match?.[1];
};
const encodeFile = file => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file);
});

export async function prepareManagedRequest(url, options = {}, pageUrl = 'http://localhost:3004/') {
    const target = new URL(String(url), pageUrl);
    const headers = new Headers(options.headers || {});
    let payload = options.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch {} }
    const id = providerId(headers.get('authorization')) || providerId(headers.get('x-goog-api-key')) || providerId(target.searchParams.get('key')) || providerId(target.searchParams.get('api_key')) || providerId(payload?.apiKey);
    if (!id) return null;
    if (target.pathname.endsWith('/api/minimax-video-proxy')) {
        const base = String(payload.baseUrl).replace(/\/$/, '').replace(/\/v1$/, '');
        return { providerId: id, targetUrl: base.replace(/\/v2$/, '') + '/v2/video_generation' + (payload.action === 'query' ? '/' + encodeURIComponent(payload.taskId) : ''), method: payload.action === 'query' ? 'GET' : 'POST', payload: payload.payload, payloadType: 'json' };
    }
    if (/\/api\/(?:openai-chat|gemini-image|openai-images)-proxy$/.test(target.pathname)) return { providerId: id, targetUrl: payload.targetUrl, method: 'POST', payload: payload.payload, payloadType: payload.payloadType || 'json' };
    let payloadType = 'json';
    if (typeof FormData !== 'undefined' && payload instanceof FormData) {
        const entries = [];
        for (const [name, value] of payload.entries()) entries.push(typeof value === 'string' ? { name, kind: 'field', value } : { name, kind: 'file', fileName: value.name || 'image.png', mimeType: value.type, dataUrl: await encodeFile(value) });
        payload = entries;
        payloadType = 'form-data';
    }
    target.searchParams.delete('key');
    target.searchParams.delete('api_key');
    return { providerId: id, targetUrl: target.href, method: options.method || 'GET', payload, payloadType };
}
