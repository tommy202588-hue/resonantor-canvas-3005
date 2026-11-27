import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function loadSessionSecret(config) {
    if (config.sessionSecret) {
        if (Buffer.byteLength(config.sessionSecret) < 32) throw new Error('CANVAS_SESSION_SECRET must contain at least 32 bytes.');
        return config.sessionSecret;
    }
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const filename = path.join(config.dataDir, 'session.key');
    try { fs.writeFileSync(filename, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const secret = fs.readFileSync(filename, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error('The stored session key is invalid; restore it from a secure backup.');
    return secret;
}
