import React, { useEffect, useState } from 'react';
import { apiFetch } from '../services/apiClient';

type AuthUser = {
    id: string;
    username: string;
    displayName: string;
};

type AuthState =
    | { status: 'checking' }
    | { status: 'anonymous'; message?: string }
    | { status: 'authenticated'; user: AuthUser };

const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [auth, setAuth] = useState<AuthState>({ status: 'checking' });
    const [username, setUsername] = useState('admin');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const checkSession = async () => {
        try {
            const response = await apiFetch('/api/auth/me', { cache: 'no-store' });
            if (!response.ok) {
                setAuth({ status: 'anonymous' });
                return;
            }
            const payload = await response.json();
            setAuth({ status: 'authenticated', user: payload.user });
        } catch {
            setAuth({ status: 'anonymous', message: '暂时无法连接画布服务。' });
        }
    };

    useEffect(() => {
        void checkSession();
    }, []);

    const handleLogin = async (event: React.FormEvent) => {
        event.preventDefault();
        setIsSubmitting(true);
        try {
            const response = await apiFetch('/api/auth/login', {
                method: 'POST',
                cache: 'no-store',
                body: JSON.stringify({ username: username.trim(), password })
            });
            if (!response.ok) {
                setPassword('');
                setAuth({
                    status: 'anonymous',
                    message: response.status === 401
                        ? '用户名或密码不正确。'
                        : `登录服务异常（HTTP ${response.status}）。`
                });
                return;
            }
            window.location.reload();
        } catch {
            setAuth({ status: 'anonymous', message: '登录请求失败，请稍后再试。' });
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleLogout = async () => {
        await apiFetch('/api/auth/logout', { method: 'POST', cache: 'no-store' }).catch(() => undefined);
        setPassword('');
        setAuth({ status: 'anonymous' });
    };

    if (auth.status === 'checking') {
        return <div className="flex min-h-screen items-center justify-center bg-[#07090d] text-sm text-zinc-400">正在进入画布...</div>;
    }

    if (auth.status === 'anonymous') {
        return (
            <div className="flex min-h-screen items-center justify-center bg-[#07090d] px-6 text-white">
                <form onSubmit={handleLogin} className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-950/95 p-5 shadow-2xl shadow-black/40">
                    <div className="mb-5">
                        <h1 className="text-lg font-semibold text-zinc-100">共振画布登录</h1>
                        <p className="mt-1 text-xs text-zinc-500">登录后可使用 AI 代理与云端画布保存。</p>
                    </div>
                    <label className="mb-3 block">
                        <span className="mb-1 block text-xs font-medium text-zinc-400">用户名</span>
                        <input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" className="h-10 w-full rounded-md border border-zinc-800 bg-black px-3 text-sm text-zinc-100 outline-none focus:border-cyan-500" />
                    </label>
                    <label className="mb-4 block">
                        <span className="mb-1 block text-xs font-medium text-zinc-400">密码</span>
                        <input value={password} onChange={event => setPassword(event.target.value)} type={showPassword ? 'text' : 'password'} name="canvas-password-v3" autoComplete="current-password" className="h-10 w-full rounded-md border border-zinc-800 bg-black px-3 text-sm text-zinc-100 outline-none focus:border-cyan-500" />
                        <span className="mt-2 flex items-center justify-between text-xs text-zinc-500">
                            <label className="flex cursor-pointer items-center gap-2">
                                <input type="checkbox" checked={showPassword} onChange={event => setShowPassword(event.target.checked)} className="size-3.5 accent-cyan-500" />
                                显示密码
                            </label>
                            <span>已输入 {password.length} 位</span>
                        </span>
                    </label>
                    {auth.message && <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{auth.message}</div>}
                    <button type="submit" disabled={isSubmitting || !username.trim() || !password} className="h-10 w-full rounded-md bg-cyan-500 text-sm font-semibold text-zinc-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500">
                        {isSubmitting ? '正在登录...' : '登录'}
                    </button>
                </form>
            </div>
        );
    }

    return (
        <>
            <div className="absolute right-36 top-4 z-[70] flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/90 px-3 py-2 text-xs text-zinc-300 shadow-xl backdrop-blur-md max-md:right-4 max-md:top-16">
                <span>{auth.user.displayName || auth.user.username}</span>
                <button type="button" onClick={handleLogout} className="rounded-md border border-zinc-700 px-2 py-1 text-zinc-400 hover:border-red-400/50 hover:text-red-200">退出</button>
            </div>
            {children}
        </>
    );
};

export default AuthGate;
