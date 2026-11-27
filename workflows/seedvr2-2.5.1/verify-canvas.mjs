import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createUpscaleService } from '../../server/upscale-service.mjs';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../diagnostics/seedvr-canvas-validation');
const install = 'D:/other/comfyui/ComfyUI-aki-v1.7/ComfyUI-aki-v1.7';
const python = path.join(install, 'python/python.exe');
const source = path.join(root, 'transparent-321x479.png');
await fs.mkdir(root, { recursive: true });
await execute(python, ['-X', 'utf8', '-c', [
  'from PIL import Image',
  'import sys',
  'image = Image.open(sys.argv[1]).convert("RGBA").resize((321,479))',
  'alpha = Image.new("L", image.size)',
  'alpha.putdata([round(column * 255 / 320) for row in range(479) for column in range(321)])',
  'image.putalpha(alpha)',
  'image.save(sys.argv[2])',
].join('\n'), path.join(install, 'ComfyUI/input/seedvr2-demo/SeedVR2-official-demo-320x478.png'), source], { windowsHide: true });
const service = createUpscaleService({ dataDir: path.join(root, 'jobs'), downloadDirectory: path.join(root, 'downloads') });
const owner = randomUUID();
const results = [];
try {
  if (!(await service.runtime()).faithfulReady) throw new Error('SeedVR2 runtime is not ready');
  for (const scale of [2, 4]) {
    const queue = await (await fetch('http://127.0.0.1:8190/queue')).json();
    if (queue.queue_running.length || queue.queue_pending.length) throw new Error('ComfyUI is busy; do not interrupt existing tasks');
    const id = randomUUID();
    let job = await service.submit(owner, { jobId: id, mode: 'faithful', scale }, destination => fs.copyFile(source, destination));
    const deadline = Date.now() + 180_000;
    while (!['success', 'error', 'cancelled'].includes(job.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      job = await service.getJob(owner, id);
    }
    if (job.state !== 'success') throw new Error(JSON.stringify(job.error || { state: job.state }));
    const image = await fs.readFile(path.join(root, 'jobs', id, 'result.png'));
    const dimensions = [image.readUInt32BE(16), image.readUInt32BE(20)];
    if (dimensions[0] !== 321 * scale || dimensions[1] !== 479 * scale) throw new Error('Unexpected PNG dimensions');
    const alpha = await execute(python, ['-X', 'utf8', '-c', [
      'from PIL import Image, ImageChops',
      'import sys',
      'original = Image.open(sys.argv[1])',
      'result = Image.open(sys.argv[2])',
      'expected = original.getchannel("A").resize(result.size, Image.Resampling.LANCZOS)',
      'assert ImageChops.difference(expected, result.getchannel("A")).getbbox() is None',
      'print("alpha verified")',
    ].join('\n'), source, job.download.path], { windowsHide: true });
    results.push({ scale, id, engine: job.engine, seed: job.seed, dimensions, elapsedMs: job.finishedAt - job.createdAt, alpha: alpha.stdout.trim(), download: job.download.path });
    console.log(JSON.stringify(results.at(-1)));
  }
  await fs.writeFile(path.join(root, 'verification.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), results }, null, 2));
} finally {
  service.dispose();
}
