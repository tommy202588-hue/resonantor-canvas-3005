import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export const DEFAULT_DOWNLOAD_DIRECTORY = path.join(os.homedir(), 'Downloads', '共振画布');

export function saveProcessedImage(job, sourceFile, downloadDirectory = DEFAULT_DOWNLOAD_DIRECTORY) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(job.id)) throw new Error('无效的下载任务ID。');
  const label = job.options.mode === 'remove-background' ? '去背景' : (job.engine === 'seedvr2-2.5.1' ? 'SeedVR2高清放大-' : '保真放大-') + job.options.scale + 'x';
  const filename = label + '-' + job.id + '.png';
  fs.mkdirSync(downloadDirectory, { recursive: true });
  const destination = path.join(downloadDirectory, filename);
  try {
    fs.copyFileSync(sourceFile, destination, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (digest(sourceFile) !== digest(destination)) throw new Error('下载目录存在同名的不同文件，未覆盖该文件。');
  }
  return { filename, path: destination };
}
