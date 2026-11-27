import { createRandomId } from './randomId.mjs';
import { useCallback, useEffect, useRef, useState, Dispatch, SetStateAction } from 'react';
import { NodeData } from '../types';
import { deliverProcessedImageOnce } from './processedImageDownload.mjs';
import { UpscaleOptions, UPSCALE_STAGES, imageTaskLabel, submitUpscaleJob, getUpscaleJob, getUpscaleImage, cancelUpscaleJob, readUpscaleSource, upscaleSizeError } from './upscaleService';

export function useUpscaleTasks(nodes: NodeData[], setNodes: Dispatch<SetStateAction<NodeData[]>>, displaySize: (width: number, height: number) => { width: number; height: number }, selectNode: (id: string) => void, saveResult: (blob: Blob, filename: string) => Promise<{ browserState: 'saved' | 'requested'; browserMessage: string }>, enabled = true, onResultCreated?: () => void) {
    const [sourceId, setSourceId] = useState<string | null>(null);
    const current = useRef(nodes);
    current.current = nodes;
    const saveResultRef = useRef(saveResult);
    saveResultRef.current = saveResult;
    const submitting = useRef(false);
    const activeIds = nodes.filter(node => node.upscale && node.status === 'loading' && node.taskId).map(node => node.id + ':' + node.taskId).sort().join('|');

    useEffect(() => {
        if (!enabled || !activeIds) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const missingCounts = new Map<string, number>();
        const poll = async () => {
            for (const node of current.current.filter(item => item.upscale && item.status === 'loading' && item.taskId)) {
                if (controller.signal.aborted) return;
                const taskId = node.taskId!;
                const label = imageTaskLabel(node.upscale?.mode);
                const update = (changes: Partial<NodeData>) => {
                    if (!controller.signal.aborted) setNodes(previous => previous.map(item => item.id === node.id && item.taskId === taskId ? { ...item, ...changes } : item));
                };
                try {
                    const job = await getUpscaleJob(taskId, controller.signal);
                    missingCounts.delete(taskId);
                    if (job.state === 'success') {
                        const blob = await getUpscaleImage(taskId, controller.signal);
                        if (controller.signal.aborted) return;
                        const filename = job.download?.filename || (job.options.mode === 'remove-background' ? '去背景-' : '高清放大-' + job.options.scale + 'x-') + taskId + '.png';
                        const delivery = await deliverProcessedImageOnce(taskId, () => saveResultRef.current(blob, filename));
                        if (controller.signal.aborted) return;
                        const width = job.dimensions!.outputWidth;
                        const height = job.dimensions!.outputHeight;
                        const content = URL.createObjectURL(blob);
                        update({ blob, content, ...displaySize(width, height), imageWidth: width, imageHeight: height,
                            title: job.options.mode === 'remove-background' ? '去背景' : (job.engine === 'seedvr2-2.5.1' ? 'SeedVR2 高清放大 ' : '高清放大 ') + job.options.scale + '×',
                            status: 'success', progress: 100, errorDetails: undefined,
                            executionTime: (job.finishedAt || Date.now()) - job.createdAt,
                            upscale: { ...node.upscale!, engine: job.engine, seed: job.seed, gpuServer: job.gpuServer && { id: job.gpuServer.id, name: job.gpuServer.name, kind: job.gpuServer.kind }, stage: 'success', download: { ...job.download, ...delivery } },
                        });
                    } else if (job.state === 'error' || job.state === 'cancelled') {
                        update({ status: 'error', progress: undefined, title: label + (job.state === 'cancelled' ? '已取消' : '失败'),
                            errorDetails: job.error?.message || '任务已取消，可点击重试。', upscale: { ...node.upscale!, stage: job.state } });
                    } else {
                        const stage = job.warning ? 'reconnecting' : job.state;
                        const title = label + ' · ' + UPSCALE_STAGES[stage];
                        if (node.upscale?.stage !== stage || node.title !== title) update({ title, progress: undefined, upscale: { ...node.upscale!, stage }, errorDetails: job.warning });
                    }
                } catch (error: any) {
                    if (controller.signal.aborted) return;
                    if (error.status === 404) {
                        const count = (missingCounts.get(taskId) || 0) + 1;
                        missingCounts.set(taskId, count);
                        if (count >= 300) update({ status: 'error', title: label + '任务未找到', errorDetails: error.message, upscale: { ...node.upscale!, stage: 'error' } });
                    } else if (error.status === 403) {
                        update({ status: 'error', title: '无法恢复' + label + '任务', errorDetails: error.message, upscale: { ...node.upscale!, stage: 'error' } });
                    } else if (node.upscale?.stage !== 'reconnecting') {
                        update({ title: label + ' · 等待连接恢复', upscale: { ...node.upscale!, stage: 'reconnecting' }, errorDetails: error.message });
                    }
                }
            }
            if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
        };
        timer = setTimeout(poll, 1000);
        return () => { controller.abort(); clearTimeout(timer); };
    }, [activeIds, setNodes, displaySize, enabled]);

    const submit = useCallback(async (sourceNodeId: string, options: UpscaleOptions, retryNodeId?: string) => {
        if (submitting.current || current.current.some(node => node.upscale && node.status === 'loading')) throw new Error('已有图片处理任务，请等待完成或取消后再试。');
        const source = current.current.find(node => node.id === sourceNodeId);
        if (!source?.content) throw new Error('原图已被删除，请重新上传图片。');
        submitting.current = true;
        let resultId: string | undefined;
        let jobId: string | undefined;
        const label = imageTaskLabel(options.mode);
        try {
            const image = await readUpscaleSource(source.blob || source.content);
            const sizeError = upscaleSizeError(image.width, image.height, options.scale, options.mode);
            if (sizeError) throw new Error(sizeError);
            jobId = createRandomId();
            resultId = retryNodeId || 'upscale-' + jobId;
            const result: NodeData = {
                id: resultId, type: 'image', position: { x: source.position.x + source.width + 48, y: source.position.y },
                ...displaySize(image.width * options.scale, image.height * options.scale),
                title: label + ' · 提交任务', status: 'loading', selected: true, taskId: jobId, startTime: Date.now(),
                upscale: { sourceNodeId, ...options, stage: 'submitting' },
            };
            if (!retryNodeId) onResultCreated?.();
            setNodes(previous => retryNodeId
                ? previous.map(node => node.id === retryNodeId ? { ...result, position: node.position } : { ...node, selected: false })
                : [...previous.map(node => ({ ...node, selected: false })), result]);
            selectNode(resultId);
            const job = await submitUpscaleJob(jobId, image.blob, options);
            setNodes(previous => previous.map(node => node.id === resultId && node.taskId === jobId && node.status === 'loading'
                ? { ...node, title: label + ' · ' + UPSCALE_STAGES[job.state], upscale: { ...node.upscale!, engine: job.engine, seed: job.seed, gpuServer: job.gpuServer && { id: job.gpuServer.id, name: job.gpuServer.name, kind: job.gpuServer.kind }, stage: job.state } } : node));
        } catch (error: any) {
            const uncertain = resultId && (!error.status && /fetch|network|timeout|abort/i.test(error.message + ' ' + error.name));
            if (resultId) setNodes(previous => previous.map(node => node.id === resultId && node.taskId === jobId && node.status === 'loading'
                ? { ...node, status: uncertain ? 'loading' : 'error', title: label + (uncertain ? ' · 确认任务状态' : '失败'), errorDetails: error.message,
                    upscale: { ...node.upscale!, stage: uncertain ? 'reconnecting' : 'error' } } : node));
            if (!uncertain) throw error;
        } finally { submitting.current = false; }
    }, [setNodes, displaySize, selectNode, onResultCreated]);

    const cancel = useCallback(async (nodeId: string) => {
        const node = current.current.find(item => item.id === nodeId);
        if (!node?.taskId) return;
        try { await cancelUpscaleJob(node.taskId); }
        catch (error: any) {
            setNodes(previous => previous.map(item => item.id === nodeId ? { ...item, errorDetails: '取消失败：' + error.message } : item));
        }
    }, [setNodes]);

    const retry = useCallback(async (nodeId: string) => {
        const node = current.current.find(item => item.id === nodeId);
        if (!node?.upscale) return;
        try {
            if (node.upscale.mode === 'remove-background') {
                await submit(node.upscale.sourceNodeId, { mode: 'remove-background', scale: 1 }, nodeId);
            } else if (node.upscale.mode === 'faithful' && node.upscale.scale !== 1) {
                await submit(node.upscale.sourceNodeId, { mode: 'faithful', scale: node.upscale.scale }, nodeId);
            } else throw new Error('旧版重绘增强已移除，请选择原图使用高清放大。');
        }
        catch (error: any) {
            setNodes(previous => previous.map(item => item.id === nodeId ? { ...item, errorDetails: error.message } : item));
        }
    }, [submit, setNodes]);

    return { sourceId, open: setSourceId, submit, cancel, retry, busy: Boolean(activeIds) };
}
