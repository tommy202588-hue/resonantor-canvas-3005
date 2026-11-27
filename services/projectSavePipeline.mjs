export const saveTimeout = stage => Object.assign(new Error(stage + '超时，未确认保存成功。当前画布仍保留，请先导出备份后重试。'), { code: 'project_save_timeout' });

export function boundedPreparation(operation, { timeoutMs, signal, stage = '准备工程' }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            callback(value);
        };
        const abort = () => finish(reject, signal.reason || new DOMException('保存已取消。', 'AbortError'));
        const timer = setTimeout(() => finish(reject, saveTimeout(stage)), timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        Promise.resolve().then(operation).then(value => finish(resolve, value), error => finish(reject, error));
    });
}

// A cover is optional. Image decoding must never block the document commit.
export async function prepareProjectSave(data, { serialize, thumbnail, previousThumbnail = '', signal, onStage = () => {}, preparationTimeoutMs = 60_000, thumbnailTimeoutMs = 1500 }) {
    onStage('正在准备工程内容');
    const cover = boundedPreparation(() => thumbnail(data), { timeoutMs: thumbnailTimeoutMs, signal, stage: '生成封面' }).catch(() => previousThumbnail);
    const prepared = await boundedPreparation(() => serialize(data), { timeoutMs: preparationTimeoutMs, signal, stage: '准备工程内容' });
    const image = await cover;
    signal?.throwIfAborted();
    onStage('正在写入工程');
    return { data: prepared, thumbnail: image };
}
