import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../desktop-companion-dist');

export const DESKTOP_PACKAGES = Object.freeze({
    'win-x64': Object.freeze({ filename: 'resonantor-desktop-win-x64.zip', contentType: 'application/zip', label: 'Windows x64' }),
    'mac-arm64': Object.freeze({ filename: 'resonantor-desktop-mac-arm64.tar.gz', contentType: 'application/gzip', label: 'Mac Apple 芯片（M 系列）' }),
    'mac-x64': Object.freeze({ filename: 'resonantor-desktop-mac-x64.tar.gz', contentType: 'application/gzip', label: 'Mac Intel' }),
    'single-html': Object.freeze({ filename: 'resonantor-canvas-double-click.html', contentType: 'text/html; charset=utf-8', label: '双击 HTML（Mac / Windows）' }),
});

export const DESKTOP_PACKAGE = path.join(packageDirectory, DESKTOP_PACKAGES['win-x64'].filename);

export const resolveDesktopPackage = (platform, packages = DESKTOP_PACKAGES, directory = packageDirectory) => {
    const selected = packages[platform];
    if (!selected) return null;
    return { ...selected, platform, path: path.resolve(directory, selected.filename) };
};

export function createDesktopPackageMiddleware({ packages = DESKTOP_PACKAGES, directory = packageDirectory } = {}) {
    return (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
        const requested = new URL(request.url || '/', 'http://localhost').searchParams.get('platform') || 'win-x64';
        const selected = resolveDesktopPackage(requested, packages, directory);
        if (!selected) {
            response.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            response.end(JSON.stringify({ error: { message: '未知的下载类型。请选择 Windows、Mac 或双击 HTML 版本。' } }));
            return;
        }
        if (!fs.existsSync(selected.path)) {
            response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            response.end(JSON.stringify({ error: { message: selected.label + ' 本机保存启动器尚未打包，请联系管理员生成对应版本。' } }));
            return;
        }
        const size = fs.statSync(selected.path).size;
        response.writeHead(200, {
            'content-type': selected.contentType,
            'content-length': size,
            'content-disposition': 'attachment; filename="' + selected.filename + '"',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
        });
        const file = fs.createReadStream(selected.path);
        file.on('error', () => response.destroy());
        file.pipe(response);
    };
}

export const desktopPackageMiddleware = createDesktopPackageMiddleware();
