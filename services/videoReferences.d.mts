export function selectVideoReferenceImages<T extends { index: number }>(prompt: string, images: T[]): T[];
export function buildVideoReferencePrompt(prompt: string, images: { index: number }[]): string;
