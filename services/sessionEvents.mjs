let sessionVersion = 0;

export const getSessionVersion = () => sessionVersion;
export const advanceSessionVersion = () => ++sessionVersion;

export function reportLoginRequired(status, payload, requestVersion) {
    if (status !== 401 || payload?.error?.type !== 'login_required' || requestVersion !== sessionVersion) return;
    window.dispatchEvent(new CustomEvent('canvas:login-required', { detail: { sessionVersion: requestVersion } }));
}
