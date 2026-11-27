import { DEFAULT_PROJECT_SETTINGS, validateProjectSettings, validateProjectData, encodeProjectFile, decodeProjectFile } from './projectFile.mjs';
import { createRandomId } from './randomId.mjs';

export const PROJECT_DIRECTORY_NAME = '共智体画布工程';
const PROJECT_ID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const SNAPSHOT_NAME = /^snapshot-\d{13}-[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}\.js$/i;
const flights = new Map();

export const directoryError = (code, message) => Object.assign(new Error(message), { code });
const validTime = value => Number.isSafeInteger(value) && value > 0;
const assertId = id => { if (!PROJECT_ID.test(id)) throw directoryError('invalid_project', '工程目录 ID 无效。'); };
const projectName = value => {
    const name = String(value || '').trim();
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw directoryError('invalid_name', '工程名称应为 1–80 个字符，不能包含控制字符。');
    return name;
};
const safeThumbnail = value => typeof value === 'string' && value.length < 600_000 && /^data:image\/(jpeg|png|webp);base64,[a-z\d+/=]+$/i.test(value) ? value : '';

export function validateDirectoryMetadata(metadata, id) {
    assertId(id);
    if (!metadata || metadata.id !== id || !Number.isSafeInteger(metadata.revision) || metadata.revision < 1
        || ![metadata.createdAt, metadata.updatedAt, metadata.lastSavedAt].every(validTime)
        || !Number.isSafeInteger(metadata.nodeCount) || metadata.nodeCount < 0
        || !Array.isArray(metadata.snapshots) || !metadata.snapshots.length || metadata.snapshots.length > 100
        || metadata.snapshots.some(snapshot => !SNAPSHOT_NAME.test(snapshot?.filename) || !validTime(snapshot.savedAt))
        || new Set(metadata.snapshots.map(snapshot => snapshot.filename)).size !== metadata.snapshots.length
        || (metadata.deletedAt !== undefined && !validTime(metadata.deletedAt))) {
        throw directoryError('invalid_project', '工程索引损坏，未改动原有文件；可导入目录中的 .js 备份恢复。');
    }
    const retired = metadata.retiredSnapshots || [];
    if (!Array.isArray(retired) || retired.length > 1000 || retired.some(filename => !SNAPSHOT_NAME.test(filename) || metadata.snapshots.some(snapshot => snapshot.filename === filename))) {
        throw directoryError('invalid_project', '工程备份索引无效，未删除任何文件。');
    }
    return { ...metadata, name: projectName(metadata.name), settings: validateProjectSettings(metadata.settings), thumbnail: safeThumbnail(metadata.thumbnail), retiredSnapshots: retired };
}

async function writeFile(directory, filename, contents) {
    const handle = await directory.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    try { await writable.write(contents); await writable.close(); }
    catch (failure) { await writable.abort().catch(() => {}); throw failure; }
}

async function readMetadata(directory, id) {
    const file = await (await directory.getFileHandle('project.json')).getFile();
    if (file.size > 2_000_000) throw directoryError('invalid_project', '工程索引过大，未改动原文件。');
    return validateDirectoryMetadata(JSON.parse(await file.text()), id);
}

async function serialized(name, operation, locks) {
    if (locks?.request) return locks.request(name, { mode: 'exclusive' }, operation);
    const previous = flights.get(name) || Promise.resolve();
    const flight = previous.catch(() => {}).then(operation);
    flights.set(name, flight);
    try { return await flight; }
    finally { if (flights.get(name) === flight) flights.delete(name); }
}

