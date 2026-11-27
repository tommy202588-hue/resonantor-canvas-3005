import { createHash } from 'node:crypto';

const normalize = value => {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || value.length > 8192) return null;
        url.hash = '';
        return url.href;
    } catch { return null; }
};

export function createGeneratedImageDownloads({ now = Date.now, ttlMs = 24 * 60 * 60 * 1000, limit = 10000 } = {}) {
    const entries = new Map();
    const key = (owner, url) => createHash('sha256').update(owner + '\0' + url).digest('hex');
    return {
        remember(owner, body, contentType) {
            if (!/(json|text|event-stream)/i.test(contentType)) return;
            const time = now();
            for (const [entry, expires] of entries) if (expires <= time) entries.delete(entry);
            const urls = new Set();
            let visited = 0;
            const visit = (value, depth = 0) => {
                if (++visited > 10000 || depth > 32 || urls.size >= 128) return;
                if (typeof value === 'string') {
                    const exact = normalize(value);
                    if (exact) { urls.add(exact); return; }
                    for (const match of value.matchAll(/https:\/\/[^\s<>"'`\)\]]+/g)) {
                        const url = normalize(match[0]);
                        if (url) urls.add(url);
                        if (urls.size >= 128) break;
                    }
                } else if (value && typeof value === 'object') {
                    for (const child of Object.values(value)) visit(child, depth + 1);
                }
            };
            const text = body.toString('utf8');
            if (/event-stream/i.test(contentType)) {
                for (const line of text.split('\n')) {
                    if (!line.startsWith('data:')) continue;
                    try { visit(JSON.parse(line.slice(5))); } catch {}
                }
            } else {
                try { visit(JSON.parse(text)); } catch { if (/^text\//i.test(contentType)) visit(text); }
            }
            for (const url of urls) {
                const entry = key(owner, url);
                entries.delete(entry);
                entries.set(entry, time + ttlMs);
            }
            while (entries.size > limit) entries.delete(entries.keys().next().value);
        },
        allows(owner, value) {
            const url = normalize(value);
            if (!url) return false;
            const entry = key(owner, url);
            const expires = entries.get(entry);
            if (expires > now()) return true;
            entries.delete(entry);
            return false;
        },
    };
}
