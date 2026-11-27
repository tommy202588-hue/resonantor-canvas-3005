import type { NodeData } from '../types';
import type { ScriptDocument, ScriptGeneration } from '../types/storyboard';
export function updateScriptGeneration(nodes: NodeData[], nodeId: string, taskId: string, task: Partial<ScriptGeneration>, document?: ScriptDocument): NodeData[];
export function interruptOrphanScriptGeneration(node: NodeData, activeTasks: Map<string, string>): NodeData;
export function scriptGenerationError(error: unknown): string;
