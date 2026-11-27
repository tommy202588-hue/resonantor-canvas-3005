import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { withPublicBasePath } from './public-path.mjs';

export function serveModelConsole(response, publicBasePath = '') {
    const nonce = randomBytes(18).toString('base64');
    const html = fs.readFileSync(new URL('./model-console.html', import.meta.url), 'utf8');
    const script = fs.readFileSync(new URL('./model-console-client.js', import.meta.url), 'utf8');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    response.end(withPublicBasePath(html.replace('SCRIPT_PLACEHOLDER', '<script nonce="' + nonce + '">' + script + '</script>'), publicBasePath));
}
