import React, { useEffect, useState } from 'react';
import { ChevronDownIcon, FolderIcon, HistoryIcon } from './Icons';
import type { CanvasProject, ProjectSettings } from '../services/canvasProjectService';
import ProjectDirectoryAccess from './ProjectDirectoryAccess';
import { isProjectStorageReady } from '../services/browserProjectDirectory.mjs';

interface ProjectAutoSaveProps {
    project: CanvasProject | null; saving: boolean; saveStage?: string; busy: boolean; error: string; notice: string;
    onSave: () => Promise<unknown>; onConfigure: (settings: ProjectSettings) => Promise<unknown>;
    browserDirectoryMode?: boolean; directoryStatus?: string; onChooseDirectory?: () => Promise<boolean>;
    onPreserveDraftAndGoHome?: () => Promise<void>;
}

export default function ProjectAutoSave({ project, saving, saveStage, busy, error, notice, onSave, onConfigure, browserDirectoryMode, directoryStatus, onChooseDirectory, onPreserveDraftAndGoHome }: ProjectAutoSaveProps) {
    const [open, setOpen] = useState(false);
    const [minutes, setMinutes] = useState(5);
    const [maximum, setMaximum] = useState(5);
    useEffect(() => { if (project) { setMinutes(project.settings.intervalMinutes); setMaximum(project.settings.maxSnapshots); } }, [project?.id, project?.settings.intervalMinutes, project?.settings.maxSnapshots]);
    useEffect(() => {
        if (!open) return;
        const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
        window.addEventListener('keydown', close);
        return () => window.removeEventListener('keydown', close);
    }, [open]);
    if (!project) return null;
    const browserStorage = directoryStatus === 'browser';
    const needsPermission = browserDirectoryMode && !isProjectStorageReady(directoryStatus);
    const valid = Number.isInteger(minutes) && minutes >= 1 && minutes <= 120 && Number.isInteger(maximum) && maximum >= 1 && maximum <= 100;
    return (
        <div className="flex items-center gap-3" data-project-auto-save onMouseDown={event => event.stopPropagation()}>
            <span className="hidden max-w-[140px] truncate rounded-lg bg-zinc-950/70 px-3 py-2 text-xs text-zinc-400 xl:block" title={project.name}>{project.name}</span>
            {needsPermission && <button type="button" disabled={busy || saving} onClick={() => void onChooseDirectory?.()} className="rounded-xl border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs text-amber-100 disabled:opacity-40">重新授权文件夹</button>}
            <button onClick={() => setOpen(previous => !previous)} title={saving ? saveStage : undefined} aria-expanded={open} className="flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900/95 px-4 py-2.5 text-xs font-medium shadow-xl backdrop-blur">
                <span className={'h-1.5 w-1.5 rounded-full ' + (error ? 'bg-red-400' : saving ? 'animate-pulse bg-amber-300' : 'bg-emerald-300')} />{saving ? 'Saving…' : error ? 'Auto save · 失败' : 'Auto save'}<ChevronDownIcon className="h-3 w-3 text-zinc-500" />
            </button>
            {open && <section aria-label="自动保存设置" className="absolute right-0 top-full mt-3 w-[340px] max-w-[calc(100vw-32px)] rounded-2xl border border-zinc-700 bg-[#14161b] p-5 shadow-2xl">
                <div className="mb-5 flex items-center gap-2 text-sm font-semibold"><HistoryIcon className="h-4 w-4 text-cyan-200" />工程自动保存</div>
                <p data-auto-save-project-name className="mb-4 break-words text-xs text-cyan-100">当前工程：{project.name}</p>
                {saving && <p role="status" className="mb-3 text-xs text-amber-200">{saveStage || '正在保存工程'}</p>}
                <div className="grid grid-cols-2 gap-3">
                    <label className="text-xs text-zinc-400">保存频率（分钟）<input type="number" min="1" max="120" value={minutes} onChange={event => setMinutes(Number(event.target.value))} className="mt-2 w-full rounded-lg border border-zinc-700 bg-black/25 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400" /></label>
                    <label className="text-xs text-zinc-400">最大保存数目<input type="number" min="1" max="100" value={maximum} onChange={event => setMaximum(Number(event.target.value))} className="mt-2 w-full rounded-lg border border-zinc-700 bg-black/25 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400" /></label>
                </div>
                <p className="mt-3 text-[11px] leading-5 text-zinc-500">超出数目时仅删除此工程最旧的自动备份，始终保留最新文件。页面关闭或电脑休眠时暂停保存。</p>
                <div className="mt-4 rounded-xl border border-white/5 bg-black/20 p-3 text-[11px] leading-5 text-zinc-400"><p className="mb-1 flex items-center gap-1.5 text-zinc-300"><FolderIcon className="h-3 w-3" />当前保存位置</p><p className="break-all select-text">{project.directory}</p><p className="mt-2">上次保存：{new Date(project.lastSavedAt).toLocaleTimeString('zh-CN')}</p><p>已保留 {project.snapshotCount} {browserStorage ? '份浏览器快照' : '份 .js 备份'}</p>{browserStorage && <p className="mt-2">清除网站数据会丢失工程，请定期使用“导出项目”下载备份。</p>}</div>
                {(error || notice) && <p role={error ? 'alert' : 'status'} className={'mt-3 text-xs leading-5 ' + (error ? 'text-red-300' : 'text-zinc-400')}>{error || notice}</p>}
                {needsPermission && <div className="mt-3"><ProjectDirectoryAccess status={directoryStatus || 'permission'} directory={project.directory} busy={busy || saving} onChoose={() => void onChooseDirectory?.()} /></div>}
                {error && browserDirectoryMode && <button type="button" disabled={busy || saving} onClick={() => void onPreserveDraftAndGoHome?.()} className="mt-3 text-xs text-amber-100 underline disabled:opacity-40">保留临时草稿并返回首页</button>}
                {!valid && <p className="mt-2 text-xs text-amber-200">频率为 1–120 分钟，保存数目为 1–100。</p>}
                <div className="mt-4 flex gap-2"><button disabled={busy || saving} onClick={() => void onSave().catch(() => {})} className="flex-1 rounded-lg border border-zinc-600 py-2 text-xs text-zinc-200 disabled:opacity-40">立即保存</button><button disabled={!valid || busy || saving} onClick={() => void onConfigure({ intervalMinutes: minutes, maxSnapshots: maximum })} className="flex-1 rounded-lg bg-cyan-200 py-2 text-xs font-semibold text-zinc-950 disabled:opacity-40">应用设置</button></div>
            </section>}
        </div>
    );
}
