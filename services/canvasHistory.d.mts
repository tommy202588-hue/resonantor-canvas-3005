import type { NodeData, Connection, GroupData } from '../types';

export interface CanvasHistoryState {
    nodes: NodeData[];
    connections: Connection[];
    groups: GroupData[];
    selectedNodeIds: string[];
    selectedGroupId: string | null;
    selectedConnectionId: string | null;
}
export type CanvasHistoryScope = Partial<Record<'nodes' | 'connections' | 'groups', { ids: string[]; fields?: string[] }>>;
export interface CanvasHistoryOptions { key?: string; continuous?: boolean; scope?: CanvasHistoryScope }
export function createCanvasHistory(options?: { limit?: number; mergeWindowMs?: number; now?: () => number }): {
    readonly size: number;
    getObjectUrls(): Set<string>;
    clear(): void;
    breakMerge(): void;
    record(before: CanvasHistoryState, after: CanvasHistoryState, options?: CanvasHistoryOptions): void;
    undo(state: CanvasHistoryState): CanvasHistoryState | null;
};
