export function updateScriptGeneration(nodes, nodeId, taskId, task, document) {
    return nodes.map(node => {
        if (node.id !== nodeId || node.type !== 'script' || node.scriptGeneration?.id !== taskId) return node;
        const generation = { ...node.scriptGeneration, ...task };
        return {
            ...node,
            ...(document ? { script: document } : {}),
            scriptGeneration: generation,
            status: generation.status === 'running' ? 'loading' : generation.status,
            progress: generation.progress,
        };
    });
}

export function interruptOrphanScriptGeneration(node, activeTasks) {
    const task = node.scriptGeneration;
    if (node.type !== 'script' || task?.status !== 'running' || activeTasks.get(node.id) === task.id) return node;
    return {
        ...node, status: 'error',
        scriptGeneration: { ...task, status: 'error', stage: '生成已中断', error: '页面刷新或关闭后，上次分镜请求无法继续接收。原稿和已有分镜已保留，请重新生成；上游请求可能仍在执行，不会自动重试。' },
    };
}

export function scriptGenerationError(error) {
    return (error instanceof Error ? error.message : '分镜生成失败，请稍后重试。')
        .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9_.-]{12,}/gi, '[已隐藏凭据]').slice(0, 1200);
}
