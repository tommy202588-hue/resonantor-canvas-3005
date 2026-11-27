import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMiniMaxAudioPayload, decodeMiniMaxAudio, MINIMAX_AUDIO_MODEL, MINIMAX_AUDIO_VOICE } from '../services/minimaxAudio.mjs';
import { resolveModelRequest } from './model-request.mjs';

const response = (hex = '494433', format = 'mp3') => ({ base_resp: { status_code: 0 }, data: { audio: hex, status: 2 }, extra_info: { audio_format: format } });

test('MiniMax audio uses native speech fields and replaces legacy OpenAI voice', () => {
    const payload = buildMiniMaxAudioPayload('你好，共智体。', undefined, { voice: 'alloy', seconds: '10' });
    assert.equal(payload.model, MINIMAX_AUDIO_MODEL);
    assert.equal(payload.text, '你好，共智体。');
    assert.equal(payload.voice_setting.voice_id, MINIMAX_AUDIO_VOICE);
    assert.equal(payload.stream, false);
    assert.equal(payload.output_format, 'hex');
    assert.deepEqual(payload.audio_setting, { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 });
    assert.equal(payload.input, undefined);
    assert.equal(payload.seconds, undefined);
    assert.equal(buildMiniMaxAudioPayload('hello', 'speech-2.8-hd', { voice: 'custom_voice' }).voice_setting.voice_id, 'custom_voice');
});

test('MiniMax audio validates text and output formats', () => {
    for (const text of ['', '  ', null, '字'.repeat(10000)]) assert.throws(() => buildMiniMaxAudioPayload(text));
    assert.doesNotThrow(() => buildMiniMaxAudioPayload('字'.repeat(9999)));
    assert.throws(() => buildMiniMaxAudioPayload('hello', undefined, { format: 'unknown' }));
    assert.equal(buildMiniMaxAudioPayload('hello', undefined, { format: 'wav' }).audio_setting.format, 'wav');
});

test('MiniMax hex audio becomes persistent playable data URLs without corrupting bytes', () => {
    assert.equal(decodeMiniMaxAudio(response()), 'data:audio/mpeg;base64,SUQz');
    const bytes = Buffer.alloc(100001, 177);
    const decoded = decodeMiniMaxAudio(response(bytes.toString('hex')));
    assert.deepEqual(Buffer.from(decoded.split(',')[1], 'base64'), bytes);
    assert.match(decodeMiniMaxAudio(response('52494646', 'wav')), /^data:audio\/wav;base64,/);
});

test('MiniMax business errors and incomplete audio never become success results', () => {
    assert.throws(() => decodeMiniMaxAudio({ base_resp: { status_code: 1004, status_msg: 'private-secret' } }), /鉴权失败/);
    assert.throws(() => decodeMiniMaxAudio({ base_resp: { status_code: 1008 } }), /余额不足/);
    assert.throws(() => decodeMiniMaxAudio({ base_resp: { status_code: 1002 } }), /过于频繁/);
    for (const audio of ['', 'ABC', 'https://example.com/audio.mp3', 'GG']) assert.throws(() => decodeMiniMaxAudio(response(audio)));
    assert.throws(() => decodeMiniMaxAudio({ ...response(), data: { audio: '494433', status: 1 } }));
    assert.throws(() => decodeMiniMaxAudio(null));
});

test('native MiniMax T2A is restricted to configured models and validated synchronous requests', () => {
    const provider = { id: 'audio', type: 'minimax', baseUrl: 'https://api.minimax.cn', apiKey: 'isolated-test-secret', models: [{ id: MINIMAX_AUDIO_MODEL }] };
    const store = { resolve: () => provider };
    const request = { providerId: 'audio', targetUrl: 'https://api.minimax.cn/v1/t2a_v2', method: 'POST', payload: buildMiniMaxAudioPayload('hello') };
    assert.equal(resolveModelRequest(store, request).headers.authorization, 'Bearer isolated-test-secret');
    for (const payload of [{ ...request.payload, model: 'not-configured' }, { ...request.payload, stream: true }, { ...request.payload, text: '' }]) assert.throws(() => resolveModelRequest(store, { ...request, payload }));
    assert.throws(() => resolveModelRequest(store, { ...request, targetUrl: 'https://other.example/v1/t2a_v2' }));
    assert.throws(() => resolveModelRequest({ resolve: () => ({ ...provider, type: 'openai' }) }, request));
});
