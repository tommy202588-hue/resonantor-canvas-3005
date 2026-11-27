import React, { useEffect, useRef, useState } from 'react';
import { PlusIcon, FolderIcon, UploadIcon, XIcon, EditIcon, Trash2Icon, CheckIcon, HomeIcon, LoginIcon, GridIcon, MonitorIcon, CubeIcon, TrophyIcon } from './Icons';
import { useCanvasSession } from './CanvasSessionProvider';
import type { CanvasProject } from '../services/canvasProjectService';
import { DEFAULT_PROJECT_SETTINGS } from '../services/projectFile.mjs';
import './ProjectHome.css';
import DesktopSaveGuide from './DesktopSaveGuide';
import ProjectDirectoryAccess from './ProjectDirectoryAccess';
import { isProjectStorageReady } from '../services/browserProjectDirectory.mjs';

interface ProjectHomeProps {
    projects: CanvasProject[];
    directory: string;
    loading: boolean;
    busy: boolean;
    operationStage?: string;
    error: string;
    notice: string;
    hasLegacyDraft: boolean;
    needsDesktopCompanion?: boolean;
    standalone?: boolean;
    browserDirectoryMode?: boolean;
    directoryStatus?: string;
    onChooseDirectory?: (change?: boolean) => Promise<boolean>;
    onCreate: (name: string) => Promise<unknown>;
    onOpen: (id: string) => void;
    onImport: () => void;
    onRefresh: () => void;
    onRecover: () => void;
    onRename: (project: CanvasProject, name: string) => Promise<boolean>;
    onDelete: (project: CanvasProject) => Promise<boolean>;
}

type ProjectDialog = { type: 'create' } | { type: 'rename' | 'delete'; projectId: string };
const singleHtmlAssets = (globalThis as any).__RESONANTOR_SINGLE_HTML_ASSETS__ as Record<string, string> | undefined;
const brandAsset = (name: string) => singleHtmlAssets?.[name] || (import.meta.env.BASE_URL || '/') + 'brand/' + name;

