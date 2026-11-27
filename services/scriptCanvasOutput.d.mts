import type { NodeData, Connection } from '../types';
import type { ScriptDocument } from '../types/storyboard';
import type { ApiProvider } from '../types/settings';
export function buildScriptCanvasOutput(source: NodeData, doc: ScriptDocument, kind: 'text' | 'video', videoProvider?: ApiProvider): { nodes: NodeData[]; connections: Connection[] };
