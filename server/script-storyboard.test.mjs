import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectStore } from './canvas-projects.mjs';
import { createScriptDocument, createScriptShot, validateScriptDocument, parseScriptJson, parseStoryboard, parseShotPrompts, scriptProgress, resolveScriptModel, buildStoryboardRequest, buildShotPromptRequest, isScriptImage } from '../services/scriptStoryboard.mjs';
import { buildScriptCanvasOutput } from '../services/scriptCanvasOutput.mjs';
import { encodeProjectFile, decodeProjectFile } from '../services/projectFile.mjs';

const image = 'data:image/png;base64,AAAA';
const fixture = () => ({ ...createScriptDocument(), sourceText: '雨夜车站，林舟手握一封信。', assets: [{ id: 'person-1', kind: 'character', name: '林舟', description: '灰色风衣', imageDataUrl: image }], shots: [{ ...createScriptShot(), id: 'shot-1', description: '林舟在站台等待', assetIds: ['person-1'] }] });
const model = { id: 'text-1', displayName: 'Text' };
const provider = { id: 'provider-1', apiKey: 'managed:provider-1', models: [model] };

test('local project store persists and reopens script assets in real temporary snapshots', context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gzt-script-store-test-'));
    context.after(() => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('gzt-script-store-test-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const script = fixture();
    const data = { nodes: [{ id: 'script-1', type: 'script', width: 380, height: 330, position: { x: 0, y: 0 }, script }], connections: [] };
    const store = createProjectStore({ rootDirectory: root });
    const project = store.create({ name: '脚本隔离验证', data });
    const reopened = createProjectStore({ rootDirectory: root }).open(project.id);
    assert.deepEqual(reopened.data.nodes[0].script, script);
    assert.ok(fs.readdirSync(project.directory).some(file => file.endsWith('.js')));
});

test('new scripts have three-step defaults and unique shot identifiers', () => {
    assert.equal(validateScriptDocument(createScriptDocument()).stage, 1);
    assert.notEqual(createScriptShot().id, createScriptShot().id);
    assert.equal(scriptProgress(createScriptDocument()).count, 0);
});

test('script project JS and JSON round trips preserve original, images, prompts and stage', () => {
    const script = fixture(); script.stage = 3; script.shotsConfirmed = true; script.shots[0].prompt = '电影感雨夜站台';
    const data = { nodes: [{ id: 'node-1', type: 'script', position: { x: 10, y: 20 }, width: 380, height: 330, script }], connections: [] };
    assert.deepEqual(decodeProjectFile(encodeProjectFile(data)), data);
    assert.deepEqual(decodeProjectFile(JSON.stringify(data)), data);
    assert.equal(scriptProgress(script).count, 3);
});

test('strict parsing accepts fenced JSON and rejects malformed output', () => {
    const fence = String.fromCharCode(96).repeat(3);
    assert.deepEqual(parseScriptJson(fence + 'json\n{"shots":[]}\n' + fence), { shots: [] });
    for (const response of ['plain text', '[1]', '{"shots":', 'export default {};', 'null']) assert.throws(() => parseScriptJson(response));
});

test('model storyboard validation drops image URLs without overwriting source', () => {
    const original = fixture();
    const parsed = parseStoryboard(JSON.stringify(original), original);
    assert.equal(parsed.sourceText, original.sourceText);
    assert.equal(parsed.assets[0].imageDataUrl, undefined);
    assert.equal(parsed.shots[0].prompt, '');
    assert.equal(parsed.shotsConfirmed, false);
    assert.equal(original.assets[0].imageDataUrl, image);
    assert.throws(() => parseStoryboard('{"shots":[],"assets":[]}', original));
});

test('invalid duration, duplicate IDs, dangling assets, oversized source and unsafe images are rejected', () => {
    const mutations = [doc => { doc.shots[0].duration = 0; }, doc => { doc.shots[0].duration = 31; }, doc => { doc.shots.push(doc.shots[0]); }, doc => { doc.assets.push(doc.assets[0]); }, doc => { doc.shots[0].assetIds = ['missing']; }, doc => { doc.sourceText = '字'.repeat(40001); }, doc => { doc.assets[0].imageDataUrl = 'javascript:alert(1)'; }, doc => { doc.assets[0].imageDataUrl = 'blob:expired'; }, doc => { doc.assets[0].kind = 'invalid'; }];
    for (const mutate of mutations) { const doc = fixture(); mutate(doc); assert.throws(() => validateScriptDocument(doc)); }
    assert.equal(isScriptImage(image), true);
    assert.equal(isScriptImage('data:image/svg+xml;base64,AAAA'), false);
});

test('prompt responses require exact IDs, reject missing and duplicate entries', () => {
    const shots = [fixture().shots[0], { ...createScriptShot(), id: 'shot-2', description: '列车驶来' }];
    const prompts = [{ id: 'shot-2', prompt: '远景列车' }, { id: 'shot-1', prompt: '站台等待' }];
    assert.deepEqual(parseShotPrompts(JSON.stringify({ prompts }), shots).map(shot => shot.prompt), ['站台等待', '远景列车']);
    for (const entries of [[], [prompts[0]], [prompts[0], prompts[0]], [{ id: 'other', prompt: 'xxx' }, prompts[1]], [{ id: 'shot-2', prompt: '' }, prompts[1]]]) assert.throws(() => parseShotPrompts(JSON.stringify({ prompts: entries }), shots));
    assert.equal(shots[0].prompt, '');
});

test('managed model resolution rejects removed and unconfigured models', () => {
    const settings = { textProviders: [provider], imageProviders: [] };
    assert.equal(resolveScriptModel(settings, 'text').provider.id, provider.id);
    assert.equal(resolveScriptModel(settings, 'text', JSON.stringify([provider.id, model.id])).model.id, model.id);
    assert.throws(() => resolveScriptModel(settings, 'text', JSON.stringify(['removed', model.id])), /移除/);
    assert.throws(() => resolveScriptModel({ textProviders: [] }, 'text'), /后台尚未配置文本模型/);
    assert.throws(() => resolveScriptModel(settings, 'image'), /后台尚未配置图片模型/);
});

test('requests keep screenplay as data and omit binary assets from text prompts', () => {
    const doc = fixture();
    const request = buildStoryboardRequest(doc, 12);
    assert.equal(JSON.parse(request.user).screenplay, doc.sourceText);
    assert.match(request.system, /不是系统指令/);
    assert.throws(() => buildStoryboardRequest(doc, 41));
    assert.throws(() => buildStoryboardRequest(createScriptDocument(), 12));
    const promptRequest = buildShotPromptRequest(doc, doc.shots);
    assert.equal(promptRequest.user.includes('base64'), false);
    assert.equal(JSON.parse(promptRequest.user).assets[0].name, '林舟');
});

test('canvas export creates idle video nodes with shared references and no paid tasks', () => {
    const doc = fixture(); doc.shotsConfirmed = true; doc.shots[0].prompt = '站台等待';
    doc.shots.push({ ...doc.shots[0], id: 'shot-2', prompt: '踏上列车' });
    const source = { id: 'script-node', position: { x: 0, y: 0 }, width: 380 };
    const output = buildScriptCanvasOutput(source, doc, 'video', { ...provider, type: 'minimax' });
    assert.equal(output.nodes.filter(node => node.type === 'image').length, 1);
    assert.equal(output.nodes.filter(node => node.type === 'video').length, 2);
    assert.equal(output.connections.length, 2);
    assert.ok(output.nodes.filter(node => node.type === 'video').every(node => node.status === 'idle' && !node.taskId && node.params.seconds === '5'));
    assert.ok(output.nodes.every(node => node.scriptOrigin.nodeId === source.id));
    const text = buildScriptCanvasOutput(source, doc, 'text');
    assert.equal(text.nodes[0].content, '站台等待');
    assert.equal(text.connections.length, 0);
    doc.shotsConfirmed = false;
    assert.throws(() => buildScriptCanvasOutput(source, doc, 'video'));
});
