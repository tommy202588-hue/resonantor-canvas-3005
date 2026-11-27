const message = document.getElementById('message');
const login = document.getElementById('login');
const editor = document.getElementById('editor');
const servers = document.getElementById('servers');
const activeServer = document.getElementById('active-server');
const activeHint = document.getElementById('active-hint');
const revision = document.getElementById('revision');
let documentState = null;

const request = async (path, method = 'GET', body) => {
    const response = await fetch('/api/' + path, { method, credentials: 'same-origin', cache: 'no-store', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json().catch(() => null);
    return { response, data };
};
const setBusy = busy => document.querySelectorAll('button,input,select').forEach(element => { element.disabled = busy; });
const input = (labelText, name, value, options = {}) => {
    const label = document.createElement('label');
    label.textContent = labelText;
    const field = document.createElement(options.select ? 'select' : 'input');
    field.name = name;
    field.value = value || '';
    if (options.type) field.type = options.type;
    if (options.placeholder) field.placeholder = options.placeholder;
    if (options.required !== false) field.required = true;
    if (options.select) for (const option of options.select) { const item = document.createElement('option'); item.value = option.value; item.textContent = option.label; if (option.value === value) item.selected = true; field.appendChild(item); }
    label.appendChild(field);
    return { label, field };
};
const syncKind = card => {
    const kind = card.querySelector('[name="kind"]').value;
    card.dataset.kind = kind;
    const install = card.querySelector('[name="installRoot"]');
    install.required = kind === 'local';
};
const createServerCard = server => {
    const card = document.createElement('section');
    card.className = 'server';
    card.dataset.server = 'true';
    const header = document.createElement('header');
    const title = document.createElement('h3');
    title.textContent = server.name || '未命名 GPU 服务';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = '移除此服务';
    remove.addEventListener('click', () => { card.remove(); refreshActiveOptions(); });
    header.append(title, remove);
    const fields = document.createElement('div');
    fields.className = 'fields';
    const id = input('服务 ID', 'id', server.id, { placeholder: 'gpu-render-01' });
    const name = input('显示名称', 'name', server.name, { placeholder: '渲染 GPU 01' });
    const kind = input('服务类型', 'kind', server.kind, { select: [{ value: 'local', label: '本机托管 GPU' }, { value: 'remote', label: '内网远程 GPU' }] });
    const comfy = input('ComfyUI 地址', 'comfyUrl', server.comfyUrl, { placeholder: 'http://127.0.0.1:8188' });
    const seed = input('SeedVR2 地址', 'seedUrl', server.seedUrl, { placeholder: 'http://127.0.0.1:8190' });
    const install = input('ComfyUI 安装路径（仅本机托管）', 'installRoot', server.installRoot || '', { placeholder: 'D:/other/comfyui/ComfyUI-aki-v1.7/ComfyUI-aki-v1.7' });
    install.label.classList.add('wide', 'local-only');
    fields.append(id.label, name.label, kind.label, comfy.label, seed.label, install.label);
    name.field.addEventListener('input', () => { title.textContent = name.field.value.trim() || '未命名 GPU 服务'; refreshActiveOptions(false); });
    id.field.addEventListener('input', () => refreshActiveOptions(false));
    kind.field.addEventListener('change', () => syncKind(card));
    card.append(header, fields);
    syncKind(card);
    return card;
};
const collectSettings = () => ({
    activeServerId: activeServer.value,
    servers: Array.from(servers.querySelectorAll('[data-server]')).map(card => ({
        id: card.querySelector('[name="id"]').value.trim(),
        name: card.querySelector('[name="name"]').value.trim(),
        kind: card.querySelector('[name="kind"]').value,
        comfyUrl: card.querySelector('[name="comfyUrl"]').value.trim(),
        seedUrl: card.querySelector('[name="seedUrl"]').value.trim(),
        installRoot: card.querySelector('[name="installRoot"]').value.trim(),
    })),
});
function refreshActiveOptions(preserve = true) {
    const selected = preserve ? activeServer.value : null;
    const entries = Array.from(servers.querySelectorAll('[data-server]')).map(card => ({ id: card.querySelector('[name="id"]').value.trim(), name: card.querySelector('[name="name"]').value.trim() }));
    activeServer.replaceChildren();
    for (const entry of entries) { if (!entry.id) continue; const option = document.createElement('option'); option.value = entry.id; option.textContent = (entry.name || entry.id) + ' · ' + entry.id; activeServer.appendChild(option); }
    if (entries.some(entry => entry.id === selected)) activeServer.value = selected;
    else if (documentState?.settings.activeServerId && entries.some(entry => entry.id === documentState.settings.activeServerId)) activeServer.value = documentState.settings.activeServerId;
    activeHint.textContent = entries.length ? '本机托管服务可由后台自动启动；远程服务仅会被安全地连接和提交任务。' : '请至少添加一个 GPU 服务。';
}
function render(payload) {
    documentState = payload;
    servers.replaceChildren();
    for (const server of payload.settings.servers) servers.appendChild(createServerCard(server));
    refreshActiveOptions();
    activeServer.value = payload.settings.activeServerId;
    revision.textContent = '配置版本 ' + payload.revision + ' · 保存时将进行内网与路径校验';
}
async function load() {
    message.textContent = '';
    try {
        const { response, data } = await request('admin/gpu-servers');
        if (!response.ok) {
            editor.hidden = true;
            login.hidden = false;
            if (response.status !== 401) message.textContent = data?.error?.message || '无法读取 GPU 服务设置。';
            return;
        }
        login.hidden = true;
        editor.hidden = false;
        render(data);
    } catch { editor.hidden = true; login.hidden = false; message.textContent = '无法连接管理后台。'; }
}
async function save() {
    if (!documentState) return;
    setBusy(true); message.textContent = '';
    try {
        const { response, data } = await request('admin/gpu-servers', 'POST', { settings: collectSettings(), revision: documentState.revision });
        if (!response.ok) throw new Error(data?.error?.message || '保存失败。');
        render(data); message.textContent = 'GPU 服务配置已保存。新提交的任务会使用当前选中的服务。';
    } catch (caught) { message.textContent = caught.message || '保存失败。'; }
    finally { setBusy(false); }
}
async function activate() {
    if (!documentState) return;
    setBusy(true); message.textContent = '';
    try {
        const { response, data } = await request('admin/gpu-servers/activate', 'POST', { id: activeServer.value, revision: documentState.revision });
        if (!response.ok) throw new Error(data?.error?.message || '切换失败。');
        render(data); message.textContent = '已切换当前 GPU 服务。正在运行的任务仍会使用原服务。';
    } catch (caught) { message.textContent = caught.message || '切换失败。'; }
    finally { setBusy(false); }
}
document.getElementById('login').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true); message.textContent = '';
    try { const { response, data } = await request('auth/login', 'POST', { username: form.get('username'), password: form.get('password') }); if (!response.ok) throw new Error(data?.error?.message || '登录失败。'); await load(); }
    catch (caught) { message.textContent = caught.message || '登录失败。'; }
    finally { setBusy(false); }
});
document.getElementById('logout').addEventListener('click', async () => { await request('auth/logout', 'POST', {}); await load(); });
document.getElementById('reload').addEventListener('click', () => { if (confirm('重新加载会放弃未保存的修改，是否继续？')) void load(); });
document.getElementById('save').addEventListener('click', () => void save());
document.getElementById('activate').addEventListener('click', () => void activate());
document.getElementById('add').addEventListener('click', () => { servers.appendChild(createServerCard({ id: 'gpu-' + Date.now().toString(36), name: '新的 GPU 服务', kind: 'remote', comfyUrl: 'http://192.168.0.10:8188', seedUrl: 'http://192.168.0.10:8190' })); refreshActiveOptions(false); });
void load();
