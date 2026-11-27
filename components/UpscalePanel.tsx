import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { NodeData } from '../types';
import { apiPath } from '../services/apiClient';
import { UpscaleOptions, UpscaleRuntime, getUpscaleRuntime, startUpscaleRuntime, readUpscaleSource, upscaleSizeError } from '../services/upscaleService';

interface UpscalePanelProps {
    node: NodeData;
    busy: boolean;
    onClose: () => void;
    onSubmit: (options: UpscaleOptions) => Promise<void>;
}

export default function UpscalePanel({ node, busy, onClose, onSubmit }: UpscalePanelProps) {
    const [scale, setScale] = useState<2 | 4>(2);
    const [runtime, setRuntime] = useState<UpscaleRuntime | null>(null);
    const [checking, setChecking] = useState(false);
    const [starting, setStarting] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [size, setSize] = useState({ width: 0, height: 0 });
    const check = async () => {
        setChecking(true);
        try { setRuntime(await getUpscaleRuntime()); setError(''); }
        catch (error: any) { setRuntime(null); setError(error.message); }
        finally { setChecking(false); }
    };

    useEffect(() => {
        let active = true;
        void check();
        readUpscaleSource(node.blob || node.content || '').then(result => {
            if (active) setSize({ width: result.width, height: result.height });
        }).catch(error => { if (active) setError(error.message); });
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
        };
        window.addEventListener('keydown', onKey, true);
        return () => { active = false; window.removeEventListener('keydown', onKey, true); };
    }, [node.id]);

    const sizeError = upscaleSizeError(size.width, size.height, scale);
    const ready = runtime?.faithfulReady && runtime.imageProcessorReady !== false;
    const missing = runtime?.missingFaithful;
    const start = async () => {
        setStarting(true); setError('');
        try { setRuntime(await startUpscaleRuntime()); }
        catch (error: any) { setError(error.message); }
        finally { setStarting(false); }
    };

    return createPortal(
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" onMouseDown={event => event.stopPropagation()} onClick={event => { if (event.target === event.currentTarget && !submitting) onClose(); }}>
            <section role="dialog" aria-modal="true" aria-labelledby="upscale-title" className="w-full max-w-lg rounded-2xl border border-zinc-700 bg-[#18181b] p-6 text-zinc-100 shadow-2xl">
                <div className="mb-5 flex items-center justify-between">
                    <div><h2 id="upscale-title" className="text-lg font-semibold">高清放大</h2><p className="mt-1 text-xs text-zinc-400">服务端 GPU 处理 · 保留原图 · PNG 返回画布并自动下载</p></div>
                    <button aria-label="关闭高清放大" onClick={onClose} className="rounded-lg px-3 py-2 text-zinc-400 hover:bg-zinc-800">✕</button>
                </div>
                <div className="mb-4 rounded-xl border border-cyan-400/40 bg-cyan-500/10 p-3">
                    <span className="text-sm font-medium text-cyan-200">SeedVR2 高清放大</span>
                    <p className="mt-1 text-xs text-zinc-400">SeedVR2 v2.5.1 · 自动按原图尺寸生成 2×／4× 图片</p>
                    {runtime?.gpuServer && <p className="mt-2 text-xs text-cyan-100/80">当前 GPU：{runtime.gpuServer.name} · {runtime.gpuServer.kind === 'local' ? '服务器自动托管' : '内网远程服务'}</p>}
                    <p className="mt-2 text-xs text-amber-200/80">AI 会重建细节，可能改变文字、面部或局部纹理。</p>
                </div>
                <div className="mb-4 flex items-center gap-3 text-sm"><span className="mr-auto text-zinc-400">放大倍率</span>{([2, 4] as const).map(value => <button key={value} aria-pressed={scale === value} onClick={() => setScale(value)} className={'rounded-lg border px-5 py-2 ' + (scale === value ? 'border-cyan-400 text-cyan-200' : 'border-zinc-700')}>{value}×</button>)}</div>
                <div className="mb-4 rounded-lg bg-zinc-900 px-3 py-2 text-center text-sm tabular-nums">{size.width || '…'} × {size.height || '…'} <span className="mx-3 text-zinc-500">→</span> {size.width * scale || '…'} × {size.height * scale || '…'}</div>
                <p className="mb-4 text-xs leading-5 text-zinc-400">按原图尺寸放大，不自动缩小。大图会占用更多内存和显存，耗时更长；资源不足时可改用 2×。</p>
                <div className="mb-4 rounded-lg border border-zinc-800 p-3 text-xs">
                    <div className="flex items-center justify-between gap-2"><span className={ready ? 'text-emerald-300' : 'text-zinc-400'}>{checking ? '正在检测 ComfyUI…' : runtime?.running ? ready ? 'ComfyUI 与模型已就绪' : 'ComfyUI 已运行，依赖尚未齐全' : 'ComfyUI 未连接'}</span><button disabled={checking || starting} onClick={check} className="text-cyan-300 disabled:opacity-40">重新检测</button></div>
                    {!!missing?.length && <p className="mt-2 break-words leading-relaxed text-amber-200">缺少：{missing.join('、')}</p>}
                    {runtime?.error && <p className="mt-2 break-words leading-relaxed text-amber-200">ComfyUI：{runtime.error.message}</p>}
                    {runtime?.imageProcessorError && <p className="mt-2 break-words leading-relaxed text-amber-200">{runtime.imageProcessorError}</p>}
                    {runtime && !runtime.running && runtime.startSupported !== false && <button disabled={starting || checking} onClick={start} className="mt-3 w-full rounded-lg bg-zinc-700 px-3 py-2 hover:bg-zinc-600 disabled:opacity-50">{starting ? '正在启动，最多约 120 秒…' : '一键启动 ComfyUI'}</button>}
                    {runtime && !runtime.running && runtime.startSupported === false && <p className="mt-2 leading-5 text-amber-200">{runtime.gpuServer?.kind === 'remote' ? '当前 GPU 是远程服务。请确认该 GPU 主机已启动 ComfyUI，且本服务端可通过受信任内网连接。' : '发布服务器没有可自动启动的本机 ComfyUI。请管理员配置可连接的 GPU 服务。'} <a className="ml-1 text-cyan-200 underline" href={apiPath('/admin/gpu')}>打开 GPU 服务设置</a></p>}
                </div>
                {(error || sizeError || busy) && <p role="alert" className="mb-3 text-xs leading-relaxed text-amber-200">{error || sizeError || '已有高清放大任务，请等待完成或取消后再试。'}</p>}
                <button disabled={!ready || !!sizeError || busy || submitting || starting || checking} onClick={async () => {
                    setSubmitting(true); setError('');
                    try { await onSubmit({ mode: 'faithful', scale }); onClose(); }
                    catch (error: any) { setError(error.message); }
                    finally { setSubmitting(false); }
                }} className="w-full rounded-xl bg-cyan-500 py-3 text-sm font-semibold text-zinc-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-35">{submitting ? '正在提交…' : '开始高清放大'}</button>
            </section>
        </div>, document.body,
    );
}
