import { Connection, GroupData, NodeData } from '../types';
import { apiFetch } from './apiClient';
import { createSerializableProjectData, ProjectData, restoreProjectData } from './storageService';

const DEFAULT_PROJECT_ID = 'default';

export const loadDefaultCloudProject = async (): Promise<ProjectData | null> => {
    const response = await apiFetch(`/api/projects/${DEFAULT_PROJECT_ID}`);
    if (response.status === 404) return null;
    if (response.status === 401) throw new Error('login_required');
    if (!response.ok) {
        throw new Error(`加载云端项目失败：HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (!payload?.project?.data) return null;
    return restoreProjectData(payload.project.data as ProjectData);
};

export const saveDefaultCloudProject = async (
    nodes: NodeData[],
    connections: Connection[],
    viewport?: { x: number; y: number; k: number },
    groups: GroupData[] = []
) => {
    const data = await createSerializableProjectData(nodes, connections, viewport, groups, false);
    const response = await apiFetch(`/api/projects/${DEFAULT_PROJECT_ID}`, {
        method: 'PUT',
        body: JSON.stringify({
            name: '默认画布',
            data
        })
    });

    if (response.status === 401) throw new Error('login_required');
    if (!response.ok) {
        const message = await response.text().catch(() => '');
        throw new Error(`保存云端项目失败：HTTP ${response.status}${message ? ` ${message.slice(0, 300)}` : ''}`);
    }
};
