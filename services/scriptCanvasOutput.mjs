import { createRandomId } from './randomId.mjs';
import { validateScriptDocument } from './scriptStoryboard.mjs';

export function buildScriptCanvasOutput(source, doc, kind, videoProvider) {
    validateScriptDocument(doc);
    if (!['text', 'video'].includes(kind)) throw new Error('不支持的脚本输出类型。');
    const ready = doc.shots.filter(shot => shot.prompt.trim());
    if (!ready.length) throw new Error('请先合成提示词。');
    if (kind === 'video' && (!doc.shotsConfirmed || ready.length !== doc.shots.length)) throw new Error('请先确认所有镜头并完成提示词合成。');
    const nodes = [];
    const connections = [];
    const assetNodes = new Map();
    const originX = source.position.x + source.width + 110;
    if (kind === 'video') {
        const used = new Set(ready.flatMap(shot => shot.assetIds));
        for (const asset of doc.assets.filter(item => used.has(item.id) && item.imageDataUrl)) {
            const node = {
                id: createRandomId(), type: 'image', title: asset.name,
                position: { x: originX, y: source.position.y + assetNodes.size * 270 },
                width: 290, height: 190, content: asset.imageDataUrl, status: 'success', isReferenceImage: true,
                scriptOrigin: { nodeId: source.id, assetId: asset.id }
            };
            assetNodes.set(asset.id, node.id); nodes.push(node);
        }
    }
    for (let index = 0; index < ready.length; index += 1) {
        const shot = ready[index];
        const id = createRandomId();
        const shotNumber = doc.shots.findIndex(item => item.id === shot.id) + 1;
        const node = {
            id, type: kind, title: '镜头 ' + String(shotNumber).padStart(2, '0') + ' · ' + shot.duration + 's',
            position: { x: originX + (assetNodes.size ? 400 : 0) + (index % 3) * 430, y: source.position.y + Math.floor(index / 3) * 380 },
            width: 360, height: kind === 'video' ? 240 : 280,
            content: kind === 'text' ? shot.prompt : '', prompt: kind === 'video' ? shot.prompt : '',
            status: kind === 'text' ? 'success' : 'idle',
            scriptOrigin: { nodeId: source.id, shotId: shot.id },
            ...(kind === 'video' ? {
                providerId: videoProvider?.id, modelId: videoProvider?.models?.[0]?.id,
                params: { model: videoProvider?.models?.[0]?.id || '', aspectRatio: '16:9', resolution: videoProvider?.type === 'minimax' ? '768P' : '720p', batchSize: 1, duration: shot.duration + 's', seconds: String(shot.duration) }
            } : {})
        };
        nodes.push(node);
        if (kind === 'video') for (const assetId of new Set(shot.assetIds)) {
            const fromNodeId = assetNodes.get(assetId);
            if (fromNodeId) connections.push({ id: createRandomId(), fromNodeId, toNodeId: id });
        }
    }
    return { nodes, connections };
}
