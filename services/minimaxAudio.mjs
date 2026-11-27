export const MINIMAX_AUDIO_MODEL = 'speech-2.8-hd';
export const MINIMAX_AUDIO_VOICE = 'male-qn-qingse';
const MIME_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac' };

export function buildMiniMaxAudioPayload(text, model = MINIMAX_AUDIO_MODEL, options = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('请先输入需要合成的语音文本。');
    if (text.length >= 10000) throw new Error('MiniMax 同步语音文本需少于 10000 个字符，请拆分后生成。');
    const format = options.format || 'mp3';
    if (!Object.hasOwn(MIME_TYPES, format)) throw new Error('MiniMax 语音目前支持 MP3、WAV 或 FLAC 格式。');
    const voice = options.voice && options.voice !== 'alloy' ? options.voice : MINIMAX_AUDIO_VOICE;
    return {
        model, text, stream: false, output_format: 'hex',
        voice_setting: { voice_id: voice, speed: 1, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format, channel: 1 },
        subtitle_enable: false,
    };
}

export function decodeMiniMaxAudio(data, requestedFormat = 'mp3') {
    const code = data?.base_resp?.status_code;
    if (code !== 0) {
        const errors = {
            1001: 'MiniMax 语音合成超时，请稍后重试。',
            1002: 'MiniMax 请求过于频繁，请稍后重试。',
            1004: 'MiniMax API 密钥鉴权失败，请管理员检查后台音频密钥。',
            1008: 'MiniMax 账户余额不足，请充值后重试。',
            1039: 'MiniMax 语音额度速率受限，请稍后重试。',
            1042: '文本包含过多不支持的字符，请修改后重试。',
            2013: 'MiniMax 语音参数无效，请检查模型、音色和文本。',
        };
        throw new Error(errors[code] || (Number.isInteger(code) ? 'MiniMax 语音合成失败（错误码 ' + code + '），请联系管理员。' : 'MiniMax 返回的语音响应格式无效。'));
    }
    const hex = data?.data?.audio;
    if (data?.data?.status !== 2 || typeof hex !== 'string' || !hex.length || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) throw new Error('MiniMax 未返回完整有效的音频，请重试。');
    const format = data.extra_info?.audio_format || requestedFormat;
    if (!Object.hasOwn(MIME_TYPES, format)) throw new Error('MiniMax 返回了不支持的音频格式。');
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return 'data:' + MIME_TYPES[format] + ';base64,' + btoa(binary);
}
