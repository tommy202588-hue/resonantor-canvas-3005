import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function createLocalSaveDirectoryService({ chooseDirectory, settingsFile = path.join(process.env.LOCALAPPDATA || os.homedir(), '共振画布', 'save-directories.json'), platform = process.platform }) {
    let directories = {};
    let choosing;
    try { directories = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
    const describe = record => record ? { id: record.id, name: path.basename(record.path) || record.path, path: record.path } : null;
    const persist = () => {
        fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
        fs.writeFileSync(settingsFile + '.tmp', JSON.stringify(directories));
        fs.renameSync(settingsFile + '.tmp', settingsFile);
    };
    return async (request, response) => {
        response.setHeader('content-type', 'application/json; charset=utf-8');
        response.setHeader('cache-control', 'no-store');
        try {
            const hosts = ['localhost', '127.0.0.1', '[::1]'].map(host => host + ':' + request.socket.localPort);
            if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || !hosts.includes(request.headers.host)) throw fail('目录选择仅允许本机访问。', 403);
            if (request.method !== 'GET' && request.headers.origin !== 'http://' + request.headers.host) throw fail('请求来源校验失败。', 403);
            const owner = request.headers['x-canvas-save-client'];
            if (typeof owner !== 'string' || !UUID.test(owner)) throw fail('缺少保存目录身份。', 403);
            const url = new URL(request.url, 'http://localhost');
            let result;
            if (url.pathname === '/directory' && request.method === 'GET') {
                result = { available: platform === 'win32', directory: describe(directories[owner]) };
            } else if (url.pathname === '/directory' && request.method === 'POST') {
                if (platform !== 'win32') throw fail('本机系统选择器仅支持 Windows，请使用浏览器选择文件夹。', 501);
                if (choosing && choosing.owner !== owner) throw fail('已有文件夹选择器打开，请先完成选择。', 409);
                if (!choosing) {
                    const promise = (async () => {
                        const selectedPath = await chooseDirectory();
                        if (!selectedPath) return { cancelled: true };
                        const selected = path.resolve(selectedPath);
                        if (!fs.statSync(selected).isDirectory()) throw fail('所选位置不是文件夹。');
                        fs.accessSync(selected, fs.constants.W_OK);
                        const previous = directories[owner];
                        directories[owner] = { id: randomUUID(), path: selected };
                        try { persist(); } catch (error) {
                            if (previous) directories[owner] = previous; else delete directories[owner];
                            throw error;
                        }
                        return { directory: describe(directories[owner]) };
                    })();
                    choosing = { owner, promise };
                    promise.finally(() => { choosing = undefined; }).catch(() => {});
                }
                result = await choosing.promise;
            } else if (url.pathname === '/image' && request.method === 'POST') {
                const directory = directories[owner];
                if (!directory || request.headers['x-canvas-save-directory'] !== directory.id) throw fail('保存目录已变更或失效，请重新选择。', 409);
                const filename = url.searchParams.get('filename') || '';
                if (!filename || filename.length > 200 || /[<>:"/\\|?*\u0000-\u001f]/.test(filename) || /[. ]$/.test(filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(filename) || !/\.(png|jpe?g|webp)$/i.test(filename)) throw fail('图片文件名无效。');
                if (!['image/png', 'image/jpeg', 'image/webp'].includes(request.headers['content-type'])) throw fail('仅允许保存 PNG、JPEG 或 WebP 图片。', 415);
                const chunks = [];
                let size = 0;
                for await (const chunk of request) {
                    size += chunk.length;
                    if (size > 160 * 1024 * 1024) throw fail('图片文件超过 160 MB。', 413);
                    chunks.push(chunk);
                }
                if (!size) throw fail('图片内容为空。');
                const data = Buffer.concat(chunks);
                const output = path.join(directory.path, filename);
                try { fs.writeFileSync(output, data, { flag: 'wx' }); }
                catch (error) {
                    if (error.code !== 'EEXIST' || !fs.readFileSync(output).equals(data)) throw fail('保存失败：' + (error.code === 'EEXIST' ? '存在同名的不同文件，请更换文件名。' : error.message), 409);
                }
                result = { saved: true };
            } else throw fail('接口或请求方法不受支持。', 405);
            response.statusCode = 200;
            response.end(JSON.stringify(result));
        } catch (error) {
            response.statusCode = error.status || 500;
            response.end(JSON.stringify({ error: { message: error.killed ? '文件夹选择超时，请重试。' : error.message || '本机保存失败，请重试。' } }));
        }
    };
}
