// Only track URL strings, never keep the underlying Blobs alive in this registry.
export function collectObjectUrls(...roots) {
    const urls = new Set();
    const visited = new WeakSet();
    const visit = value => {
        if (typeof value === 'string') {
            if (value.startsWith('blob:')) urls.add(value);
            return;
        }
        if (!value || typeof value !== 'object' || visited.has(value)) return;
        visited.add(value);
        if (Array.isArray(value) || value instanceof Set) {
            for (const item of value) visit(item);
        } else if (Object.getPrototypeOf(value) === Object.prototype) {
            for (const item of Object.values(value)) visit(item);
        }
    };
    roots.forEach(visit);
    return urls;
}

export function createObjectUrlTracker(revoke = url => URL.revokeObjectURL(url)) {
    let retained = new Set();
    return {
        update(...roots) {
            const next = collectObjectUrls(...roots);
            for (const url of retained) if (!next.has(url)) revoke(url);
            retained = next;
        },
        clear() {
            for (const url of retained) revoke(url);
            retained.clear();
        },
    };
}
