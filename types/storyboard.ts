export type ScriptStage = 1 | 2 | 3;
export interface ScriptGeneration {
    id: string;
    status: 'running' | 'success' | 'error';
    progress: number;
    stage: string;
    error?: string;
}
export type ScriptAssetKind = 'character' | 'scene' | 'prop';

export interface ScriptAsset {
    id: string;
    kind: ScriptAssetKind;
    name: string;
    description: string;
    imageDataUrl?: string;
}

export interface ScriptShot {
    id: string;
    duration: number;
    description: string;
    shotSize: string;
    lighting: string;
    dialogue: string;
    sound: string;
    camera: string;
    assetIds: string[];
    prompt: string;
}

export interface ScriptDocument {
    version: 1;
    sourceText: string;
    sourceName: string;
    style: string;
    stage: ScriptStage;
    shotsConfirmed: boolean;
    shots: ScriptShot[];
    assets: ScriptAsset[];
}
