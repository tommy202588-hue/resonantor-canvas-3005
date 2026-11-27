import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { set, del } from 'idb-keyval';
import { updateProjectRecord, getProjectRecord as get, getProjectKeys as keys } from './projectStorageUpdate.mjs';
import { prepareProjectSave, boundedPreparation } from './projectSavePipeline.mjs';
import { createBrowserProjectData, createSerializableProjectData, loadProjectFromIndexedDB, restoreProjectData, ProjectData } from './storageService';
import { CanvasProject, ProjectSettings, listCanvasProjects, openCanvasProject, createCanvasProject, saveCanvasProject, configureCanvasProject, renameCanvasProject, deleteCanvasProject } from './canvasProjectService';
import { startProjectAutosave } from './projectAutosave.mjs';
import { isSingleHtmlRuntime, isBrowserProjectRuntime } from './runtimeMode';
import { createBrowserProjectDirectory, isProjectStorageReady } from './browserProjectDirectory.mjs';
import { listSingleHtmlProjects, openSingleHtmlProject, createSingleHtmlProject, saveSingleHtmlProject, configureSingleHtmlProject, renameSingleHtmlProject, deleteSingleHtmlProject } from './singleHtmlProjectService';

const LEGACY_DRAFT = 'gzt-legacy-canvas-draft';
const emptyProject = (): ProjectData => ({ nodes: [], connections: [], groups: [], viewport: { x: 0, y: 0, k: 1 }, version: 1 });

async function serialize(data: ProjectData, preserveBlobs = false, signal?: AbortSignal) {
    return preserveBlobs
        ? createBrowserProjectData(data.nodes, data.connections, data.viewport, data.groups || [], { signal })
        : createSerializableProjectData(data.nodes, data.connections, data.viewport, data.groups || [], false, { signal });
}

