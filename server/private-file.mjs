import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function replacePrivateFile(source, target) {
    const sourcePath = path.resolve(source);
    const targetPath = path.resolve(target);
    const parent = path.dirname(targetPath);
    if (path.dirname(sourcePath) !== parent) throw new Error('Private file replacement must stay in the same directory.');
    try { fs.renameSync(sourcePath, targetPath); }
    catch (error) {
        if (error.code !== 'EXDEV' || process.platform !== 'win32') throw error;
        const script = '$ErrorActionPreference="Stop"; $root=[IO.Path]::GetFullPath($env:CANVAS_PRIVATE_PARENT); $source=[IO.Path]::GetFullPath($env:CANVAS_PRIVATE_SOURCE); $target=[IO.Path]::GetFullPath($env:CANVAS_PRIVATE_TARGET); if ([IO.Path]::GetDirectoryName($source) -ne $root -or [IO.Path]::GetDirectoryName($target) -ne $root) { throw "Unsafe private file replacement" }; Move-Item -LiteralPath $source -Destination $target -Force -ErrorAction Stop';
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            windowsHide: true, timeout: 20_000,
            env: { ...process.env, CANVAS_PRIVATE_PARENT: parent, CANVAS_PRIVATE_SOURCE: sourcePath, CANVAS_PRIVATE_TARGET: targetPath },
        });
    }
}
