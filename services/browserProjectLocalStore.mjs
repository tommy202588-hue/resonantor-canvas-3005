import { DEFAULT_PROJECT_SETTINGS, validateProjectData, validateProjectSettings } from './projectFile.mjs';
import { createRandomId } from './randomId.mjs';

const DIRECTORY = '当前电脑的浏览器存储';
const NOTICE = '工程保存在当前浏览器，不会自动写入桌面。请定期使用“导出项目”下载备份；清除网站数据会删除这里的工程。';
const PROJECT_ID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const failure = (code, message) => Object.assign(new Error(message), { code });
const projectName = value => {
    const name = String(value || '').trim();
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw failure('invalid_name', '工程名称应为 1–80 个字符，不能包含控制字符。');
    return name;
};

export function createBrowserProjectLocalStore(accountId, { storage } = {}) {
    const prefix = 'gzt-browser-projects-v1:' + encodeURIComponent(accountId) + ':';
    const run = async operation => {
        if (!accountId) throw failure('login_required', '请先登录，再使用此电脑的工程。');
        try { return await operation(); }
        catch (error) {
            if (error?.name === 'QuotaExceededError') throw failure('browser_storage_full', '浏览器存储空间不足，保存未完成。请先导出当前工程备份，原有备份仍保留。');
            if (['SecurityError', 'InvalidStateError', 'UnknownError'].includes(error?.name)) throw failure('browser_storage_unavailable', '当前浏览器不允许保存网站数据。请允许网站存储后重试，或在 HTTPS 下授权工程文件夹。');
            throw error;
        }
    };
    const keyFor = id => {
        if (!PROJECT_ID.test(id)) throw failure('invalid_project', '工程 ID 无效。');
        return prefix + id;
    };
    const requireRecord = (record, id, revision) => {
        if (!record || record.project?.id !== id || record.deletedAt) throw failure('not_found', '工程不存在，或已从最近项目中移除。');
        if (revision !== undefined && record.project.revision !== revision) throw failure('revision_conflict', '工程已在另一页面更新。请先导出当前草稿，再重新打开工程，避免覆盖。');
        return record;
    };
    const change = (project, operation, options) => run(async () => {
        let result;
        await storage.update(keyFor(project.id), saved => {
            const record = requireRecord(saved, project.id, project.revision);
            // IndexedDB already gives update() an isolated record. Copy only the
            // containers we edit; cloning every historical image doubles peak memory.
            const next = operation({ ...record, project: { ...record.project }, snapshots: [...record.snapshots] });
            next.project = { ...next.project, revision: record.project.revision + 1, updatedAt: Date.now(), snapshotCount: next.snapshots.length };
            result = { project: structuredClone(next.project) };
            return next;
        }, options);
        return result;
    });
    return {
        state: 'browser',
        scope: prefix,
        directory: DIRECTORY,
        restore: async () => {},
        authorize: async () => false,
        list: (options = {}) => run(async () => {
            const projects = [];
            const warnings = [NOTICE];
            const keys = (await storage.keys(options)).filter(key => typeof key === 'string' && key.startsWith(prefix));
            for (const key of keys) {
                options.signal?.throwIfAborted();
                let record;
                try { record = await storage.get(key, options); }
                catch (error) {
                    options.signal?.throwIfAborted();
                    warnings.push('一个工程暂时读取失败，原有数据未删除，请稍后刷新项目重试。');
                    continue;
                }
                if (!record || record.deletedAt) continue;
                if (!PROJECT_ID.test(record.project?.id) || key !== keyFor(record.project.id) || !record.snapshots?.length) {
                    warnings.push('一个工程记录无法读取，原有数据未删除。');
                    continue;
                }
                projects.push(record.project);
            }
            return { projects: projects.sort((first, second) => second.updatedAt - first.updatedAt), directory: DIRECTORY, warnings };
        }),
        create: (name, data, thumbnail = '', options = {}) => run(async () => {
            name = projectName(name);
            validateProjectData(data);
            const now = Date.now();
            const id = createRandomId();
            const project = {
                id, name, createdAt: now, updatedAt: now, lastSavedAt: now,
                settings: { ...DEFAULT_PROJECT_SETTINGS }, revision: 1, snapshotCount: 1,
                nodeCount: data.nodes.length, thumbnail, directory: DIRECTORY,
            };
            await storage.update(keyFor(id), previous => {
                if (previous) throw failure('id_conflict', '工程 ID 已存在，请重试。');
                // storage.update performs the structured clone at the IDB boundary.
                return { project, snapshots: [{ savedAt: now, data }] };
            }, options);
            return { project };
        }),
        open: id => run(async () => {
            const record = requireRecord(await storage.get(keyFor(id)), id);
            const data = record.snapshots.at(-1).data;
            validateProjectData(data);
            return { project: record.project, data };
        }),
        save: async (project, data, thumbnail = '', options) => {
            const write = compact => change(project, record => {
                validateProjectData(data);
                const now = Date.now();
                record.snapshots = [...record.snapshots, { savedAt: now, data }].slice(-(compact ? 1 : record.project.settings.maxSnapshots));
                record.project = { ...record.project, lastSavedAt: now, nodeCount: data.nodes.length, thumbnail,
                    warning: compact ? '工程已保存。浏览器空间不足，本次仅保留最新快照；请立即导出工程备份。' : undefined };
                return record;
            }, options);
            try { return await write(false); }
            catch (error) {
                if (error.code !== 'browser_storage_full' || project.snapshotCount < 1 || project.settings.maxSnapshots <= 1) throw error;
                // Retry one atomic replacement with the latest complete snapshot.
                // If it fails, the previous record and all its backups survive.
                return write(true);
            }
        },
        configure: (project, settings) => change(project, record => {
            record.project.settings = validateProjectSettings(settings);
            record.snapshots = record.snapshots.slice(-record.project.settings.maxSnapshots);
            return record;
        }),
        rename: (project, name) => change(project, record => {
            record.project.name = projectName(name);
            return record;
        }),
        remove: async project => {
            await change(project, record => ({ ...record, deletedAt: Date.now() }));
            return { deletedId: project.id, directory: DIRECTORY };
        },
    };
}
