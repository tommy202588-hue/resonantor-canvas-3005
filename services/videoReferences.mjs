export function selectVideoReferenceImages(prompt, images) {
    const indexes = new Set(Array.from((prompt || '').matchAll(/@图(\d+)/g), match => Number(match[1]) - 1));
    return indexes.size ? images.filter(image => indexes.has(image.index)) : images;
}

export function buildVideoReferencePrompt(prompt, images) {
    const mentions = Array.from((prompt || '').matchAll(/@图(\d+)/g));
    const unavailable = mentions.find(match => !images.some(image => image.index === Number(match[1]) - 1));
    if (unavailable) throw new Error('参考图 ' + unavailable[0] + ' 已断开连接或没有可用图片，请重新连接或移除该引用。');
    return (prompt || '').replace(/@图(\d+)/g, (_match, index) => '参考图' + (images.findIndex(image => image.index === Number(index) - 1) + 1));
}
