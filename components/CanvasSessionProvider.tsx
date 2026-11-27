import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import HomeLoginDialog from './HomeLoginDialog';
import type { AccountUser } from './WechatLoginPanel';
import { apiFetch } from '../services/apiClient';
import { isSingleHtmlRuntime } from '../services/runtimeMode';
import { advanceSessionVersion, getSessionVersion } from '../services/sessionEvents.mjs';

type SessionContext = {
    user: AccountUser | null;
    checking: boolean;
    needsLogin: boolean;
    accountVersion: number;
    requestLogin: () => void;
    requireLogin: (action: () => unknown | Promise<unknown>) => Promise<void>;
    registerBeforeAccountChange: (save: () => Promise<void>) => () => void;
};
const Context = createContext<SessionContext | null>(null);

export function useCanvasSession() {
    const session = useContext(Context);
    if (!session) throw new Error('Canvas session provider is missing.');
    return session;
}

export default function CanvasSessionProvider({ children }: { children: React.ReactNode }) {
    const standalone = isSingleHtmlRuntime();
    const [user, setUser] = useState<AccountUser | null>(null);
    const [checking, setChecking] = useState(true);
    const [needsLogin, setNeedsLogin] = useState(false);
    const [accountVersion, setAccountVersion] = useState(0);
    const [loginOpen, setLoginOpen] = useState(false);
    const [resumeVersion, setResumeVersion] = useState(0);
    const pending = useRef<(() => unknown | Promise<unknown>) | null>(null);
    const userRef = useRef<AccountUser | null>(null);
    const sequence = useRef(0);
    const checkingFlight = useRef<Promise<AccountUser | null> | null>(null);
    const actionInFlight = useRef(false);
    const needsLoginRef = useRef(false);
    const beforeAccountChange = useRef(new Set<() => Promise<void>>());
    const registerBeforeAccountChange = useCallback((save: () => Promise<void>) => {
        beforeAccountChange.current.add(save);
        return () => { beforeAccountChange.current.delete(save); };
    }, []);
    const preserveAccount = useCallback(async () => {
        for (const save of beforeAccountChange.current) await save();
    }, []);
    const setSession = useCallback((next: AccountUser | null) => {
        if (userRef.current && userRef.current.id !== next?.id) setAccountVersion(value => value + 1);
        advanceSessionVersion();
        userRef.current = next;
        needsLoginRef.current = false;
        setUser(next);
        setNeedsLogin(false);
    }, []);
    const verify = useCallback(() => {
        if (checkingFlight.current) return checkingFlight.current;
        const version = sequence.current;
        const flight = (async () => {
            try {
                const response = await apiFetch('/api/auth/me', { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
                const payload = await response.json().catch(() => null);
                if (version !== sequence.current) return userRef.current;
                if (response.ok && typeof payload?.user?.id === 'string') {
                    setSession(payload.user as AccountUser);
                    return payload.user as AccountUser;
                }
                return null;
            } catch {
                return null;
            } finally { setChecking(false); checkingFlight.current = null; }
        })();
        checkingFlight.current = flight;
        return flight;
    }, [setSession]);

    useEffect(() => {
        if (standalone) { setChecking(false); return; }
        void verify();
        const unauthorized = (event: Event) => {
            const requestVersion = (event as CustomEvent<{ sessionVersion: number }>).detail?.sessionVersion;
            if (requestVersion !== getSessionVersion() || !userRef.current) return;
            needsLoginRef.current = true;
            setNeedsLogin(true);
        };
        window.addEventListener('canvas:login-required', unauthorized);
        return () => { window.removeEventListener('canvas:login-required', unauthorized); };
    }, [standalone, verify]);

    useEffect(() => {
        if (!user || needsLogin || loginOpen || !pending.current) return;
        const action = pending.current;
        pending.current = null;
        void Promise.resolve().then(action).catch(error => console.error('Canvas action failed:', error));
    }, [user, needsLogin, loginOpen, resumeVersion]);

    const requireLogin = useCallback(async (action: () => unknown | Promise<unknown>) => {
        if (actionInFlight.current) return;
        actionInFlight.current = true;
        try {
            if (userRef.current && !needsLoginRef.current) await action();
            else { pending.current = action; setLoginOpen(true); }
        } finally { actionInFlight.current = false; }
    }, []);
    const requestLogin = useCallback(() => { pending.current = null; setLoginOpen(true); }, []);
    const authenticated = useCallback(async (next: AccountUser) => {
        const previous = userRef.current;
        const wasExpired = needsLoginRef.current;
        const version = ++sequence.current;
        if (previous && previous.id !== next.id) {
            await preserveAccount();
            pending.current = null;
        }
        if (version !== sequence.current) return;
        setSession(next);
        setChecking(false);
        if (wasExpired || pending.current) setResumeVersion(value => value + 1);
        if ((wasExpired && previous && previous.id === next.id) || pending.current) setLoginOpen(false);
    }, [setSession, preserveAccount]);
    const loggedOut = useCallback(() => { sequence.current += 1; pending.current = null; setSession(null); }, [setSession]);

    return <Context.Provider value={{ user, checking, needsLogin, accountVersion, requestLogin, requireLogin, registerBeforeAccountChange }}>
        {children}
        {needsLogin && <div role="status" className="fixed bottom-6 left-1/2 z-[70] flex max-w-[90vw] -translate-x-1/2 items-center gap-4 rounded-xl border border-amber-300/20 bg-zinc-900/95 px-4 py-3 text-sm text-amber-100 shadow-xl">
            <span>登录已失效，当前工程已保留。</span>
            <button type="button" onClick={requestLogin} className="shrink-0 text-cyan-200 underline">重新登录</button>
        </div>}
        {loginOpen && <HomeLoginDialog onClose={() => { pending.current = null; setLoginOpen(false); }} onAuthenticated={authenticated} onBeforeLogout={preserveAccount} onLoggedOut={loggedOut} />}
    </Context.Provider>;
}
