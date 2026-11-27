export const isSingleHtmlRuntime = (): boolean =>
    typeof window !== 'undefined' && Boolean((window as any).__RESONANTOR_SINGLE_HTML__);

export const isBrowserProjectRuntime = (): boolean =>
    !isSingleHtmlRuntime() && import.meta.env.VITE_BROWSER_PROJECT_DIRECTORY === true;

export const singleHtmlServerUrl = (): string => {
    if (typeof window === 'undefined') return '';
    return String((window as any).__RESONANTOR_SERVER_URL__ || '').trim().replace(/\/$/, '');
};
