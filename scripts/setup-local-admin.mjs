import path from 'node:path';
import os from 'node:os';
import { loadEnv } from 'vite';
import { loadConfig } from '../server/api-server.mjs';
import { provisionLocalAdministrator } from '../server/admin-bootstrap.mjs';

const environment = { ...process.env, ...loadEnv('development', process.cwd(), '') };
const result = provisionLocalAdministrator({
    ...loadConfig(environment),
    dataDir: environment.CANVAS_AUTH_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'Resonantor', 'auth'),
});
console.log(JSON.stringify(result, null, 2));
