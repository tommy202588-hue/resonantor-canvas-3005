import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const buildDirectory = path.join(projectRoot, 'dist-single-html');
const outputDirectory = path.join(projectRoot, 'single-html-dist');
const sourceHtmlPath = path.join(buildDirectory, 'index.html');
const outputHtmlPath = path.join(outputDirectory, '共智体画布-双击版.html');
const packageDirectory = path.join(projectRoot, 'desktop-companion-dist');
const packageHtmlPath = path.join(packageDirectory, 'resonantor-canvas-double-click.html');

const assetMimeTypes = {
  'home-flow.mp4': 'video/mp4',
  'home-flow-poster.jpg': 'image/jpeg',
  'home-title-mask.png': 'image/png',
  'resona-logo.webp': 'image/webp',
  'resona-wordmark.svg': 'image/svg+xml',
};

const toDataUri = async (name) => {
  const filePath = path.join(projectRoot, 'public', 'brand', name);
  const data = await readFile(filePath);
  return 'data:' + assetMimeTypes[name] + ';base64,' + data.toString('base64');
};

const resolveAssetPath = (assetUrl) => path.join(
  buildDirectory,
  decodeURIComponent(assetUrl).replace(/^\.\//, '').replace(/^\//, ''),
);

let html = await readFile(sourceHtmlPath, 'utf8');

const stylesheetMatches = [...html.matchAll(/<link\b(?=[^>]*\brel="stylesheet")(?=[^>]*\bhref="([^"]+)")[^>]*>/g)];
for (const match of stylesheetMatches) {
  const css = await readFile(resolveAssetPath(match[1]), 'utf8');
  html = html.replace(match[0], () => '<style>' + css.replace(/<\/style/gi, '<\\/style') + '</style>');
}

const scriptMatches = [...html.matchAll(/<script\b(?=[^>]*\btype="module")(?=[^>]*\bsrc="([^"]+)")[^>]*><\/script>/g)];
for (const match of scriptMatches) {
  const javascript = await readFile(resolveAssetPath(match[1]), 'utf8');
  html = html.replace(match[0], () => '<script type="module">' + javascript.replace(/<\/script/gi, '<\\/script') + '</script>');
}

const assets = Object.fromEntries(await Promise.all(Object.keys(assetMimeTypes).map(async name => [name, await toDataUri(name)])));
const bootstrap = '<script>window.__RESONANTOR_SINGLE_HTML__=true;window.__RESONANTOR_SERVER_URL__=\'\';window.__RESONANTOR_SINGLE_HTML_ASSETS__=' + JSON.stringify(assets) + ';</script>';
html = html
  .replace(/\s*<link\s+rel="(?:icon|modulepreload)"[^>]*>/gi, '')
  .replace(/\s*<script\s+type="importmap">[\s\S]*?<\/script>/gi, '')
  .replace(/<html\s+lang="[^"]*">/i, '<html lang="zh-CN">')
  .replace(/<title>[^<]*<\/title>/i, '<title>共智体画布 · 双击版</title>')
  .replace('</head>', bootstrap + '</head>');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await writeFile(outputHtmlPath, html, 'utf8');
await mkdir(packageDirectory, { recursive: true });
await copyFile(outputHtmlPath, packageHtmlPath);
await rm(buildDirectory, { recursive: true, force: true });

const sizeInMegabytes = Buffer.byteLength(html) / 1024 / 1024;
console.log('Single HTML generated: ' + outputHtmlPath);
console.log('Download package generated: ' + packageHtmlPath);
console.log('File size: ' + sizeInMegabytes.toFixed(2) + ' MB');
console.log('Project storage: browser IndexedDB; export .js files for desktop copies.');
