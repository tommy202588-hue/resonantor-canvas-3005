import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from './api-server.mjs';
import { replacePrivateFile } from './private-file.mjs';

export function provisionLocalAdministrator(config) {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const usersFile = path.join(config.dataDir, 'users.json');
    const credentialsFile = path.join(config.dataDir, 'admin-access.json');
    let users;
    try { users = JSON.parse(fs.readFileSync(usersFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Existing user data cannot be read; nothing was overwritten.'); users = []; }
    if (!Array.isArray(users)) throw new Error('Existing user data is invalid.');
    const administrator = users.find(user => user.role === 'admin' || user.id === 'admin');
    if (administrator) return { created: false, username: administrator.username, credentialsFile: fs.existsSync(credentialsFile) ? credentialsFile : null };
    const username = config.adminUser || 'admin';
    if (users.some(user => String(user.username).toLowerCase() === username.toLowerCase())) throw new Error('Administrator username is already used; choose a different CANVAS_ADMIN_USER.');
    if (fs.existsSync(credentialsFile)) throw new Error('An administrator credential file already exists; inspect it before provisioning.');
    const password = config.adminPassword || randomBytes(24).toString('base64url');
    if (password.length < 12) throw new Error('Administrator password must contain at least 12 characters.');
    const createdAt = Date.now();
    const user = { id: randomUUID(), username, displayName: config.adminDisplayName || '管理员', role: 'admin', passwordHash: hashPassword(password), createdAt };
    fs.writeFileSync(credentialsFile, JSON.stringify({ username, password, loginUrl: config.adminLoginUrl || 'http://localhost:3004/admin', createdAt }, null, 2), { flag: 'wx', mode: 0o600 });
    const temporary = usersFile + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify([...users, user], null, 2), { flag: 'wx', mode: 0o600 });
    replacePrivateFile(temporary, usersFile);
    return { created: true, username, credentialsFile };
}
