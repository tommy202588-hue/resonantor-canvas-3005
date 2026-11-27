import { HttpError } from './security.mjs';

export function createProxyRequestLifetime(request, response, timeoutMs) {
    const controller = new AbortController();
    const disconnect = () => controller.abort(new HttpError(499, '客户端已断开，已停止等待模型响应。', 'client_disconnected'));
    const close = () => { if (!response.writableEnded) disconnect(); };
    const timer = setTimeout(() => controller.abort(new HttpError(504, '模型响应超过最长等待时间，请先检查任务状态再手动重试。', 'upstream_timeout')), timeoutMs);
    timer.unref?.();
    request.once('aborted', disconnect);
    response.once('close', close);
    if (request.aborted || response.destroyed) disconnect();
    return {
        signal: controller.signal,
        run(operation) {
            return new Promise((resolve, reject) => {
                const abort = () => reject(controller.signal.reason);
                if (controller.signal.aborted) { abort(); return; }
                controller.signal.addEventListener('abort', abort, { once: true });
                Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation(); }).then(resolve, reject)
                    .finally(() => controller.signal.removeEventListener('abort', abort));
            });
        },
        dispose() {
            clearTimeout(timer);
            request.removeListener('aborted', disconnect);
            response.removeListener('close', close);
        },
    };
}
