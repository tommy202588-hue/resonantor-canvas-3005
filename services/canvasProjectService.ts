import { createRandomId } from './randomId.mjs';
import { apiPath } from './apiClient';
import type { ProjectData } from './storageService';
import { getSessionVersion, reportLoginRequired } from './sessionEvents.mjs';

export interface ProjectSettings { intervalMinutes: number; maxSnapshots: number }
export interface CanvasProject {
    id: string; name: string; createdAt: number; updatedAt: number; lastSavedAt: number;
    settings: ProjectSettings; revision: number; snapshotCount: number; nodeCount: number;
    thumbnail: string; directory: string; warning?: string;
}

async function request(endpoint: string, method = 'GET', payload?: unknown) {
    const requestVersion = getSessionVersion();
    const key = 'gzt-canvas-project-client';
    let client = localStorage.getItem(key);
    if (!client) { client = createRandomId(); localStorage.setItem(key, client); }
    const response = await fetch(apiPath('/api/canvas-projects' + endpoint), {
        method, headers: { 'x-canvas-project-client': client, ...(payload ? { 'content-type': 'application/json' } : {}) },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.timeout(method === 'GET' ? 30_000 : 180_000),
    });
    const data = await response.json().catch(() => null);
    reportLoginRequired(response.status, data, requestVersion);
    if (!response.ok || !data) throw Object.assign(new Error(data?.error?.message || '无法连接本机工程服务，请确认画布服务正在运行。'), { code: data?.error?.code });
    return data;
}

export const listCanvasProjects = (): Promise<{ projects: CanvasProject[]; directory: string; warnings: string[] }> => request('');
export const openCanvasProject = (id: string): Promise<{ project: CanvasProject; data: ProjectData }> => request('/' + id);
export const createCanvasProject = (name: string, data: ProjectData, thumbnail: string): Promise<{ project: CanvasProject }> => request('', 'POST', { name, data, thumbnail });
export const saveCanvasProject = (project: CanvasProject, data: ProjectData, thumbnail: string): Promise<{ project: CanvasProject }> => request('/' + project.id + '/snapshots', 'POST', { revision: project.revision, data, thumbnail });
export const configureCanvasProject = (project: CanvasProject, settings: ProjectSettings): Promise<{ project: CanvasProject }> => request('/' + project.id + '/settings', 'PATCH', { revision: project.revision, settings });
export const renameCanvasProject = (project: CanvasProject, name: string): Promise<{ project: CanvasProject }> => request('/' + project.id + '/name', 'PATCH', { revision: project.revision, name });
export const deleteCanvasProject = (project: CanvasProject): Promise<{ deletedId: string; directory: string }> => request('/' + project.id + '/delete', 'POST', { revision: project.revision, confirmationId: project.id });
