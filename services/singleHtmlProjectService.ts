import { del, get, set } from 'idb-keyval';
import { createRandomId } from './randomId.mjs';
import { DEFAULT_PROJECT_SETTINGS } from './projectFile.mjs';
import type { ProjectData } from './storageService';
import type { CanvasProject, ProjectSettings } from './canvasProjectService';

type LocalRecord = {
    project: CanvasProject;
    data: ProjectData;
    snapshots: Array<{ revision: number; savedAt: number; data: ProjectData }>;
};

const STORAGE_KEY = 'gzt-single-html-projects-v1';
const DIRECTORY_LABEL = '浏览器本地存储（双击版）';

const readRecords = async (): Promise<LocalRecord[]> => (await get<LocalRecord[]>(STORAGE_KEY)) || [];
const writeRecords = (records: LocalRecord[]) => set(STORAGE_KEY, records);
const copyData = <T,>(data: T): T => structuredClone(data);

const sortProjects = (records: LocalRecord[]) => records
    .map(record => record.project)
    .sort((first, second) => second.updatedAt - first.updatedAt);

const findRecord = (records: LocalRecord[], id: string) => {
    const record = records.find(item => item.project.id === id);
    if (!record) throw Object.assign(new Error('工程不存在，可能已被删除。'), { code: 'not_found' });
    return record;
};

export const listSingleHtmlProjects = async () => {
    const records = await readRecords();
    return {
        projects: sortProjects(records),
        directory: DIRECTORY_LABEL,
        warnings: ['双击版工程保存在此浏览器的本地存储中；需要写入桌面时，请使用“导出工程”下载 .js 文件。'],
    };
};

export const createSingleHtmlProject = async (name: string, data: ProjectData, thumbnail: string) => {
    const now = Date.now();
    const id = createRandomId();
    const project: CanvasProject = {
        id,
        name,
        createdAt: now,
        updatedAt: now,
        lastSavedAt: now,
        settings: { ...DEFAULT_PROJECT_SETTINGS },
        revision: 1,
        snapshotCount: 1,
        nodeCount: data.nodes.length,
        thumbnail,
        directory: DIRECTORY_LABEL,
        warning: '双击版保存在浏览器本地；可通过导出工程下载到电脑。',
    };
    const record: LocalRecord = { project, data: copyData(data), snapshots: [{ revision: 1, savedAt: now, data: copyData(data) }] };
    const records = await readRecords();
    records.push(record);
    await writeRecords(records);
    return { project };
};

export const openSingleHtmlProject = async (id: string) => {
    const record = findRecord(await readRecords(), id);
    return { project: record.project, data: copyData(record.data) };
};

export const saveSingleHtmlProject = async (project: CanvasProject, data: ProjectData, thumbnail: string) => {
    const records = await readRecords();
    const record = findRecord(records, project.id);
    if (record.project.revision !== project.revision) throw Object.assign(new Error('工程已在另一个页面发生变化，请刷新后重试。'), { code: 'revision_conflict' });
    const now = Date.now();
    const nextRevision = project.revision + 1;
    const nextSettings = { ...record.project.settings };
    const snapshots = [...record.snapshots, { revision: nextRevision, savedAt: now, data: copyData(data) }].slice(-nextSettings.maxSnapshots);
    const nextProject: CanvasProject = {
        ...record.project,
        updatedAt: now,
        lastSavedAt: now,
        revision: nextRevision,
        snapshotCount: snapshots.length,
        nodeCount: data.nodes.length,
        thumbnail: thumbnail || record.project.thumbnail,
        settings: nextSettings,
        warning: '双击版已保存到浏览器本地存储。',
    };
    record.project = nextProject;
    record.data = copyData(data);
    record.snapshots = snapshots;
    await writeRecords(records);
    return { project: nextProject };
};

export const configureSingleHtmlProject = async (project: CanvasProject, settings: ProjectSettings) => {
    const records = await readRecords();
    const record = findRecord(records, project.id);
    if (record.project.revision !== project.revision) throw Object.assign(new Error('工程已在另一个页面发生变化，请刷新后重试。'), { code: 'revision_conflict' });
    const now = Date.now();
    const nextProject = { ...record.project, settings: { ...settings }, updatedAt: now, revision: project.revision + 1 };
    record.project = nextProject;
    record.snapshots = record.snapshots.slice(-settings.maxSnapshots);
    record.project.snapshotCount = record.snapshots.length;
    await writeRecords(records);
    return { project: nextProject };
};

export const renameSingleHtmlProject = async (project: CanvasProject, name: string) => {
    const records = await readRecords();
    const record = findRecord(records, project.id);
    if (record.project.revision !== project.revision) throw Object.assign(new Error('工程已在另一个页面发生变化，请刷新后重试。'), { code: 'revision_conflict' });
    const nextProject = { ...record.project, name, updatedAt: Date.now(), revision: project.revision + 1 };
    record.project = nextProject;
    await writeRecords(records);
    return { project: nextProject };
};

export const deleteSingleHtmlProject = async (project: CanvasProject) => {
    const records = await readRecords();
    findRecord(records, project.id);
    await writeRecords(records.filter(record => record.project.id !== project.id));
    await del('gzt-project-draft:' + project.id).catch(() => {});
    return { deletedId: project.id, directory: DIRECTORY_LABEL };
};
