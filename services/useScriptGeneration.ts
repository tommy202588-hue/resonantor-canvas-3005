import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { NodeData } from '../types';
import type { AppSettings } from '../types/settings';
import type { ScriptDocument, ScriptGeneration } from '../types/storyboard';
import { createRandomId } from './randomId.mjs';
import { generateStoryboard } from './scriptGeneratorService';
import { updateScriptGeneration, interruptOrphanScriptGeneration, scriptGenerationError } from './scriptGenerationTask.mjs';

export function useScriptGeneration(nodes: NodeData[], setNodes: Dispatch<SetStateAction<NodeData[]>>, settings: AppSettings) {
    const current = useRef({ nodes, settings });
    current.current = { nodes, settings };
    const tasks = useRef(new Map<string, string>());
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    useEffect(() => {
        if (nodes.some(node => interruptOrphanScriptGeneration(node, tasks.current) !== node)) {
            setNodes(previous => previous.map(node => interruptOrphanScriptGeneration(node, tasks.current)));
        }
    }, [nodes, setNodes]);

    const hasRunningTask = nodes.some(node => node.scriptGeneration?.status === 'running');
    useEffect(() => {
        if (!hasRunningTask) return;
        const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
        window.addEventListener('beforeunload', beforeUnload);
        return () => window.removeEventListener('beforeunload', beforeUnload);
    }, [hasRunningTask]);

    return useCallback((nodeId: string, count: number, selection: string) => {
        if (tasks.current.has(nodeId)) return;
        const node = current.current.nodes.find(item => item.id === nodeId && item.type === 'script');
        if (!node?.script) return;
        const taskId = createRandomId();
        const document = structuredClone(node.script);
        const settingsSnapshot = current.current.settings;
        tasks.current.set(nodeId, taskId);
        setNodes(previous => previous.map(item => item.id === nodeId ? {
            ...item, status: 'loading', progress: 0,
            scriptGeneration: { id: taskId, status: 'running', progress: 0, stage: '正在校验原稿与模型配置' },
        } : item));
        const update = (task: Partial<ScriptGeneration>, result?: ScriptDocument) => {
            if (mounted.current && tasks.current.get(nodeId) === taskId) {
                setNodes(previous => updateScriptGeneration(previous, nodeId, taskId, task, result));
            }
        };
        void (async () => {
            try {
                const result = await generateStoryboard(document, count, settingsSnapshot, selection,
                    (progress, stage) => update({ progress, stage }));
                update({ status: 'success', progress: 100, stage: '分镜已生成', error: undefined }, result);
            } catch (error) {
                update({ status: 'error', stage: '分镜生成失败', error: scriptGenerationError(error) });
            } finally {
                if (tasks.current.get(nodeId) === taskId) tasks.current.delete(nodeId);
            }
        })();
    }, [setNodes]);
}
