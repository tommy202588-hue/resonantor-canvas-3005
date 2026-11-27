const deliveries = new Map();

export async function saveImageToUserComputer(blob, filename, directory, { checkPermission, writeFile, download = downloadImageBlob }) {
    let fallbackReason = '';
    if (directory && !directory.__download) {
        try {
            if (!await checkPermission(directory, false)) throw new Error('所选文件夹需要重新授权');
            await writeFile(directory, filename, blob);
            return { browserState: 'saved', browserMessage: '已自动保存到「' + directory.name + '」' };
        } catch (error) {
            fallbackReason = (error?.message || '所选文件夹保存失败') + '；';
        }
    }
    await download(blob, filename);
    return {
        browserState: 'requested',
        browserMessage: fallbackReason + '已发起浏览器下载，位置由浏览器的下载设置决定；若未出现，请允许自动下载或点击节点下载按钮',
    };
}

export function downloadImageBlob(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    try {
        link.href = objectUrl;
        link.download = filename;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
    } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    }
}

export function deliverProcessedImageOnce(taskId, save, storage) {
    const key = 'canvas-processed-download:' + taskId;
    if (deliveries.has(key)) return deliveries.get(key);
    const delivery = (async () => {
        try {
            storage ??= globalThis.localStorage;
            const previous = JSON.parse(storage?.getItem(key) || 'null');
            if (previous?.browserState === 'saved' || previous?.browserState === 'requested') return previous;
        } catch {}
        let result;
        try {
            result = await save();
        } catch (error) {
            result = { browserState: 'failed', browserMessage: '自动下载失败，请点击节点下载按钮重试：' + (error?.message || '下载不可用') };
        }
        if (result.browserState !== 'failed') {
            try { storage?.setItem(key, JSON.stringify(result)); } catch {}
        }
        return result;
    })();
    deliveries.set(key, delivery);
    return delivery;
}
