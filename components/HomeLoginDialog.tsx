import React, { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../services/apiClient';
import { LoginIcon, XIcon } from './Icons';
import WechatLoginPanel, { type AccountUser } from './WechatLoginPanel';

type LoginState = 'checking' | 'anonymous' | 'unavailable' | 'authenticated';
const unavailableMessage = '账号登录服务暂时不可用，请联系管理员。登录后才能创建、打开和保存画布工程。';

export default function HomeLoginDialog({ onClose, onAuthenticated, onBeforeLogout, onLoggedOut }: { onClose: () => void; onAuthenticated?: (user: AccountUser) => void | Promise<void>; onBeforeLogout?: () => Promise<void>; onLoggedOut?: () => void }) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const [status, setStatus] = useState<LoginState>('checking');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [mode, setMode] = useState<'login' | 'register'>('login');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [userId, setUserId] = useState('');
    const authenticated = async (user: AccountUser) => {
        await onAuthenticated?.(user);
        setDisplayName(user.displayName || user.username);
        setUserId(user.username);
        setStatus('authenticated');
        setPassword('');
        setConfirmPassword('');
        setMessage('');
    };
    const [message, setMessage] = useState('');
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        let active = true;
        const dialog = dialogRef.current;
        const previouslyFocused = document.activeElement;
        dialog?.showModal();
        void (async () => {
            try {
                const response = await apiFetch('/api/auth/me', { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
                const payload = await response.json().catch(() => null);
                if (!active) return;
                if (response.ok && typeof payload?.user?.username === 'string') {
                    await authenticated(payload.user);
                } else if (response.status === 401 && payload) {
                    setStatus('anonymous');
                } else {
                    setStatus('unavailable');
                    setMessage(unavailableMessage);
                }
            } catch {
                if (active) {
                    setStatus('unavailable');
                    setMessage('暂时无法连接登录服务，请稍后重试；未登录时只能浏览首页。');
                }
            }
        })();
        return () => {
            active = false;
            dialog?.close();
            if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus();
        };
    }, []);

    const logout = async () => {
        if (submitting) return;
        setSubmitting(true);
        setMessage('');
        try {
            await onBeforeLogout?.();
            const response = await apiFetch('/api/auth/logout', { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
            if (!response.ok) throw new Error('退出登录失败，请重试。');
            setStatus('anonymous');
            setDisplayName('');
            setUserId('');
            onLoggedOut?.();
        } catch { setMessage('退出登录失败，请检查连接后重试。'); }
        finally { setSubmitting(false); }
    };

    const submit = async (event: React.FormEvent) => {
        event.preventDefault();
        if (submitting || status !== 'anonymous' || !username.trim() || !password) return;
        if (mode === 'register' && password !== confirmPassword) { setMessage('两次输入的密码不一致。'); return; }
        setSubmitting(true);
        setMessage('');
        try {
            const response = await apiFetch(mode === 'register' ? '/api/auth/register' : '/api/auth/login', {
                method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(15_000),
                body: JSON.stringify({ username: username.trim(), password }),
            });
            const payload = await response.json().catch(() => null);
            if (response.ok && typeof payload?.user?.username === 'string') {
                await authenticated(payload.user);
            } else {
                setMessage(mode === 'register' && [400, 409].includes(response.status) ? payload?.error?.message || '注册信息无效，请检查后重试。' : response.status === 401 ? '用户名或密码不正确，请重新输入。' : response.status === 429 ? '操作过于频繁，请稍后重试。' : '账号服务暂时不可用，请稍后重试。');
            }
        } catch {
            setMessage(mode === 'register' ? '注册请求未确认，请检查连接；若账号已创建，可切换登录。' : '登录请求失败，请检查连接后重试。');
        } finally {
            setPassword('');
            setConfirmPassword('');
            setSubmitting(false);
        }
    };

    return <dialog ref={dialogRef} aria-labelledby="home-login-title" aria-describedby="home-login-description" className="home-glass home-login-dialog" onCancel={event => { event.preventDefault(); if (!submitting) onClose(); }}>
        <div className="mb-6 flex items-start justify-between gap-4">
            <div><div className="home-login-symbol mb-4"><LoginIcon className="h-6 w-6" /></div><h2 id="home-login-title" className="text-xl font-semibold">{status === 'authenticated' ? '已登录' : mode === 'register' ? '注册共智体' : '登录共智体'}</h2><p id="home-login-description" className="mt-2 text-xs leading-6 text-white/50">{mode === 'register' ? '创建普通用户账号，注册成功后自动登录。' : '连接你的创作账号，本地工程始终保留在电脑中。'}</p></div>
            <button type="button" onClick={onClose} disabled={submitting} aria-label="关闭登录窗口" className="rounded-xl p-2 text-white/50 hover:bg-white/10 hover:text-white disabled:opacity-40"><XIcon className="h-5 w-5" /></button>
        </div>
        {status === 'checking' && <p role="status" className="py-6 text-sm text-cyan-100/80">正在检查登录服务…</p>}
        {status === 'authenticated' && <><div role="status" className="home-glass rounded-2xl p-4 text-sm text-cyan-100"><p>欢迎回来，{displayName}。</p><p className="mt-3 text-xs text-white/50">用户 ID</p><code className="mt-1 block select-all break-all text-xs text-cyan-100">{userId}</code></div><button type="button" onClick={() => void logout()} disabled={submitting} className="mt-3 text-xs text-white/50 hover:text-white disabled:opacity-40">{submitting ? '正在退出…' : '退出登录'}</button>{message && <p role="alert" className="mt-2 text-xs text-rose-200">{message}</p>}</>}
        {status === 'anonymous' && <div role="group" aria-label="登录或注册" className="home-glass mb-5 grid grid-cols-2 gap-1 rounded-2xl p-1">{(['login', 'register'] as const).map(option => <button key={option} type="button" aria-pressed={mode === option} disabled={submitting} onClick={() => { setMode(option); setMessage(''); setPassword(''); setConfirmPassword(''); }} className={`rounded-xl py-2.5 text-sm transition-colors disabled:opacity-40 ${mode === option ? 'bg-white/15 text-cyan-100' : 'text-white/55 hover:bg-white/5 hover:text-white'}`}>{option === 'login' ? '账号登录' : '注册新账号'}</button>)}</div>}
        {status !== 'checking' && status !== 'authenticated' && mode === 'login' && <WechatLoginPanel onAuthenticated={user => { void authenticated(user).catch(() => setMessage('无法保存当前工程草稿，账号切换未完成。请先导出工程后重试。')); }} />}
        {status === 'anonymous' && <form onSubmit={event => void submit(event)} className="space-y-4">
            {mode === 'login' && <div className="flex items-center gap-3 py-1 text-[11px] text-white/35"><span className="h-px flex-1 bg-white/10" />或使用已有账号<span className="h-px flex-1 bg-white/10" /></div>}
            <label className="block text-xs text-white/65">用户名<input name="username" autoComplete="username" required minLength={mode === 'register' ? 3 : undefined} maxLength={mode === 'register' ? 32 : 128} pattern={mode === 'register' ? '[a-zA-Z0-9][a-zA-Z0-9_\\-]{2,31}' : undefined} value={username} onChange={event => setUsername(event.target.value)} disabled={submitting} className="home-login-input" /></label>
            {mode === 'register' && <p className="text-xs leading-5 text-white/45">用户名即用户 ID，先注册者获得该名称，不区分大小写。支持 3–32 位字母、数字、下划线或短横线，以字母或数字开头。</p>}
            <label className="block text-xs text-white/65">密码<input name="password" type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength={mode === 'register' ? 12 : undefined} maxLength={mode === 'register' ? 128 : undefined} value={password} onChange={event => setPassword(event.target.value)} disabled={submitting} className="home-login-input" /></label>
            {mode === 'register' && <><p className="text-xs leading-5 text-white/45">密码为 12–128 个字符，请妥善保存。</p><label className="block text-xs text-white/65">确认密码<input name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} disabled={submitting} className="home-login-input" /></label></>}
            {message && <p role="alert" className="text-xs leading-6 text-rose-200">{message}</p>}
            <button type="submit" disabled={submitting || !username.trim() || !password || (mode === 'register' && !confirmPassword)} className="home-primary w-full rounded-xl py-3 text-sm font-semibold text-zinc-950 disabled:opacity-40">{submitting ? (mode === 'register' ? '正在注册…' : '正在登录…') : (mode === 'register' ? '注册并登录' : '登录')}</button>
        </form>}
        {status === 'unavailable' && <p role="status" className="home-glass rounded-2xl p-4 text-sm leading-7 text-white/70">{message}</p>}
        <button type="button" onClick={onClose} disabled={submitting} className="mt-5 w-full rounded-xl py-2.5 text-xs text-white/55 hover:bg-white/5 hover:text-white disabled:opacity-40">{status === 'authenticated' ? '返回主页' : '暂不登录，返回首页'}</button>
    </dialog>;
}