async function thumbnail(data: ProjectData) {
    const node = data.nodes.find(item => item.type === 'image' && (item.blob || /^(blob:|data:image)/.test(item.content || '')));
    if (!node) return '';
    try {
        const blob = node.blob || await (await fetch(node.content!)).blob();
        const bitmap = await createImageBitmap(blob, { resizeWidth: 480, resizeQuality: 'low' });
        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = 300;
        const context = canvas.getContext('2d')!;
        context.fillStyle = '#191b20';
        context.fillRect(0, 0, 480, 300);
        const scale = Math.min(480 / bitmap.width, 300 / bitmap.height);
        context.drawImage(bitmap, (480 - bitmap.width * scale) / 2, (300 - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale);
        bitmap.close();
        return canvas.toDataURL('image/jpeg', 0.72);
    } catch { return ''; }
}

export function useCanvasProjects(snapshot: ProjectData, getSnapshot: () => ProjectData, applySnapshot: (data: ProjectData) => void, showCanvas: () => void, showHome: () => void, enabled = true, accountId = '') {
    const localMode = isSingleHtmlRuntime();
    const browserDirectoryMode = isBrowserProjectRuntime();
    const browserDirectory = useMemo(() => browserDirectoryMode ? createBrowserProjectDirectory(accountId, { storage: { get, set, keys, update: updateProjectRecord } }) : null, [browserDirectoryMode, accountId]);
    const browserStorageMode = browserDirectory?.state === 'browser';
    const storage = useMemo(() => browserDirectory || (localMode ? {
        list: listSingleHtmlProjects, create: createSingleHtmlProject, open: openSingleHtmlProject,
        save: saveSingleHtmlProject, configure: configureSingleHtmlProject, rename: renameSingleHtmlProject, remove: deleteSingleHtmlProject,
    } : {
        list: listCanvasProjects, create: createCanvasProject, open: openCanvasProject,
        save: saveCanvasProject, configure: configureCanvasProject, rename: renameCanvasProject, remove: deleteCanvasProject,
    }), [browserDirectory, localMode]);
    const [directoryStatus, setDirectoryStatus] = useState(browserDirectory?.state || 'disabled');
    const [directoryScope, setDirectoryScope] = useState(browserDirectory?.scope || '');
    const draftKey = useCallback((id: string) => 'gzt-project-draft:' + (browserDirectory ? browserDirectory.scope + ':' : '') + id, [browserDirectory]);
    const lastProjectKey = useCallback(() => 'gzt-last-managed-project' + (browserDirectory ? ':' + browserDirectory.scope : ''), [browserDirectory]);
    const recoveryKey = useCallback(() => browserDirectory ? browserDirectory.scope + ':recovery' : LEGACY_DRAFT, [browserDirectory]);
    const [projects, setProjects] = useState<CanvasProject[]>([]);
    const [active, setActive] = useState<CanvasProject | null>(null);
    const [directory, setDirectory] = useState('');
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [operationStage, setOperationStage] = useState('');
    const [saving, setSaving] = useState(false);
    const [saveStage, setSaveStage] = useState('');
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [needsDesktopCompanion, setNeedsDesktopCompanion] = useState(false);
    const [legacyDraft, setLegacyDraft] = useState<ProjectData | null>(null);
    const current = useRef({ getSnapshot, applySnapshot, showCanvas, showHome, enabled });
    current.current = { getSnapshot, applySnapshot, showCanvas, showHome, enabled };
    const activeRef = useRef<CanvasProject | null>(null);
    const saveFlight = useRef<Promise<CanvasProject | null> | null>(null);
    const saveController = useRef<AbortController | null>(null);
    const recoverInterruptedSave = useRef(false);
    const refreshSequence = useRef(0);
    const refreshController = useRef<AbortController | null>(null);
    const transition = useRef(false);
    const transitionController = useRef<AbortController | null>(null);
    const mounted = useRef(true);
    const storageRef = useRef(storage);
    storageRef.current = storage;
    const isCurrent = useCallback(() => mounted.current && storageRef.current === storage, [storage]);
    useEffect(() => () => {
        refreshSequence.current += 1;
        refreshController.current?.abort();
    }, [storage]);
    useLayoutEffect(() => {
        // Fast Refresh can replace the storage instance while retaining hook
        // state. Do not keep returning an obsolete, unresolved save promise.
        recoverInterruptedSave.current = Boolean(saveFlight.current);
        saveController.current?.abort();
        saveController.current = null;
        saveFlight.current = null;
        setSaving(false);
        setSaveStage('');
        transitionController.current?.abort();
        transitionController.current = null;
        transition.current = false;
        setBusy(false);
        setOperationStage('');
        return () => { saveController.current?.abort(); transitionController.current?.abort(); };
    }, [storage]);
    const accountRef = useRef({ id: accountId, draftKey });
    useLayoutEffect(() => {
        if (browserDirectoryMode && accountRef.current.id !== accountId) {
            const previous = activeRef.current;
            if (previous) void set(accountRef.current.draftKey(previous.id), { data: current.current.getSnapshot(), savedAt: Date.now(), baseRevision: previous.revision }).catch(() => {});
            activeRef.current = null;
            saveFlight.current = null;
            transition.current = false;
            setActive(null);
            setProjects([]);
            setLegacyDraft(null);
            setBusy(false);
            setSaving(false);
            setError('');
            setNotice('');
            setDirectoryStatus(browserDirectory?.state || 'disabled');
            setDirectory(browserDirectory?.directory || '');
            current.current.applySnapshot(emptyProject());
            current.current.showHome();
        }
        accountRef.current = { id: accountId, draftKey };
    }, [accountId, browserDirectoryMode, browserDirectory, draftKey]);
    const syncDirectory = useCallback(() => {
        if (!browserDirectory || !isCurrent()) return;
        setDirectoryStatus(browserDirectory.state);
        setDirectoryScope(browserDirectory.scope);
        setDirectory(browserDirectory.directory);
    }, [browserDirectory, isCurrent]);

    const persistDraft = useCallback(() => {
        const project = activeRef.current;
        if (!project) return Promise.resolve();
        return set(draftKey(project.id), { data: current.current.getSnapshot(), savedAt: Date.now(), baseRevision: project.revision });
    }, [draftKey]);

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; void persistDraft().catch(() => {}); };
    }, [persistDraft]);

    const updateProject = useCallback((project: CanvasProject) => {
        if (!isCurrent()) return;
        refreshSequence.current += 1;
        refreshController.current?.abort();
        setLoading(false);
        activeRef.current = project;
        setActive(project);
        setProjects(previous => [project, ...previous.filter(item => item.id !== project.id)].sort((first, second) => second.updatedAt - first.updatedAt));
        try { localStorage.setItem(lastProjectKey(), project.id); } catch {}
    }, [lastProjectKey, isCurrent]);

    const refresh = useCallback(async () => {
        const sequence = ++refreshSequence.current;
        refreshController.current?.abort();
        const controller = new AbortController();
        refreshController.current = controller;
        const isLatest = () => isCurrent() && sequence === refreshSequence.current;
        if (!enabled) { setLoading(false); setError(''); setNeedsDesktopCompanion(false); return; }
        setLoading(true);
        try {
            const result = await boundedPreparation(async () => {
                if (browserDirectory) {
                    await browserDirectory.restore();
                    controller.signal.throwIfAborted();
                    if (!isLatest()) return null;
                    syncDirectory();
                    if (!isProjectStorageReady(browserDirectory.state)) return null;
                }
                return storage.list({ signal: controller.signal });
            }, { timeoutMs: 15_000, signal: controller.signal, stage: '读取工程列表' });
            if (!isLatest()) return;
            if (!result) { setProjects([]); setError(''); return; }
            setProjects(result.projects);
            setNeedsDesktopCompanion(false);
            setDirectory(result.directory);
            setNotice(result.warnings.join(' '));
            setError('');
        } catch (failure: any) {
            if (isLatest()) {
                setNeedsDesktopCompanion(failure.code === 'desktop_companion_required');
                setError(failure.code === 'desktop_companion_required' ? '' : ['project_save_timeout', 'project_read_timeout'].includes(failure.code) ? '读取工程列表超时，原有工程未删除。可重试“刷新项目”；若仍失败，请关闭同地址的其他画布页后重试，不要清除网站数据。' : failure.message);
            }
        } finally { controller.abort(); if (isLatest()) { setLoading(false); syncDirectory(); } }
    }, [enabled, storage, browserDirectory, syncDirectory, isCurrent]);

    useEffect(() => {
        void refresh();
        let cancelled = false;
        if (browserDirectoryMode || !enabled) return;
        void (async () => {
            let draft = await get(LEGACY_DRAFT) as ProjectData | undefined;
            if (!draft && !localStorage.getItem('gzt-last-managed-project')) {
                const previous = await loadProjectFromIndexedDB();
                if (previous?.nodes.length) { draft = previous; await set(LEGACY_DRAFT, draft); }
            }
            if (!cancelled && draft) setLegacyDraft(draft);
        })().catch(() => { if (!cancelled) setNotice('浏览器草稿无法读取；桌面工程文件不受影响。'); });
        return () => { cancelled = true; };
    }, [refresh, browserDirectoryMode, enabled]);

    useEffect(() => {
        if (!browserDirectoryMode || !enabled || !isProjectStorageReady(directoryStatus)) return;
        let cancelled = false;
        void get(recoveryKey()).then((draft: ProjectData | undefined) => { if (!cancelled) setLegacyDraft(draft || null); }).catch(() => {});
        return () => { cancelled = true; };
    }, [browserDirectoryMode, enabled, directoryStatus, directoryScope, recoveryKey]);

    useEffect(() => {
        if (!active || !enabled) return;
        const timer = setTimeout(() => {
            if (activeRef.current?.id !== active.id) return;
            void set(draftKey(active.id), { data: snapshot, savedAt: Date.now(), baseRevision: active.revision }).catch(() => setNotice('浏览器临时草稿无法写入，请先使用“导出项目”下载备份。'));
        }, 1500);
        return () => clearTimeout(timer);
    }, [snapshot.nodes, snapshot.connections, snapshot.groups, snapshot.viewport, active?.id, active?.revision, draftKey, enabled]);

    useEffect(() => {
        if (!active || !browserDirectoryMode) return;
        const persist = () => { void persistDraft().catch(() => {}); };
        const warn = (event: BeforeUnloadEvent) => { persist(); event.preventDefault(); event.returnValue = ''; };
        window.addEventListener('pagehide', persist);
        window.addEventListener('beforeunload', warn);
        return () => { window.removeEventListener('pagehide', persist); window.removeEventListener('beforeunload', warn); };
    }, [active?.id, browserDirectoryMode, persistDraft]);

    const saveNow = useCallback((): Promise<CanvasProject | null> => {
        if (!current.current.enabled || !isCurrent()) return Promise.resolve(null);
        if (saveFlight.current) return saveFlight.current;
        const project = activeRef.current;
        if (!project) return Promise.resolve(null);
        const data = current.current.getSnapshot();
        const controller = new AbortController();
        saveController.current = controller;
        setSaving(true);
        setError('');
        const promise: Promise<CanvasProject | null> = Promise.resolve().then(async () => {
            const isActiveSave = () => isCurrent() && saveFlight.current === promise;
            try {
                const prepared = await prepareProjectSave(data, {
                    serialize: () => serialize(data, browserStorageMode, controller.signal), thumbnail,
                    previousThumbnail: project.thumbnail, signal: controller.signal,
                    onStage: (stage: string) => { if (isActiveSave()) setSaveStage(stage); },
                });
                controller.signal.throwIfAborted();
                const result = await storage.save(project, prepared.data, prepared.thumbnail, { signal: controller.signal });
                if (!isActiveSave()) return null;
                updateProject(result.project);
                setError('');
                setNotice(result.project.warning || (browserStorageMode || localMode ? '工程已保存到当前浏览器；可通过“导出项目”下载文件备份。' : browserDirectoryMode ? '工程已写入你授权的本机文件夹' : '工程已保存到桌面'));
                return result.project;
            } catch (failure: any) {
                controller.abort();
                if (isActiveSave()) setError(failure.message || '工程保存失败。');
                throw failure;
            } finally {
                if (isActiveSave()) { setSaving(false); setSaveStage(''); saveFlight.current = null; saveController.current = null; syncDirectory(); }
            }
        });
        saveFlight.current = promise;
        return promise;
    }, [storage, localMode, browserStorageMode, browserDirectoryMode, updateProject, syncDirectory, isCurrent]);

    useEffect(() => {
        if (!recoverInterruptedSave.current) return;
        recoverInterruptedSave.current = false;
        if (activeRef.current && current.current.enabled) void saveNow().catch(() => {});
    }, [saveNow]);

    const chooseDirectory = useCallback(async (change = false) => {
        if (!browserDirectory || !current.current.enabled || transition.current || saveFlight.current) return false;
        if (change && activeRef.current && current.current.getSnapshot().nodes.some(node => node.status === 'loading')) {
            setError('当前工程还有生成任务，请完成后再更换文件夹。');
            return false;
        }
        transition.current = true;
        setBusy(true);
        setError('');
        try {
            const granted = await browserDirectory.authorize({ change, beforeSwitch: async () => { await saveNow(); } });
            if (!granted || !isCurrent()) return false;
            if (change) {
                activeRef.current = null;
                setActive(null);
                current.current.applySnapshot(emptyProject());
                current.current.showHome();
            }
            syncDirectory();
            await refresh();
            if (!isCurrent()) return false;
            setNotice('工程文件夹已授权；新建与自动保存直接写入此电脑，不上传到服务器。');
            return true;
        } catch (failure: any) {
            if (!isCurrent()) return false;
            if (failure.code === 'directory_cancelled') setNotice(failure.message);
            else setError(failure.message || '文件夹授权失败。');
            return false;
        } finally { if (isCurrent()) { transition.current = false; setBusy(false); syncDirectory(); } }
    }, [browserDirectory, saveNow, syncDirectory, refresh, isCurrent]);

    const preserveDraftAndGoHome = useCallback(async () => {
        if (!browserDirectoryMode || !activeRef.current || transition.current || saveFlight.current) return;
        transition.current = true;
        setBusy(true);
        try {
            if (current.current.getSnapshot().nodes.some(node => node.status === 'loading')) throw new Error('请先完成或取消生成任务，再保留草稿返回首页。');
            const draft = current.current.getSnapshot();
            await persistDraft();
            await set(recoveryKey(), draft);
            if (!isCurrent()) return;
            setLegacyDraft(draft);
            activeRef.current = null;
            setActive(null);
            current.current.applySnapshot(emptyProject());
            current.current.showHome();
            setError('');
            setNotice(browserStorageMode ? '当前内容已保留为浏览器临时草稿，可在首页点击“恢复草稿”另存，或重新打开原工程。请及时导出备份。' : '尚未保存到工程文件夹。当前内容已保留在此浏览器，请授权后点击“恢复草稿”另存为工程，或重新打开原工程。');
        } catch (failure: any) { if (isCurrent()) setError(failure.message || '临时草稿保存失败，请先导出工程；当前画布未关闭。'); }
        finally { if (isCurrent()) { transition.current = false; setBusy(false); } }
    }, [browserDirectoryMode, browserStorageMode, persistDraft, recoveryKey, isCurrent]);

    useEffect(() => {
        if (!active || !enabled) return;
        const stop = startProjectAutosave(() => transition.current ? Promise.resolve(null) : saveNow(), active.settings.intervalMinutes, () => {});
        const resume = () => {
            if (!transition.current && document.visibilityState === 'visible' && activeRef.current && Date.now() - activeRef.current.lastSavedAt >= activeRef.current.settings.intervalMinutes * 60_000) void saveNow().catch(() => {});
        };
        document.addEventListener('visibilitychange', resume);
        return () => { stop(); document.removeEventListener('visibilitychange', resume); };
    }, [active?.id, active?.settings.intervalMinutes, saveNow, enabled]);

    const runTransition = useCallback(async (operation: (signal: AbortSignal) => Promise<void>, checkTasks = true) => {
        if (!current.current.enabled || !isCurrent()) return false;
        if (transition.current) return false;
        transition.current = true;
        const controller = new AbortController();
        transitionController.current = controller;
        const ownsTransition = () => isCurrent() && transitionController.current === controller;
        refreshSequence.current += 1;
        refreshController.current?.abort();
        setLoading(false);
        setBusy(true);
        setOperationStage(activeRef.current ? '正在保存当前工程' : '正在准备工程');
        setError('');
        try {
            if (checkTasks && activeRef.current && current.current.getSnapshot().nodes.some(node => node.status === 'loading')) throw new Error('当前工程还有任务进行中，请完成或取消后再切换工程。');
            await saveNow();
            if (!ownsTransition()) return false;
            controller.signal.throwIfAborted();
            await operation(controller.signal);
            if (!ownsTransition()) return false;
            return true;
        } catch (failure: any) {
            if (!ownsTransition()) return false;
            if (failure.code === 'desktop_companion_required') { setNeedsDesktopCompanion(true); setError(''); }
            else setError(failure.message || '工程操作失败。');
            return false;
        }
        finally { if (ownsTransition()) { transition.current = false; transitionController.current = null; setBusy(false); setOperationStage(''); syncDirectory(); } }
    }, [saveNow, syncDirectory, isCurrent]);

    const create = useCallback((name: string, imported?: ProjectData) => runTransition(async signal => {
        const data: ProjectData = imported || { nodes: [], connections: [], groups: [], viewport: { x: 0, y: 0, k: 1 }, version: 1 };
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        let result;
        try {
            result = await boundedPreparation(async () => {
                const prepared = await prepareProjectSave(data, {
                    serialize: () => serialize(data, browserStorageMode, controller.signal), thumbnail, signal: controller.signal,
                    onStage: (stage: string) => { if (isCurrent() && !controller.signal.aborted) setOperationStage(stage); },
                });
                controller.signal.throwIfAborted();
                return storage.create(name, prepared.data, prepared.thumbnail, {
                    signal: controller.signal,
                    onStage: (stage: string) => { if (isCurrent() && !controller.signal.aborted) setOperationStage(stage); },
                });
            }, { timeoutMs: imported ? 90_000 : 20_000, signal: controller.signal, stage: '创建工程' });
        } catch (failure: any) {
            controller.abort();
            if (failure.code === 'project_save_timeout') throw new Error('浏览器工程存储未响应，尚未确认创建成功。请关闭同地址的其他画布页后重试；原工程未删除，不要清除网站数据。');
            throw failure;
        } finally { signal.removeEventListener('abort', abort); }
        signal.throwIfAborted();
        if (!isCurrent()) return;
        updateProject(result.project);
        current.current.applySnapshot(data);
        current.current.showCanvas();
    }), [storage, browserStorageMode, runTransition, updateProject, isCurrent]);

    const open = useCallback((id: string) => runTransition(async () => {
        const result = await storage.open(id);
        if (!isCurrent()) return;
        let data = result.data;
        const draft = await get(draftKey(id)).catch(() => null);
        if (!isCurrent()) return;
        if (draft?.baseRevision === result.project.revision && draft.savedAt > result.project.lastSavedAt) {
            data = draft.data;
            setNotice(browserStorageMode || localMode ? '已恢复此工程的浏览器本地临时草稿。' : browserDirectoryMode ? '已恢复浏览器临时草稿，下次自动保存将写入你授权的文件夹。' : '已恢复此工程的本机临时草稿，将在下次自动保存时写入桌面。');
        } else if (browserDirectoryMode && draft?.data?.nodes?.length && draft.baseRevision !== result.project.revision && draft.savedAt > result.project.lastSavedAt) {
            await set(recoveryKey(), draft.data);
            if (!isCurrent()) return;
            setLegacyDraft(draft.data);
            setNotice('已打开最新保存的工程；另一版本的临时草稿保留在首页“恢复草稿”，可另存，不会覆盖最新工程。');
        }
        const restored = restoreProjectData(data);
        if (!isCurrent()) return;
        updateProject(result.project);
        if (result.project.warning) setNotice(result.project.warning);
        current.current.applySnapshot(restored);
        current.current.showCanvas();
    }), [storage, localMode, browserStorageMode, browserDirectoryMode, runTransition, updateProject, draftKey, recoveryKey, isCurrent]);

    const goHome = useCallback(() => runTransition(async () => {
        current.current.showHome();
        await refresh();
    }, false), [runTransition, refresh]);

    const configure = useCallback((settings: ProjectSettings) => runTransition(async () => {
        if (!activeRef.current) return;
        const result = await storage.configure(activeRef.current, settings);
        if (!isCurrent()) return;
        updateProject(result.project);
        setNotice(result.project.warning || '自动保存设置已更新');
    }, false), [storage, runTransition, updateProject, isCurrent]);

    const recover = useCallback(async () => {
        if (!legacyDraft) return;
        const created = await create('恢复的画布工程', restoreProjectData(legacyDraft));
        if (created && isCurrent()) { await del(recoveryKey()); if (isCurrent()) setLegacyDraft(null); }
    }, [create, legacyDraft, recoveryKey, isCurrent]);

    const rename = useCallback((project: CanvasProject, name: string) => runTransition(async () => {
        const target = activeRef.current?.id === project.id ? activeRef.current : project;
        const result = await storage.rename(target, name);
        if (!isCurrent()) return;
        if (activeRef.current?.id === project.id) updateProject(result.project);
        else setProjects(previous => previous.map(item => item.id === project.id ? result.project : item).sort((first, second) => second.updatedAt - first.updatedAt));
        setNotice(localMode ? '工程名称已更新，并已保存到浏览器本地。' : '工程名称已更新，后续自动保存使用新名称。');
        const cached = await get(draftKey(project.id)).catch(() => null);
        if (cached?.baseRevision === target.revision) await set(draftKey(project.id), { ...cached, baseRevision: result.project.revision }).catch(() => {});
    }, false), [storage, localMode, runTransition, updateProject, draftKey, isCurrent]);

    const remove = useCallback((project: CanvasProject) => runTransition(async () => {
        const target = activeRef.current?.id === project.id ? activeRef.current : project;
        await storage.remove(target);
        if (!isCurrent()) return;
        if (activeRef.current?.id === project.id) {
            activeRef.current = null;
            setActive(null);
            current.current.applySnapshot({ nodes: [], connections: [], groups: [], viewport: { x: 0, y: 0, k: 1 }, version: 1 });
            current.current.showHome();
        }
        setProjects(previous => previous.filter(item => item.id !== project.id));
        await del(draftKey(project.id)).catch(() => {});
        if (!isCurrent()) return;
        if (localStorage.getItem(lastProjectKey()) === project.id) {
            localStorage.removeItem(lastProjectKey());
            if (!browserDirectoryMode) await del('X-tapnow_project_data').catch(() => {});
        }
        setNotice(browserStorageMode ? '工程已从当前浏览器的最近项目中移除；已下载的备份仍可导入。' : browserDirectoryMode ? '工程已从最近项目中移除；原目录与 .js 备份均保留，可重新导入。' : localMode ? '工程已从浏览器本地项目列表删除；已下载的 .js 备份仍可导入恢复。' : '工程已移入“已删除工程”目录，保留的 .js 备份仍可导入恢复。');
    }), [storage, browserDirectoryMode, browserStorageMode, localMode, runTransition, draftKey, lastProjectKey, isCurrent]);

    return { projects, active, directory, loading, busy, operationStage, saving, saveStage, error, notice, legacyDraft, needsDesktopCompanion, browserDirectoryMode, directoryStatus, chooseDirectory, preserveDraftAndGoHome, refresh, create, open, goHome, configure, saveNow, persistDraft, recover, rename, remove, reportError: setError };
}
