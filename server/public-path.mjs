export function normalizePublicBasePath(value) {
    const base = String(value || '').replace(/\/$/, '');
    if (base && !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(base)) throw new Error('CANVAS_PUBLIC_BASE_PATH must be an absolute URL path without query strings or special characters.');
    return base;
}

export function withPublicBasePath(html, value) {
    const base = normalizePublicBasePath(value);
    if (!base) return html;
    return html.replaceAll('href="/', 'href="' + base + '/').replaceAll("fetch('/api/", "fetch('" + base + '/api/');
}
