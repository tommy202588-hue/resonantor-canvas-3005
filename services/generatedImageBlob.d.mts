export function readGeneratedImageBlob(value: string, options: { apiPath: (path: string) => string; origin?: string; fetchImage?: typeof fetch }): Promise<Blob>;
