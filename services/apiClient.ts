export const apiPath = (path: string): string => {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const singleHtmlServer = typeof window !== 'undefined'
        ? String((window as any).__RESONANTOR_SERVER_URL__ || '').trim().replace(/\/$/, '')
        : '';
    if (typeof window !== 'undefined' && (window as any).__RESONANTOR_SINGLE_HTML__ && singleHtmlServer) {
        return singleHtmlServer + normalizedPath;
    }
    const appBase = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
    const isHostedCanvas = appBase.includes('共振画布')
        || appBase.includes('%E5%85%B1%E6%8C%AF%E7%94%BB%E5%B8%83');
    const apiBase = isHostedCanvas ? '/canvas3004-api' : appBase;
    return `${apiBase}${normalizedPath}`;
};

export const apiFetch = (path: string, init: RequestInit = {}) =>
    fetch(apiPath(path), {
        credentials: 'include',
        ...init,
        headers: {
            ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
            ...(init.headers || {})
        }
    });