export function createBrowserProjectDirectoryStore(root, { label = root.name, locks = globalThis.navigator?.locks } = {}) {
    const permission = async () => {
        if (await root.queryPermission({ mode: 'readwrite' }) !== 'granted') throw directoryError('directory_permission_required', '工程文件夹授权已失效，请点击“重新授权文件夹”。原文件和浏览器临时草稿均保留。');
    };
    const projectView = metadata => ({
        id: metadata.id, name: metadata.name, createdAt: metadata.createdAt, updatedAt: metadata.updatedAt,
        lastSavedAt: metadata.lastSavedAt, revision: metadata.revision, settings: metadata.settings,
        thumbnail: metadata.thumbnail, nodeCount: metadata.nodeCount, snapshotCount: metadata.snapshots.length,
        directory: label + '/' + metadata.id,
    });
    const lock = (id, operation) => { assertId(id); return serialized('gzt-project-directory:' + id, operation, locks); };
    const find = async (id, revision) => {
        await permission();
        assertId(id);
        const directory = await root.getDirectoryHandle(id);
        const metadata = await readMetadata(directory, id);
        if (metadata.deletedAt) throw directoryError('project_deleted', '工程已从最近项目中移除，可导入其 .js 备份恢复。');
        if (revision !== undefined && metadata.revision !== revision) throw directoryError('revision_conflict', '此工程已在其他页面更新，请先导出当前草稿，再重新打开最新工程，避免覆盖。');
        return { directory, metadata };
    };
    const prune = async (directory, filenames) => {
        const remaining = [];
        for (const filename of new Set(filenames)) {
            if (!SNAPSHOT_NAME.test(filename)) throw directoryError('invalid_project', '备份文件名无效。');
            try { await directory.removeEntry(filename); }
            catch (failure) { if (failure.name !== 'NotFoundError') remaining.push(filename); }
        }
        return remaining;
    };
    const commit = async (directory, metadata) => {
        validateDirectoryMetadata(metadata, metadata.id);
        await writeFile(directory, 'project.json', JSON.stringify(metadata, null, 2) + '\n');
        const pending = await prune(directory, metadata.retiredSnapshots || []);
        return { project: { ...projectView(metadata), ...(pending.length ? { warning: '工程已保存，但部分旧备份暂时无法清理，将在下次保存时重试。' } : {}) } };
    };
    const change = (project, operation) => lock(project.id, async () => {
        const { directory, metadata } = await find(project.id, project.revision);
        const retiredSnapshots = await prune(directory, metadata.retiredSnapshots);
        return operation(directory, { ...metadata, retiredSnapshots, revision: metadata.revision + 1, updatedAt: Date.now() });
    });
    const snapshot = async (directory, metadata, data, thumbnail) => {
        validateProjectData(data);
        const savedAt = Date.now();
        const filename = 'snapshot-' + savedAt + '-' + createRandomId() + '.js';
        const contents = encodeProjectFile({ ...data, canvasProject: { id: metadata.id, name: metadata.name, savedAt } });
        await writeFile(directory, filename, contents);
        const snapshots = [{ filename, savedAt }, ...metadata.snapshots];
        return commit(directory, {
            ...metadata, lastSavedAt: savedAt, updatedAt: savedAt, nodeCount: data.nodes.length, thumbnail: safeThumbnail(thumbnail),
            snapshots: snapshots.slice(0, metadata.settings.maxSnapshots),
            retiredSnapshots: [...metadata.retiredSnapshots, ...snapshots.slice(metadata.settings.maxSnapshots).map(item => item.filename)],
        });
    };
    return {
        async list() {
            await permission();
            const projects = [];
            const warnings = [];
            for await (const [id, handle] of root.entries()) {
                if (handle.kind !== 'directory' || !PROJECT_ID.test(id)) continue;
                try {
                    const metadata = await lock(id, () => readMetadata(handle, id));
                    if (!metadata.deletedAt) projects.push(projectView(metadata));
                } catch (failure) {
                    if (['NotAllowedError', 'SecurityError'].includes(failure.name)) throw failure;
                    warnings.push('工程 ' + id + ' 的索引无法读取，原文件未改动，可导入 .js 备份恢复。');
                }
            }
            return { projects: projects.sort((first, second) => second.updatedAt - first.updatedAt), directory: label, warnings };
        },
        async create(name, data, thumbnail) {
            name = projectName(name);
            validateProjectData(data);
            await permission();
            const id = createRandomId();
            return lock(id, async () => {
                try { await root.getDirectoryHandle(id); throw directoryError('id_conflict', '工程 ID 已存在，请重试。'); }
                catch (failure) { if (failure.name !== 'NotFoundError') throw failure; }
                const directory = await root.getDirectoryHandle(id, { create: true });
                const now = Date.now();
                return snapshot(directory, { id, name, createdAt: now, updatedAt: now, lastSavedAt: now, revision: 1, settings: { ...DEFAULT_PROJECT_SETTINGS }, snapshots: [], retiredSnapshots: [] }, data, thumbnail);
            });
        },
        open: id => lock(id, async () => {
            const { directory, metadata } = await find(id);
            for (const [index, entry] of metadata.snapshots.entries()) {
                try {
                    const data = decodeProjectFile(await (await (await directory.getFileHandle(entry.filename)).getFile()).text());
                    if (data.canvasProject?.id && data.canvasProject.id !== id) throw directoryError('invalid_project', '备份不属于此工程。');
                    return { project: { ...projectView(metadata), ...(index ? { warning: '最新备份无法读取，已打开较早的完整备份。原文件均已保留。' } : {}) }, data };
                } catch (failure) { if (['NotAllowedError', 'SecurityError'].includes(failure.name)) throw failure; }
            }
            throw directoryError('invalid_project', '没有可读取的完整备份，请检查工程文件夹，原文件未改动。');
        }),
        save: (project, data, thumbnail) => change(project, (directory, metadata) => snapshot(directory, metadata, data, thumbnail)),
        configure: (project, settings) => {
            const normalized = validateProjectSettings(settings);
            return change(project, (directory, metadata) => commit(directory, {
                ...metadata, settings: normalized, snapshots: metadata.snapshots.slice(0, normalized.maxSnapshots),
                retiredSnapshots: [...metadata.retiredSnapshots, ...metadata.snapshots.slice(normalized.maxSnapshots).map(item => item.filename)],
            }));
        },
        rename: (project, name) => {
            const normalized = projectName(name);
            return change(project, (directory, metadata) => commit(directory, { ...metadata, name: normalized }));
        },
        remove: project => change(project, async (directory, metadata) => {
            await commit(directory, { ...metadata, deletedAt: Date.now() });
            return { deletedId: project.id, directory: label + '/' + project.id };
        }),
    };
}
