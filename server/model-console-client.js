const groups = [['image', '图片模型'], ['video', '视频模型'], ['text', '文本模型'], ['audio', '音频模型']];
const defaults = { gemini: 'https://generativelanguage.googleapis.com', openai: 'https://api.openai.com', minimax: 'https://api.minimaxi.com' };
const message = document.getElementById('message');
const editor = document.getElementById('editor');
let current;
let revision = 0;
let limits;
let busy = false;
const element = (tag, content, className) => { const node = document.createElement(tag); if (content) node.textContent = content; if (className) node.className = className; return node; };
const field = (container, label, value, change, type = 'text') => {
    const wrapper = element('label', label);
    const input = element('input'); input.type = type; input.value = value || ''; input.addEventListener('input', () => change(input.value)); wrapper.append(input); container.append(wrapper); return input;
};
const defaultKey = group => 'default' + group[0].toUpperCase() + group.slice(1) + 'Provider';
function showCapacity() {
    const hint = document.getElementById('capacity-info');
    if (!hint) return;
    const configured = Number(document.getElementById('concurrency').value) || 3;
    hint.textContent = limits?.unlimitedModels ? `模型请求不设本地次数及并发上限。画布批量调度使用 ${configured} 个并发；供应商自身的额度仍适用。` : limits ? `代理上限：每账号 ${limits.perAccount} 个、全站 ${limits.global} 个同时处理的请求。保存后画布批量并发最多为 ${Math.min(configured, limits.perAccount, limits.global)}；同账号的其他页面也会占用名额。` : '画布批量并发同时受代理服务上限约束，超过可用名额时需等待现有任务完成。';
}
async function readJsonResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    if (response.status === 401) throw new Error('管理员登录已失效，请在“账户后台 / 管理员登录”中重新登录，再返回此页重试。');
    if (!contentType.toLowerCase().includes('application/json')) {
        if (response.status === 405) throw new Error('网站代理不允许此请求方法（HTTP 405），请更新模型设置页或检查代理的方法限制；重新登录不能解决此问题。');
        if (response.status === 403) throw new Error('网站拒绝访问模型设置（HTTP 403），请检查管理员权限或网站访问规则。');
        if (response.status === 413) throw new Error('模型配置超过网站允许的请求大小（HTTP 413），请精简设置 JSON 或检查代理的大小限制。');
        if (response.status >= 500) throw new Error(`后台服务或代理暂时不可用（HTTP ${response.status}），请稍后重试。`);
        throw new Error(`后台接口返回了非 JSON 响应（HTTP ${response.status}），请检查发布路径或反向代理配置。`);
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`后台接口返回的 JSON 无法解析（HTTP ${response.status}），请稍后重试。`);
    }
}
function render() {
    const container = document.getElementById('groups'); container.replaceChildren();
    document.getElementById('concurrency').value = current.concurrencyLimit || 3;
    showCapacity();
    document.getElementById('revision').textContent = '配置版本 ' + revision + ' · 保存后用户刷新或切回画布即可同步';
    for (const [group, title] of groups) {
        const providers = current[group + 'Providers'];
        const section = element('section', '', 'panel'); const heading = element('div', '', 'row'); heading.append(element('h2', title));
        const add = element('button', '添加提供商', 'secondary'); add.type = 'button'; add.addEventListener('click', () => { providers.push({ id: group + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), name: '', type: 'openai', apiKey: '', baseUrl: defaults.openai, models: [], endpointMode: 'chat', customEndpoint: '' }); render(); }); heading.append(add); section.append(heading);
        if (!providers.length) section.append(element('p', '尚未配置，用户暂不能使用此类模型。', 'muted'));
        for (const provider of providers) {
            const card = element('div', '', 'provider'); const top = element('div', '', 'row');
            top.append(element('h3', provider.name || '新提供商'));
            const remove = element('button', '移除此提供商', 'danger'); remove.type = 'button'; remove.addEventListener('click', () => { if (!confirm('从配置中移除此提供商？保存后对所有用户生效。')) return; current[group + 'Providers'] = providers.filter(item => item !== provider); if (current[defaultKey(group)] === provider.id) current[defaultKey(group)] = current[group + 'Providers'][0]?.id; render(); }); top.append(remove); card.append(top);
            const fields = element('div', '', 'fields');
            field(fields, '提供商名称', provider.name, value => { provider.name = value; }).required = true;
            const typeLabel = element('label', '接口类型'); const select = element('select'); for (const type of ['openai', 'gemini', 'sora', 'veo', 'univ2', 'grok', 'minimax']) { const option = element('option', type); option.value = type; select.append(option); } select.value = provider.type; select.addEventListener('change', () => { provider.type = select.value; }); typeLabel.append(select); fields.append(typeLabel);
            field(fields, 'API 地址（HTTPS）', provider.baseUrl, value => { provider.baseUrl = value; }, 'url').required = true;
            const key = field(fields, 'API 密钥' + (provider.hasApiKey ? '（已配置，留空保留）' : '（尚未配置）'), provider.apiKey, value => { provider.apiKey = value; }, 'password'); key.autocomplete = 'new-password';
            const custom = field(fields, '自定义接口路径（可选，以 / 开头）', provider.customEndpoint, value => { provider.customEndpoint = value; provider.endpointMode = value ? 'custom' : 'chat'; }); custom.placeholder = '/v1/images/generations';
            const defaultLabel = element('label', ''); const checkbox = element('input'); checkbox.type = 'radio'; checkbox.name = 'default-' + group; checkbox.checked = current[defaultKey(group)] === provider.id || (!current[defaultKey(group)] && provider === providers[0]); checkbox.addEventListener('change', () => { current[defaultKey(group)] = provider.id; render(); }); defaultLabel.append(checkbox, document.createTextNode('默认提供商')); fields.append(defaultLabel);
            const modelsLabel = element('label', '模型列表：每行一个“模型 ID | 显示名称”，也可只填 ID', 'wide'); const models = element('textarea'); models.value = provider.models.map(model => model.id + (model.displayName !== model.id ? ' | ' + model.displayName : '')).join('\n'); models.addEventListener('input', () => { provider.models = models.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => { const [id, ...labels] = line.split('|'); return { id: id.trim(), displayName: labels.join('|').trim() || id.trim() }; }); }); modelsLabel.append(models); fields.append(modelsLabel); card.append(fields); section.append(card);
        }
        container.append(section);
    }
}
async function load() {
    if (busy) return;
    message.textContent = '正在读取后台配置…';
    try { const response = await fetch('/api/admin/model-settings', { cache: 'no-store', credentials: 'same-origin' }); const data = await readJsonResponse(response); if (!response.ok) { editor.hidden = true; throw new Error(response.status === 401 ? '请先点击右上角“账户后台 / 管理员登录”，登录管理员后返回此页。' : data.error?.message || '无法读取配置'); } current = data.settings; revision = data.revision; limits = data.limits; editor.hidden = false; render(); message.textContent = ''; } catch (error) { editor.hidden = true; message.textContent = error instanceof Error ? error.message : String(error); }
}
function importSettings(data) {
    const input = data.settings || data;
    if (!input || !groups.some(([group]) => Array.isArray(input[group + 'Providers']))) throw new Error('这不是模型设置 JSON，请选择原模型设置导出的文件。');
    current = { ...input, concurrencyLimit: Math.min(15, Math.max(1, input.concurrencyLimit || 3)) };
    for (const [group] of groups) current[group + 'Providers'] = input[group + 'Providers'] || [];
    render(); message.textContent = '已载入旧配置，请检查模型和密钥，然后点击“保存统一配置”。';
}
editor.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return; busy = true;
    editor.querySelectorAll('button').forEach(button => { button.disabled = true; });
    message.textContent = '正在保存统一配置…';
    try { current.concurrencyLimit = Number(document.getElementById('concurrency').value); const response = await fetch('/api/admin/model-settings', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: current, revision }) }); const data = await readJsonResponse(response); if (!response.ok) throw new Error(data.error?.message || '保存失败'); current = data.settings; revision = data.revision; limits = data.limits; render(); message.textContent = '已保存，所有登录用户将使用统一配置。密钥不再回显。'; } catch (error) { message.textContent = (error instanceof Error ? error.message : String(error)) + '\n当前表单内容已保留，尚未确认保存成功。'; } finally { busy = false; editor.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
});
document.getElementById('concurrency').addEventListener('input', showCapacity);
document.getElementById('reload').addEventListener('click', () => { if (confirm('重新加载会放弃表单中未保存的修改，是否继续？')) void load(); });
document.getElementById('import-local').addEventListener('click', () => { try { const stored = localStorage.getItem('X-tapnow_app_settings'); if (!stored) throw new Error('此浏览器没有旧模型配置，请手动添加或导入设置 JSON。'); importSettings(JSON.parse(stored)); } catch (error) { message.textContent = error.message; } });
document.getElementById('import-file').addEventListener('click', () => document.getElementById('file').click());
document.getElementById('file').addEventListener('change', async event => { try { const file = event.target.files[0]; if (!file) return; if (file.size > 1024 * 1024) throw new Error('设置文件不能超过 1 MB，请勿选择工程文件。'); importSettings(JSON.parse(await file.text())); } catch (error) { message.textContent = error.message; } finally { event.target.value = ''; } });
void load();
