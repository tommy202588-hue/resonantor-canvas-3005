import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCanvasProjectsMiddleware, resolveProjectRoot } from './canvas-projects.mjs';

export const DESKTOP_UPSTREAM = 'http://192.168.0.228:3004';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const REMOTE_API = /^\/api\/(?:auth\/[a-z/]+|upscale\/[a-z0-9/-]+|model-settings|model-request|model-list-proxy|openai-chat-proxy|openai-images-proxy|openai-download-proxy|gemini-image-proxy|minimax-video-proxy|upload)$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.woff': 'font/woff', '.woff2': 'font/woff2', '.otf': 'font/otf', '.ttf': 'font/ttf' };
const send = (response, status, data) => {
    if (response.headersSent || response.destroyed) return;
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(data));
};

export function createDesktopCompanion({ publicDirectory, projectRoot = resolveProjectRoot, upstream = DESKTOP_UPSTREAM } = {}) {
    const target = new URL(upstream);
    if (target.protocol !== 'http:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Invalid desktop upstream');
    const stores = new Map();
    const publicRoot = fs.realpathSync(publicDirectory);
    const remoteHeaders = request => {
        const headers = { ...request.headers, host: target.host, origin: target.origin, 'sec-fetch-site': 'same-origin' };
        for (const name of Object.keys(headers)) if (/^(?:forwarded|x-forwarded-|proxy-|connection$|upgrade$|referer$)/i.test(name)) delete headers[name];
        return headers;
    };
    const currentUser = request => new Promise((resolve, reject) => {
        const upstreamRequest = http.request(new URL('/api/auth/me', target), { headers: { host: target.host, cookie: request.headers.cookie || '' }, timeout: 10000 }, response => {
            const chunks = [];
            let size = 0;
            response.on('data', chunk => { size += chunk.length; if (size > 65536) response.destroy(new Error('Invalid authentication response')); else chunks.push(chunk); });
            response.on('error', reject);
            response.on('end', () => {
                if (response.statusCode !== 200) return reject(Object.assign(new Error(response.statusCode === 401 ? '请先注册并登录后使用画布。' : '无法验证登录状态，请检查服务器连接。'), { status: response.statusCode === 401 ? 401 : 503 }));
                try {
                    const user = JSON.parse(Buffer.concat(chunks).toString()).user;
                    if (typeof user?.id !== 'string' || !user.id) throw new Error('Invalid user');
                    resolve(user);
                } catch { reject(new Error('无法验证登录身份。')); }
            });
        });
        upstreamRequest.on('error', reject);
        upstreamRequest.on('timeout', () => upstreamRequest.destroy(new Error('登录服务器连接超时。')));
        upstreamRequest.end();
    });
    const proxy = (request, response, url) => {
        const upstreamRequest = http.request(new URL(url.pathname + url.search, target), { method: request.method, headers: remoteHeaders(request), timeout: 600000 }, remote => {
            const headers = { ...remote.headers, 'cache-control': 'no-store' };
            delete headers['access-control-allow-origin'];
            delete headers['access-control-allow-credentials'];
            if (headers.location?.startsWith(target.origin + '/')) headers.location = headers.location.slice(target.origin.length);
            response.writeHead(remote.statusCode || 502, headers);
            remote.on('error', () => response.destroy());
            remote.pipe(response);
        });
        upstreamRequest.on('error', () => send(response, 503, { error: { message: '无法连接画布服务器，请检查局域网连接；工程文件仍保存在本机。' } }));
        upstreamRequest.on('timeout', () => upstreamRequest.destroy(new Error('Server timeout')));
        request.on('aborted', () => upstreamRequest.destroy());
        response.on('close', () => { if (!response.writableEnded) upstreamRequest.destroy(); });
        request.pipe(upstreamRequest);
    };
    return http.createServer(async (request, response) => {
        response.setHeader('x-content-type-options', 'nosniff');
        response.setHeader('referrer-policy', 'same-origin');
        response.setHeader('x-frame-options', 'DENY');
        try {
            const hosts = ['localhost', '127.0.0.1', '[::1]'].map(host => host + ':' + request.socket.localPort);
            if (!LOOPBACK.has(request.socket.remoteAddress) || !hosts.includes(request.headers.host)) return send(response, 403, { error: { message: '本机保存服务仅允许当前电脑访问。' } });
            if (request.headers['sec-fetch-site'] === 'cross-site' || (request.headers.origin && request.headers.origin !== 'http://' + request.headers.host) || (!['GET', 'HEAD'].includes(request.method) && request.headers.origin !== 'http://' + request.headers.host)) return send(response, 403, { error: { message: '请求来源校验失败。' } });
            if (!request.url.startsWith('/') || request.url.startsWith('//')) return send(response, 400, { error: { message: 'Invalid path' } });
            const url = new URL(request.url, 'http://localhost');
            if (url.pathname === '/desktop-health' && request.method === 'GET') return send(response, 200, { service: 'resonantor-desktop-v1', upstream: target.origin });
            if (/^\/api\/canvas-projects(?:\/|$)/.test(url.pathname)) {
                const user = await currentUser(request);
                const account = '账户-' + createHash('sha256').update(user.id).digest('hex').slice(0, 24);
                if (!stores.has(account)) stores.set(account, createCanvasProjectsMiddleware({ rootDirectory: path.join(typeof projectRoot === 'function' ? projectRoot() : projectRoot, account) }));
                request.url = request.url.slice('/api/canvas-projects'.length) || '/';
                return void stores.get(account)(request, response);
            }
            if (REMOTE_API.test(url.pathname)) return proxy(request, response, url);
            if (url.pathname.startsWith('/api/')) return send(response, 404, { error: { message: '本机启动器不开放服务器桌面、目录选择或管理接口。图片请使用浏览器本机文件夹授权。' } });
            if (!['GET', 'HEAD'].includes(request.method)) return send(response, 405, { error: { message: 'Method not allowed' } });
            const decoded = decodeURIComponent(url.pathname);
            const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
            const filename = path.resolve(publicRoot, relative);
            if (!filename.startsWith(publicRoot + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile() || !fs.realpathSync(filename).startsWith(publicRoot + path.sep)) return send(response, 404, { error: { message: 'File not found' } });
            response.writeHead(200, { 'content-type': TYPES[path.extname(filename)] || 'application/octet-stream', 'content-length': fs.statSync(filename).size, 'cache-control': path.extname(filename) === '.html' ? 'no-store' : 'public, max-age=3600' });
            if (request.method === 'HEAD') return response.end();
            const file = fs.createReadStream(filename);
            file.on('error', () => response.destroy());
            file.pipe(response);
        } catch (error) { send(response, error.status || 503, { error: { message: error.message || '本机工程保存服务异常。' } }); }
    });
}
