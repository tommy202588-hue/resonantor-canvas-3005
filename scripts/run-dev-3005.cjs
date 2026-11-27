const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const child = spawn(process.execPath, [path.join(projectRoot, 'scripts', 'run-dev-3004.cjs')], {
  cwd: projectRoot,
  env: { ...process.env, CANVAS_DEV_PORT: '3005', CANVAS_DEV_LABEL: 'dev-3005', VITE_DEV_SERVER_PORT: '3005' },
  stdio: 'inherit',
  windowsHide: true,
});

child.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
