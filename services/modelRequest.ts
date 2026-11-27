import axios from 'axios';
import { apiPath } from './apiClient';
import { prepareManagedRequest } from './modelTransport.mjs';
import { getSessionVersion, reportLoginRequired } from './sessionEvents.mjs';

export const modelFetch: typeof fetch = async (input, init: RequestInit = {}) => {
    const requestVersion = getSessionVersion();
    const target = input instanceof Request ? input.url : String(input);
    const payload = await prepareManagedRequest(target, init, window.location.href);
    if (!payload) return globalThis.fetch(input, init);
    const response = await globalThis.fetch(apiPath('/api/model-request'), {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: init.signal,
    });
    if (response.status === 401) {
        const data = await response.clone().json().catch(() => null);
        reportLoginRequired(response.status, data, requestVersion);
    }
    return response;
};

export const managedApiFetch = (path: string, init: RequestInit = {}) => modelFetch(apiPath(path), { credentials: 'include', ...init });

export const modelAxios = axios.create();
modelAxios.interceptors.request.use(async config => {
    (config as typeof config & { canvasSessionVersion: number }).canvasSessionVersion = getSessionVersion();
    const target = new URL(config.url!, window.location.href);
    if (config.params) for (const [key, value] of Object.entries(config.params)) if (value !== undefined) target.searchParams.set(key, String(value));
    const payload = await prepareManagedRequest(target.href, { method: config.method?.toUpperCase(), headers: config.headers.toJSON(), body: config.data }, window.location.href);
    if (payload) {
        config.url = apiPath('/api/model-request'); config.baseURL = ''; config.method = 'POST'; config.params = undefined;
        config.headers.clear(); config.headers.set('Content-Type', 'application/json'); config.data = JSON.stringify(payload); config.withCredentials = true;
    }
    return config;
});
modelAxios.interceptors.response.use(response => response, error => {
    reportLoginRequired(error.response?.status, error.response?.data, error.config?.canvasSessionVersion);
    return Promise.reject(error);
});
