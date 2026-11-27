const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const viteEntry = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const port = Number(process.env.CANVAS_DEV_PORT || '3005');
const label = process.env.CANVAS_DEV_LABEL || `dev-${port}`;
const logPath = path.join(projectRoot, `${label}.log`);
const errorLogPath = path.join(projectRoot, `${label}.err.log`);

let child = null;
let stopping = false;

const writeSupervisorLog = (message) => {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
};

const isServerHealthy = () => new Promise((resolve) => {
  const request = http.get(`http://127.0.0.1:${port}/`, (response) => {
    response.resume();
    resolve(response.statusCode >= 200 && response.statusCode < 500);
  });
  request.setTimeout(2000, () => request.destroy());
  request.once('error', () => resolve(false));
});

const ensureStarted = async () => {
  if (stopping || child) return;
  if (await isServerHealthy()) {
    setTimeout(ensureStarted, 5000);
    return;
  }
  start();
};

const start = () => {
  const stdout = fs.openSync(logPath, 'a');
  const stderr = fs.openSync(errorLogPath, 'a');

  child = spawn(process.execPath, [
    viteEntry,
    '--host', '0.0.0.0',
    '--port', String(port),
    '--strictPort',
    '--configLoader', 'runner',
  ], {
    cwd: projectRoot,
    env: { ...process.env, VITE_DEV_SERVER_PORT: String(port) },
    stdio: ['ignore', stdout, stderr],
    windowsHide: true,
  });

  fs.closeSync(stdout);
  fs.closeSync(stderr);
  writeSupervisorLog(`Started Vite process ${child.pid}.`);

  child.once('exit', (code, signal) => {
    writeSupervisorLog(`Vite exited with code ${code ?? 'null'} and signal ${signal ?? 'none'}.`);
    child = null;
    if (!stopping) setTimeout(ensureStarted, 1000);
  });
};

const stop = () => {
  stopping = true;
  if (child) child.kill();
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('uncaughtException', (error) => {
  fs.appendFileSync(errorLogPath, `[${new Date().toISOString()}] Supervisor error: ${error.stack || error}\n`);
  setTimeout(start, 1000);
});

writeSupervisorLog(`Supervisor started as process ${process.pid}.`);
ensureStarted();