export default function ProjectHome(props: ProjectHomeProps) {
    const [dialog, setDialog] = useState<ProjectDialog | null>(null);
    const [name, setName] = useState('');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [videoReady, setVideoReady] = useState(false);
    const session = useCanvasSession();
    const videoRef = useRef<HTMLVideoElement>(null);
    const selected = props.projects.find(project => project.id === selectedId);
    const dialogProject = dialog && dialog.type !== 'create' ? props.projects.find(project => project.id === dialog.projectId) : null;
    const runWhenAllowed = (action: () => unknown) => props.standalone ? action() : session.requireLogin(action);
    const beginCreate = () => void runWhenAllowed(() => { setName('未命名工程'); setDialog({ type: 'create' }); });
    const beginRename = (project: CanvasProject) => void runWhenAllowed(() => { setName(project.name); setDialog({ type: 'rename', projectId: project.id }); });
    const browserStorage = props.directoryStatus === 'browser';
    const creationBlocked = props.busy || (props.loading && !browserStorage);
    const directoryBlocked = props.browserDirectoryMode && !isProjectStorageReady(props.directoryStatus);
    const chooseDirectory = (change = false) => {
        if (!session.user) { session.requestLogin(); return; }
        void props.onChooseDirectory?.(change);
    };

    useEffect(() => { if (!session.user) setDialog(null); }, [session.user]);

    useEffect(() => {
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
        const mountedVideo = videoRef.current;
        const synchronize = () => {
            const video = videoRef.current;
            if (!video) return;
            if (document.hidden || reducedMotion.matches) video.pause();
            else void video.play().catch(() => {});
        };
        synchronize();
        document.addEventListener('visibilitychange', synchronize);
        reducedMotion.addEventListener('change', synchronize);
        return () => {
            mountedVideo?.pause();
            document.removeEventListener('visibilitychange', synchronize);
            reducedMotion.removeEventListener('change', synchronize);
        };
    }, []);

    useEffect(() => {
        if (selectedId && !props.projects.some(project => project.id === selectedId)) setSelectedId(null);
    }, [props.projects, selectedId]);

    useEffect(() => {
        if (!dialog) return;
        const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !props.busy) setDialog(null); };
        window.addEventListener('keydown', close);
        return () => window.removeEventListener('keydown', close);
    }, [dialog, props.busy]);

    const submitDialog = async (event: React.FormEvent) => {
        event.preventDefault();
        if (props.busy || !dialog) return;
        if (props.needsDesktopCompanion) return;
        if (directoryBlocked) return;
        if (dialog.type === 'create') {
            if (name.trim()) await props.onCreate(name.trim());
        } else if (dialogProject) {
            if (dialog.type === 'rename' && name.trim()) {
                if (await props.onRename(dialogProject, name.trim())) setDialog(null);
            } else if (dialog.type === 'delete' && await props.onDelete(dialogProject)) {
                setSelectedId(null);
                setDialog(null);
            }
        }
    };

    return (
        <main className="project-home h-screen overflow-y-auto text-zinc-100">
            <div className="home-media" style={{ backgroundImage: 'url(' + brandAsset('home-flow-poster.jpg') + ')' }} aria-hidden="true">
                <video ref={videoRef} data-home-background-video className={videoReady ? 'is-ready' : ''} src={brandAsset('home-flow.mp4')} poster={brandAsset('home-flow-poster.jpg')} autoPlay muted loop playsInline preload="auto" onLoadedData={() => setVideoReady(true)} onError={() => setVideoReady(false)} />
            </div>
            <div className="home-media-veil" aria-hidden="true" />
            <header className="home-header px-7 sm:px-12">
                <div className="home-header-brand" aria-label="共智体 RESONA">
                    <img src={brandAsset('resona-logo.webp')} alt="" width={48} height={48} className="home-brand-logo" />
                    <img src={brandAsset('resona-wordmark.svg')} alt="共智体 RESONA" width={96} height={48} className="home-brand-wordmark" />
                </div>
                <nav aria-label="主导航" className="home-header-nav">
                    <button type="button" aria-current="page" className="home-header-action home-nav-current" onClick={event => event.currentTarget.closest('main')?.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}><HomeIcon /><span>主页</span></button>
                    <button type="button" disabled title="应用市场尚未开放" className="home-header-action"><CubeIcon /><span>应用市场</span></button>
                    <button type="button" className="home-header-action" onClick={() => document.getElementById('recent-projects-title')?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}><GridIcon /><span>工作空间</span></button>
                    <button type="button" disabled title="ResonTV 尚未开放" className="home-header-action"><MonitorIcon /><span>ResonTV</span></button>
                    <button type="button" disabled title="竞技场尚未开放" className="home-header-action"><TrophyIcon /><span>竞技场</span></button>
                </nav>
                <button type="button" className="home-glass home-header-action home-header-login" aria-haspopup="dialog" title={props.standalone ? '浏览器本地模式' : session.user?.username} onClick={props.standalone ? undefined : session.requestLogin}>{!session.user && !props.standalone && <LoginIcon className="text-white/65" />}<span className="max-w-[160px] truncate">{props.standalone ? '本地模式' : session.user ? session.user.username : '登录 / 注册'}</span></button>
            </header>

            <div className="home-content mx-auto max-w-[1320px] px-7 pb-16 sm:px-12">
                <section className="home-hero pb-16 pt-20 text-center sm:pb-20 sm:pt-24">
                    <p className="mb-5 text-[10px] font-semibold tracking-[.35em] text-cyan-100/70">IMAGINATION, IN MOTION</p>
                    <h1 className="home-flow-heading">
                        <span className="sr-only">Do something amazing.</span>
                        <span className="home-flow-title" aria-hidden="true" style={{ '--home-title-mask': `url("${brandAsset('home-title-mask.png')}")` } as React.CSSProperties} />
                    </h1>
                    <p className="mt-5 text-sm text-white/55">从一个想法开始，在无限画布上创造。每一份灵感，都留在你的电脑里。</p>
                    <div className="mt-8 flex justify-center gap-3">
                        <button onClick={beginCreate} disabled={creationBlocked} className="home-primary flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold text-zinc-950 disabled:opacity-40"><PlusIcon className="h-4 w-4" />新建工程</button>
                        <button onClick={() => props.needsDesktopCompanion ? beginCreate() : runWhenAllowed(props.onImport)} disabled={creationBlocked} className="home-glass home-glass-action flex items-center gap-2 rounded-xl px-5 py-3 text-sm text-white/80 disabled:opacity-40"><UploadIcon className="h-4 w-4" />导入工程</button>
                    </div>
                </section>

                {props.browserDirectoryMode && <div className="mb-6"><ProjectDirectoryAccess status={props.directoryStatus || 'unselected'} directory={props.directory} busy={props.busy || props.loading} onChoose={chooseDirectory} allowChange /></div>}
                {props.error && <div role="alert" className="home-glass mb-6 flex items-center justify-between gap-4 rounded-2xl p-4 text-sm text-red-200"><span>{props.error}</span><button onClick={() => void session.requireLogin(props.onRefresh)} className="shrink-0 underline">{props.browserDirectoryMode ? '刷新项目' : '重试连接'}</button></div>}
                {props.notice && <p role="status" className="mb-6 text-xs leading-6 text-cyan-100/70">{props.notice}</p>}
                {props.needsDesktopCompanion && <div className="home-glass mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl p-4 text-sm text-cyan-100"><div><p>让工程留在你自己的电脑</p><p className="mt-1 text-xs text-white/60">首次运行本机保存启动器，之后新建与自动保存都写入你的桌面。无需安装 ComfyUI。</p></div><button onClick={beginCreate} className="rounded-xl bg-cyan-200/10 px-4 py-2">设置本机保存</button></div>}
                {props.hasLegacyDraft && <div className="home-glass mb-7 flex flex-wrap items-center justify-between gap-3 rounded-2xl p-4 text-sm"><div><p className="text-cyan-100">发现之前的画布草稿</p><p className="mt-1 text-xs text-white/55">原有内容已保留，可恢复并保存为本地工程。</p></div><button onClick={() => props.needsDesktopCompanion ? beginCreate() : runWhenAllowed(props.onRecover)} disabled={props.busy || props.loading} className="rounded-lg bg-cyan-200/10 px-4 py-2 text-cyan-100 disabled:opacity-40">恢复草稿</button></div>}

                <section aria-labelledby="recent-projects-title">
                    {!session.user && !props.standalone && <button type="button" onClick={session.requestLogin} className="home-glass mb-5 w-full rounded-2xl p-4 text-left text-sm text-cyan-100">登录后查看和打开画布工程 · 点击登录 / 微信注册</button>}
                    <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
                        <div className="flex items-baseline gap-3"><h2 id="recent-projects-title" className="text-xl font-semibold tracking-tight">最近项目</h2><span className="text-xs text-white/45">{props.projects.length} 个本地工程</span></div>
                        <div className="flex items-center gap-4">
                            <button onClick={() => selected && void runWhenAllowed(() => setDialog({ type: 'delete', projectId: selected.id }))} disabled={!selected || props.busy} className="home-glass flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-rose-200 transition hover:bg-rose-300/10 disabled:cursor-not-allowed disabled:text-white/25"><Trash2Icon className="h-3.5 w-3.5" />删除选中工程</button>
                            <button onClick={() => void session.requireLogin(props.onRefresh)} disabled={props.busy || props.loading} className="text-xs text-white/55 hover:text-white disabled:opacity-40">{props.loading ? '正在读取…' : '刷新项目 ↻'}</button>
                        </div>
                    </div>
                    <div className="grid grid-cols-1 gap-x-5 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        <button onClick={beginCreate} disabled={creationBlocked} className="group text-left disabled:opacity-40">
                            <div className="home-glass home-create-tile flex aspect-[1.45] flex-col items-center justify-center gap-3 rounded-[22px]"><span className="home-glass flex h-12 w-12 items-center justify-center rounded-2xl text-white/60 transition group-hover:text-cyan-100"><PlusIcon className="h-6 w-6" /></span><span className="text-xs text-white/45">让下一个想法在这里发生</span></div>
                            <p className="mt-3 px-1 text-sm font-medium text-white/90">新建工程</p><p className="mt-1 px-1 text-[11px] text-white/40">一张空白画布，无限可能</p>
                        </button>
                        {props.projects.map(project => (
                            <article key={project.id} data-project-id={project.id} className={'home-project-card group min-w-0 ' + (selectedId === project.id ? 'is-selected' : '')}>
                                <div className="home-glass relative aspect-[1.45] overflow-hidden rounded-[22px] transition duration-200 group-hover:shadow-xl">
                                    <button aria-label={'打开工程：' + project.name} onClick={() => void runWhenAllowed(() => props.onOpen(project.id))} disabled={props.busy} className="absolute inset-0 h-full w-full text-left disabled:opacity-50">
                                        {project.thumbnail ? <img src={project.thumbnail} alt={project.name + ' 工程预览'} className="h-full w-full object-cover transition duration-300 group-hover:scale-105" /> : <div className="flex h-full items-center justify-center"><div className="relative flex gap-3 opacity-65"><span className="home-glass mt-7 h-14 w-10 rounded-lg" /><span className="home-glass h-20 w-14 rounded-xl" /><span className="home-glass mt-4 h-16 w-11 rounded-lg" /></div></div>}
                                        <span className="absolute left-3 top-3 rounded-lg bg-black/30 px-2 py-1 text-[10px] text-white/80 backdrop-blur-lg">{project.nodeCount} 个节点</span>
                                        <span className="absolute bottom-3 right-3 rounded-full bg-black/30 px-2 py-1 text-[10px] text-white/75 backdrop-blur-lg">本地工程 ↗</span>
                                    </button>
                                    <button role="checkbox" aria-checked={selectedId === project.id} aria-label={'选择工程：' + project.name} onClick={() => setSelectedId(previous => previous === project.id ? null : project.id)} disabled={props.busy} className={'absolute right-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-lg border backdrop-blur-lg transition ' + (selectedId === project.id ? 'border-cyan-100 bg-cyan-200 text-zinc-950' : 'border-white/35 bg-black/25 text-transparent hover:border-cyan-100')}><CheckIcon className="h-4 w-4" /></button>
                                </div>
                                <button onClick={() => beginRename(project)} disabled={props.busy} aria-label={'重命名工程：' + project.name} title="点击重命名工程" className="mt-3 flex w-full min-w-0 items-center justify-between gap-2 px-1 text-left text-sm font-medium text-white/90 hover:text-cyan-100"><span className="truncate">{project.name}</span><EditIcon className="h-3.5 w-3.5 shrink-0 text-white/45" /></button>
                                <p className="mt-1 px-1 text-[11px] text-white/45">{new Date(project.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · {project.snapshotCount} 份备份</p>
                            </article>
                        ))}
                    </div>
                </section>
                <footer className="mt-16 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-6 text-[11px] text-white/40"><span className="flex items-center gap-2" title={props.directory}><FolderIcon className="h-3.5 w-3.5" />{props.browserDirectoryMode ? props.directory || '尚未授权本机工程文件夹' : '桌面 / 共智体画布工程'}</span><span>每 {DEFAULT_PROJECT_SETTINGS.intervalMinutes} 分钟保存 · 新工程默认保留 {DEFAULT_PROJECT_SETTINGS.maxSnapshots} 份</span></footer>
            </div>

            {dialog && <div role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-6 backdrop-blur-md">
                {props.needsDesktopCompanion && dialog.type === 'create' ? <DesktopSaveGuide onClose={() => setDialog(null)} /> : <form onSubmit={event => void submitDialog(event)} className="home-glass home-dialog w-full max-w-md rounded-3xl p-7 shadow-2xl">
                    <div className="mb-6 flex items-center justify-between"><h2 id="project-dialog-title" className="text-xl font-semibold">{dialog.type === 'create' ? '新建工程' : dialog.type === 'rename' ? '重命名工程' : '删除选中工程'}</h2><button type="button" aria-label="关闭工程弹窗" onClick={() => setDialog(null)} disabled={props.busy}><XIcon className="h-5 w-5 text-white/50" /></button></div>
                    {dialog.type === 'delete' ? <div className="space-y-3 text-sm leading-6 text-white/70"><p>确认删除工程「<strong className="break-all text-white">{dialogProject?.name || '工程已不存在'}</strong>」？</p><p className="text-xs text-white/50">{browserStorage ? '它将从当前浏览器的最近项目中移除，不影响已下载的工程备份。需要时可重新导入备份。' : props.browserDirectoryMode ? '它将从最近项目中移除，工程文件和 .js 备份仍保留在原目录，不会永久擦除。之后可导入 .js 文件恢复。' : '它将从最近项目中移除，工程文件和备份会移入“已删除工程”目录，不会永久擦除。之后仍可导入其中的 .js 文件恢复。'}</p></div> : <>
                        <label className="block text-xs text-white/60">工程名称<input autoFocus value={name} maxLength={80} onChange={event => setName(event.target.value)} onFocus={event => event.target.select()} className="mt-2 w-full rounded-xl border border-white/20 bg-black/25 px-4 py-3 text-sm text-white outline-none focus:border-cyan-200/60" /></label>
                        <p className="mt-4 text-xs leading-6 text-white/50">{dialog.type === 'create' ? browserStorage ? '工程保存在当前电脑的浏览器中。默认每 5 分钟保存，最多保留 5 份快照；可通过“导出项目”下载文件备份。清除网站数据会丢失工程。' : props.browserDirectoryMode ? '工程保存在你授权的本机文件夹，不上传到服务器。默认每 5 分钟保存一份 .js 快照，最多保留 5 份。' : '工程保存在桌面的“共智体画布工程”文件夹。默认每 5 分钟保存一份 .js 快照，最多保留 5 份。' : '名称会同步到画布的 Auto save 和后续工程备份，已有图片、节点与备份保持不变。'}</p>
                    </>}
                    {directoryBlocked && <div className="mt-4"><ProjectDirectoryAccess status={props.directoryStatus || 'unselected'} directory={props.directory} busy={props.busy || props.loading} onChoose={chooseDirectory} /></div>}
                    {props.error && <p role="alert" className="mt-3 text-xs text-red-200">{props.error}</p>}
                    {props.busy && <p role="status" className="mt-3 text-xs text-cyan-100">{props.operationStage || '正在处理工程'}</p>}
                    <div className="mt-6 flex gap-3"><button type="button" onClick={() => setDialog(null)} disabled={props.busy} className="home-glass flex-1 rounded-xl py-3 text-sm text-white/70 disabled:opacity-40">取消</button><button type="submit" disabled={props.busy || directoryBlocked || (dialog.type === 'delete' ? !dialogProject : !name.trim())} className={'flex-1 rounded-xl py-3 text-sm font-semibold disabled:opacity-40 ' + (dialog.type === 'delete' ? 'bg-rose-400/90 text-zinc-950 hover:bg-rose-300' : 'home-primary text-zinc-950')}>{props.busy ? '处理中…' : dialog.type === 'create' ? '创建并打开' : dialog.type === 'rename' ? '保存名称' : '确认删除'}</button></div>
                </form>}
            </div>}

        </main>
    );
}
