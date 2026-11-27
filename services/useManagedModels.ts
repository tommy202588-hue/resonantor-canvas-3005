import { useEffect, useState } from 'react';
import { apiFetch } from './apiClient';
import type { AppSettings } from '../types/settings';
import { getSessionVersion, reportLoginRequired } from './sessionEvents.mjs';

const empty = (): AppSettings => ({ imageProviders: [], videoProviders: [], textProviders: [], audioProviders: [], concurrencyLimit: 3 });

export function useManagedModels(enabled: boolean, needsLogin = false) {
    const [settings, setSettings] = useState<AppSettings>(empty);
    const [error, setError] = useState('');
    useEffect(() => {
        if (!enabled) { setSettings(empty()); setError(''); return; }
        if (needsLogin) return;
        let active = true;
        let busy = false;
        let revision = -1;
        let capacity = -1;
        const refresh = async () => {
            if (busy || document.hidden) return;
            busy = true;
            const requestVersion = getSessionVersion();
            try {
                const response = await apiFetch('/api/model-settings', { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
                const data = await response.json();
                if (!active || requestVersion !== getSessionVersion()) return;
                reportLoginRequired(response.status, data, requestVersion);
                if (!response.ok) throw new Error('无法读取后台模型配置，请稍后重试。');
                if (active) {
                    if (!['image', 'video', 'text', 'audio'].every(group => Array.isArray(data.settings?.[group + 'Providers']))) throw new Error('模型配置格式无效');
                    if (revision !== data.revision || capacity !== data.settings.concurrencyLimit) { setSettings(data.settings); revision = data.revision; capacity = data.settings.concurrencyLimit; }
                    setError(['image', 'video', 'text', 'audio'].some(group => data.settings[group + 'Providers'].some(provider => provider.hasApiKey && provider.models.length)) ? '' : '模型尚未由管理员配置，请联系管理员在后台“模型设置”中添加。');
                }
            } catch { if (active && requestVersion === getSessionVersion()) setError('后台模型配置暂时无法同步，请检查服务连接。'); }
            finally { busy = false; }
        };
        void refresh();
        const focus = () => void refresh();
        window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
        const interval = setInterval(focus, 30_000);
        return () => { active = false; clearInterval(interval); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
    }, [enabled, needsLogin]);
    return { settings, error };
}
