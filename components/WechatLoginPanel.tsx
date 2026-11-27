import React, { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../services/apiClient';
import { MessageSquareIcon } from './Icons';

export type AccountUser = { id: string; username: string; displayName?: string };
type ScanAttempt = { id: string; authorizationUrl: string; expiresAt: number };

async function requestWechat(path: string, method = 'GET') {
    const response = await apiFetch('/api/auth/wechat/' + path, { method, cache: 'no-store', signal: AbortSignal.timeout(20_000), ...(method === 'POST' ? { body: '{}' } : {}) });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload) throw new Error(payload?.error?.message || '微信登录服务暂时不可用，请稍后重试。');
    return payload;
}

export default function WechatLoginPanel({ onAuthenticated }: { onAuthenticated: (user: AccountUser) => void }) {
    const [attempt, setAttempt] = useState<ScanAttempt | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [failed, setFailed] = useState(false);
    const attemptRef = useRef<ScanAttempt | null>(null);
    const activeRef = useRef(true);
    const busyRef = useRef(false);
    const authenticatedRef = useRef(onAuthenticated);
    authenticatedRef.current = onAuthenticated;

    useEffect(() => {
        activeRef.current = true;
        return () => {
            activeRef.current = false;
            const active = attemptRef.current;
            if (active) void apiFetch('/api/auth/wechat/attempts/' + active.id + '/cancel', { method: 'POST', body: '{}', keepalive: true }).catch(() => {});
        };
    }, []);

    useEffect(() => {
        if (!attempt) return;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const result = await requestWechat('attempts/' + attempt.id);
                if (stopped) return;
                if (result.status === 'ready') {
                    setMessage('微信已授权，正在完成注册登录…');
                    const completed = await requestWechat('attempts/' + attempt.id + '/complete', 'POST');
                    if (stopped) return;
                    if (!completed.user?.id || !completed.user?.username) throw new Error('账号信息不完整，请重新扫码。');
                    attemptRef.current = null;
                    authenticatedRef.current(completed.user);
                    return;
                }
                if (result.status === 'error') throw new Error('微信授权未完成，请重新扫码并在手机上确认。');
                setMessage(result.status === 'processing' ? '正在验证微信授权…' : '请用微信扫码，并在手机上确认授权。');
                timer = setTimeout(() => void poll(), 2000);
            } catch (error) {
                if (!stopped) { setFailed(true); setMessage(error instanceof Error ? error.message : '扫码登录失败，请重新获取二维码。'); }
            }
        };
        timer = setTimeout(() => void poll(), 1000);
        return () => { stopped = true; clearTimeout(timer); };
    }, [attempt]);

    const start = async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        setFailed(false);
        setMessage('正在连接微信登录服务…');
        try {
            const previous = attemptRef.current;
            attemptRef.current = null;
            setAttempt(null);
            if (previous) await requestWechat('attempts/' + previous.id + '/cancel', 'POST').catch(() => {});
            const config = await requestWechat('config');
            if (!activeRef.current) return;
            if (!config.ready) throw new Error(config.message);
            if (config.secureCookies && !window.isSecureContext) throw new Error('微信账号登录需要安全连接，请使用 HTTPS 域名，或在服务电脑上使用 localhost 打开画布。');
            const created = await requestWechat('attempts', 'POST');
            const target = new URL(created.authorizationUrl);
            if (target.origin !== 'https://open.weixin.qq.com' || target.pathname !== '/connect/qrconnect') throw new Error('微信授权地址无效。');
            if (!activeRef.current) {
                void requestWechat('attempts/' + created.id + '/cancel', 'POST').catch(() => {});
                return;
            }
            attemptRef.current = created;
            setAttempt(created);
            setMessage('请用微信扫码，并在手机上确认授权。');
        } catch (error) {
            if (activeRef.current) { setFailed(true); setMessage(error instanceof Error ? error.message : '微信登录暂时不可用。'); }
        } finally {
            busyRef.current = false;
            if (activeRef.current) setBusy(false);
        }
    };

    return <section aria-label="微信扫码注册登录" className="mb-6">
        <button type="button" onClick={() => void start()} disabled={busy} className="home-wechat-button"><MessageSquareIcon className="h-5 w-5" /><span>{busy ? '正在获取二维码…' : attempt ? '重新获取微信二维码' : '微信扫码注册 / 登录'}</span></button>
        <p className="mt-2 text-[11px] leading-5 text-white/45">首次授权自动注册并生成唯一用户 ID，已有账号直接登录。仅用于验证微信身份，不读取聊天或联系人。</p>
        {attempt && !failed && <div className="mt-4 overflow-hidden rounded-2xl border border-white/15 bg-white"><iframe title="微信官方登录二维码" src={attempt.authorizationUrl} className="h-[400px] w-full border-0" referrerPolicy="no-referrer" /></div>}
        {message && <p role={failed ? 'alert' : 'status'} className={'mt-3 rounded-xl border p-3 text-xs leading-6 ' + (failed ? 'border-amber-200/15 bg-amber-100/5 text-amber-100/80' : 'border-emerald-100/10 bg-emerald-100/5 text-emerald-100/80')}>{message}</p>}
    </section>;
}
