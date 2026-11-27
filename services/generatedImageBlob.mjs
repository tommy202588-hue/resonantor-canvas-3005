export async function readGeneratedImageBlob(value, { apiPath, origin = window.location.origin, fetchImage = fetch }) {
    const url = new URL(value, origin);
    const read = async (target, options) => {
        const response = await fetchImage(target, options);
        if (!response.ok) {
            const detail = await response.json().catch(() => null);
            const message = detail?.error?.type === 'target_not_allowed'
                ? '图片下载地址未获服务器授权，请重新生成或联系管理员检查下载配置'
                : detail?.error?.message || '读取生成图片失败';
            throw new Error(message + '（HTTP ' + response.status + '）');
        }
        const blob = await response.blob();
        if (!blob.size || !blob.type.toLowerCase().startsWith('image/')) throw new Error('下载响应不是有效的图片，请检查图片链接是否已过期');
        return blob;
    };
    if (['data:', 'blob:'].includes(url.protocol) || url.origin === origin) return read(url.href);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('不支持的图片地址');
    try {
        return await read(apiPath('/api/openai-download-proxy?url=' + encodeURIComponent(url.href)), { cache: 'no-store', credentials: 'include' });
    } catch (proxyError) {
        try { return await read(url.href, { credentials: 'omit', referrerPolicy: 'no-referrer' }); }
        catch { throw proxyError; }
    }
}
