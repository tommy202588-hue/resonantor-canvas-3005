import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileTextIcon, UploadIcon, DownloadIcon, PlusIcon, XIcon, SparklesIcon, VideoIcon } from './Icons';
import ScriptShotTable from './ScriptShotTable';
import ScriptAssetBoard from './ScriptAssetBoard';
import { ASSET_LABELS, SCRIPT_LIMITS, SCRIPT_STEPS, createScriptShot, resolveScriptModel, scriptProgress, validateScriptDocument } from '../services/scriptStoryboard.mjs';
import { generateShotPrompts, generateScriptAsset, prepareScriptImage, readScreenplay } from '../services/scriptGeneratorService';
import { createRandomId } from '../services/randomId.mjs';
import type { AppSettings } from '../types/settings';
import type { ScriptDocument, ScriptShot, ScriptAsset, ScriptAssetKind, ScriptStage, ScriptGeneration } from '../types/storyboard';
import './ScriptWorkspace.css';

interface Props {
    document: ScriptDocument;
    settings: AppSettings;
    title: string;
    onChange: (doc: ScriptDocument) => void;
    generation?: ScriptGeneration;
    onGenerate: (count: number, selection: string) => void;
    onClose: () => void;
    onSend: (kind: 'text' | 'video', doc: ScriptDocument) => void;
}

const invalidatePrompts = (doc: ScriptDocument): ScriptDocument => ({ ...doc, shots: doc.shots.map(shot => ({ ...shot, prompt: '' })) });

function ModelSelect({ settings, category, value, disabled, onChange }: { settings: AppSettings; category: 'text' | 'image'; value: string; disabled: boolean; onChange: (value: string) => void }) {
    const providers = settings[category === 'text' ? 'textProviders' : 'imageProviders'].filter(provider => provider.apiKey && provider.models.length);
    return <label className="script-model-label">{category === 'text' ? '文本模型' : '图片模型'}<select aria-label={category === 'text' ? '脚本文本模型' : '资产图片模型'} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
        <option value="">{providers.length ? '后台默认模型' : '后台尚未配置'}</option>
        {providers.map(provider => <optgroup key={provider.id} label={provider.name}>{provider.models.map(model => <option key={model.id} value={JSON.stringify([provider.id, model.id])}>{model.displayName || model.id}</option>)}</optgroup>)}
    </select></label>;
}

const ScriptWorkspace: React.FC<Props> = ({ document: doc, settings, title, generation, onGenerate, onChange, onClose, onSend }: Props) => {
    const [sourceOpen, setSourceOpen] = useState(!doc.shots.length);
    const [targetCount, setTargetCount] = useState(12);
    const [textModel, setTextModel] = useState('');
    const [imageModel, setImageModel] = useState('');
    const [localBusy, setBusy] = useState('');
    const backgroundRunning = generation?.status === 'running';
    const busy = backgroundRunning ? generation.stage : localBusy;
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [activeAsset, setActiveAsset] = useState('');
    const [stopping, setStopping] = useState(false);
    const dialogRef = useRef<HTMLDivElement>(null);
    const docRef = useRef(doc);
    const locked = useRef(false);
    const mounted = useRef(true);
    const stop = useRef(false);
    docRef.current = doc;
    const progress = scriptProgress(doc);
    let textModelError = '';
    try { resolveScriptModel(settings, 'text', textModel); } catch (failure) { textModelError = (failure as Error).message; }

    useEffect(() => {
        mounted.current = true;
        const previous = document.activeElement as HTMLElement | null;
        dialogRef.current?.focus();
        const originalOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { mounted.current = false; stop.current = true; document.body.style.overflow = originalOverflow; previous?.focus?.(); };
    }, []);

    useEffect(() => {
        if (generation?.status === 'success') {
            setSourceOpen(false);
            setNotice('分镜已生成并写回画布节点，请核对后确认镜头。');
        }
    }, [generation?.id, generation?.status]);

    const commit = (next: ScriptDocument) => {
        if (!mounted.current) return;
        validateScriptDocument(next);
        docRef.current = next;
        onChange(next);
    };

    const run = async (label: string, task: () => Promise<void>) => {
        if (locked.current || backgroundRunning) return;
        locked.current = true; stop.current = false;
        setBusy(label); setError(''); setNotice(''); setStopping(false);
        try { await task(); }
        catch (failure) { if (mounted.current) setError((failure instanceof Error ? failure.message : '处理失败，请稍后重试。').replace(/(?:Bearer\s+|sk-)[A-Za-z0-9_.-]{12,}/gi, '[已隐藏凭据]').slice(0, 1200)); }
        finally { locked.current = false; if (mounted.current) { setBusy(''); setActiveAsset(''); setStopping(false); } }
    };

    const changeSource = (sourceText: string, sourceName = doc.sourceName) => {
        if (sourceText.length > SCRIPT_LIMITS.source) { setError('每次最多 40000 字符，请按集拆分。原文未被截断。'); return; }
        commit({ ...invalidatePrompts(docRef.current), sourceText, sourceName, shotsConfirmed: false, stage: 1 });
        if (doc.shots.length) setNotice('原稿已更新。现有镜头仍保留，请重新生成分镜或手动核对后确认。');
    };

    const importSource = (file: File) => void run('正在读取剧本', async () => {
        const source = await readScreenplay(file);
        if (!mounted.current) return;
        changeSource(source, file.name.slice(0, 255)); setSourceOpen(true);
    });

    const analyze = () => {
        if (locked.current || backgroundRunning) return;
        if (doc.shots.length && !window.confirm('重新生成会替换当前分镜和资产清单（包括已上传的参考图）。原始剧本仍保留，是否继续？')) return;
        setError(''); setNotice('');
        onGenerate(targetCount, textModel);
    };

    const editShot = (id: string, change: Partial<ScriptShot>) => {
        const onlyPrompt = Object.keys(change).every(key => key === 'prompt');
        const next = onlyPrompt ? docRef.current : { ...invalidatePrompts(docRef.current), shotsConfirmed: false };
        commit({ ...next, shots: next.shots.map(shot => shot.id === id ? { ...shot, ...change } : shot) });
    };

    const shotAction = (id: string, action: 'up' | 'down' | 'copy' | 'delete') => {
        const next = invalidatePrompts(docRef.current);
        const index = next.shots.findIndex(shot => shot.id === id);
        if (index < 0) return;
        if (action === 'delete') { if (!window.confirm('删除这个镜头？')) return; next.shots.splice(index, 1); }
        else if (action === 'copy' && next.shots.length < SCRIPT_LIMITS.shots) next.shots.splice(index + 1, 0, { ...next.shots[index], id: createRandomId(), assetIds: [...next.shots[index].assetIds] });
        else {
            const target = index + (action === 'up' ? -1 : 1);
            if (target < 0 || target >= next.shots.length) return;
            [next.shots[index], next.shots[target]] = [next.shots[target], next.shots[index]];
        }
        commit({ ...next, shotsConfirmed: false });
    };

    const addShot = () => {
        if (doc.shots.length >= SCRIPT_LIMITS.shots) return;
        commit({ ...invalidatePrompts(docRef.current), stage: 1, shotsConfirmed: false, shots: [...doc.shots.map(shot => ({ ...shot, prompt: '' })), createScriptShot()] });
        setSourceOpen(false);
    };

    const editAsset = (id: string, change: Partial<ScriptAsset>) => {
        const next = invalidatePrompts(docRef.current);
        commit({ ...next, assets: next.assets.map(asset => asset.id === id ? { ...asset, ...change } : asset) });
    };

    const addAsset = (kind: ScriptAssetKind) => {
        if (doc.assets.length >= SCRIPT_LIMITS.assets) return;
        commit({ ...invalidatePrompts(docRef.current), assets: [...doc.assets, { id: createRandomId(), kind, name: '新' + ASSET_LABELS[kind], description: '' }] });
    };

    const deleteAsset = (id: string) => {
        if (!window.confirm('删除此资产及镜头中的关联？')) return;
        const next = invalidatePrompts(docRef.current);
        commit({ ...next, assets: next.assets.filter(asset => asset.id !== id), shots: next.shots.map(shot => ({ ...shot, assetIds: shot.assetIds.filter(assetId => assetId !== id) })) });
    };

    const uploadAsset = (id: string, file: File) => void run('正在处理资产图片', async () => {
        const imageDataUrl = await prepareScriptImage(file);
        if (mounted.current) editAsset(id, { imageDataUrl });
    });

    const makeAssets = (id?: string) => {
        const assets = id ? doc.assets.filter(asset => asset.id === id) : doc.assets.filter(asset => !asset.imageDataUrl);
        if (!assets.length) return;
        if (!window.confirm('将通过后台图片模型生成 ' + assets.length + ' 张参考图，可能产生 API 费用。是否继续？')) return;
        void run('准备生成资产', async () => {
            resolveScriptModel(settings, 'image', imageModel);
            for (let index = 0; index < assets.length; index += 1) {
                if (stop.current || !mounted.current) break;
                setActiveAsset(assets[index].id); setBusy('生成资产 ' + (index + 1) + '/' + assets.length + ' · ' + assets[index].name);
                const imageDataUrl = await generateScriptAsset(docRef.current, assets[index], settings, imageModel);
                if (mounted.current) editAsset(assets[index].id, { imageDataUrl });
            }
            if (mounted.current) setNotice(stop.current ? '已停止后续任务，已完成的资产已保留。' : '资产参考图已生成，并随工程保存。');
        });
    };

    const synthesize = (id?: string) => {
        if (!doc.shotsConfirmed) { setError('镜头有修改，请回到第一步重新确认镜头。'); return; }
        const shots = id ? doc.shots.filter(shot => shot.id === id) : doc.shots.filter(shot => !shot.prompt.trim());
        if (!shots.length) { setNotice('所有镜头已合成，可使用每行的按钮单独重生成。'); return; }
        void run('准备合成提示词', async () => {
            for (let offset = 0; offset < shots.length; offset += 5) {
                if (stop.current || !mounted.current) break;
                const batch = shots.slice(offset, offset + 5);
                setBusy('合成提示词 · 镜头 ' + (offset + 1) + '–' + (offset + batch.length) + '/' + shots.length);
                const result = await generateShotPrompts(docRef.current, batch, settings, textModel);
                if (mounted.current) commit({ ...docRef.current, shots: docRef.current.shots.map(shot => result.find(item => item.id === shot.id) || shot) });
            }
            if (mounted.current) setNotice(stop.current ? '已停止后续合成，已完成的提示词已保留。' : '提示词已合成。可以编辑、导出，或发送到画布的视频节点。');
        });
    };

    const exportDocument = () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(docRef.current, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a'); anchor.href = url;
        anchor.download = (title || '脚本生成器').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') + '-分镜.json';
        document.body.appendChild(anchor); anchor.click(); anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    };

    const close = () => {
        if (locked.current) { setNotice('当前请求仍在处理中，请等待完成；批量任务可停止后续任务。'); return; }
        onClose();
    };

    const keyboard = (event: React.KeyboardEvent) => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Tab') {
            const focusable = (Array.from(dialogRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary') || []) as HTMLElement[]).filter(element => element.getClientRects().length && element.tabIndex >= 0);
            const first = focusable[0]; const last = focusable[focusable.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first?.focus(); }
        }
    };

    return createPortal(<div className="script-workspace" data-script-workspace role="dialog" aria-modal="true" aria-labelledby="script-workspace-title" ref={dialogRef} tabIndex={-1} onKeyDown={keyboard} onKeyUp={event => event.stopPropagation()} onPaste={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
        <header className="script-workspace-header">
            <div className="script-workspace-brand"><FileTextIcon /><div><strong id="script-workspace-title">脚本生成器</strong><small title={title}>{title || 'STORY WORKSPACE'}</small></div></div>
            <nav className="script-stage-nav" aria-label="脚本生成步骤">{SCRIPT_STEPS.map((label, index) => <button type="button" key={label} disabled={!!busy || (index > 0 && !progress.shotsReady)} aria-current={doc.stage === index + 1 ? 'step' : undefined} onClick={() => { commit({ ...doc, stage: (index + 1) as ScriptStage }); setSourceOpen(false); }}>
                <span className={progress.completed[index] ? 'is-done' : ''}>{progress.completed[index] ? '✓' : index + 1}</span><div><strong>{label}</strong><small>{index === 0 ? doc.shots.length + ' 个镜头' + (doc.shotsConfirmed ? '已确认' : '待确认') : index === 1 ? progress.images + '/' + doc.assets.length + ' 已就绪' : progress.prompts + '/' + doc.shots.length + ' 已合成'}</small></div>
            </button>)}</nav>
            <div className="script-header-end"><span>{progress.count}/3 已完成</span><button type="button" className="script-icon-button" aria-label="关闭脚本生成器" onClick={close}><XIcon /></button></div>
        </header>
        <div className="script-workspace-tools">
            <div className="script-toolbar-group"><button type="button" disabled={!!busy} className={sourceOpen ? 'is-active' : ''} onClick={() => setSourceOpen(value => !value)}><FileTextIcon />{sourceOpen ? '收起原稿' : '查看 / 上传剧本'}</button><button type="button" onClick={exportDocument}><DownloadIcon />导出分镜 JSON</button></div>
            <ModelSelect settings={settings} category={doc.stage === 2 ? 'image' : 'text'} value={doc.stage === 2 ? imageModel : textModel} disabled={!!busy} onChange={doc.stage === 2 ? setImageModel : setTextModel} />
        </div>
        {textModelError && <div className="script-message script-warning" role="status">{textModelError}</div>}
        {backgroundRunning && <div className="script-message script-background-notice" role="status"><div><strong>分镜生成中 · {generation.progress}%</strong><span>{generation.stage}</span><small>百分比按完成步骤计算，并非模型内部生成比例。可退出本界面继续等待，请勿刷新或关闭网页。</small></div><button type="button" onClick={onClose}>返回画布等待 →</button></div>}
        {generation?.status === 'error' && <div className="script-message script-error" role="alert">{generation.error || '分镜生成失败，原稿和已有分镜已保留。'}<button type="button" onClick={() => setSourceOpen(true)}>查看原稿并重试</button></div>}
        {error && <div className="script-message script-error" role="alert">{error}<button type="button" aria-label="关闭错误提示" onClick={() => setError('')}>×</button></div>}
        {notice && <div className="script-message" role="status">{notice}</div>}
        <main className="script-workspace-main">
            {sourceOpen && <section className="script-source-panel">
                <div className="script-source-heading"><div><span className="script-eyebrow">FROM STORY TO SCREEN</span><h2>让每一段故事，都有画面。</h2><p>上传或粘贴剧本，由后台大模型拆解镜头与视觉资产。</p></div><label className={'script-button' + (busy ? ' is-disabled' : '')}><UploadIcon />上传剧本<input type="file" accept=".txt,.md,.srt,.fountain" aria-label="上传剧本文件" disabled={!!busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) importSource(file); }} /></label></div>
                <textarea className="script-source-text" aria-label="剧本原文" value={doc.sourceText} disabled={!!busy} onChange={event => changeSource(event.target.value)} placeholder="在这里粘贴你的剧本…&#10;&#10;例如：雨夜，旧车站。林舟握着一封未寄出的信，望向最后一班列车。&#10;林舟（轻声）：这一次，我不会再错过。" />
                <div className="script-source-bottom"><small>{doc.sourceName || '手动输入'} · {doc.sourceText.length.toLocaleString()} / 40,000 字符<br />TXT / MD / SRT / Fountain；Word、PDF 请复制正文或导出 TXT。</small><div><label>目标镜头数<input aria-label="目标镜头数" type="number" value={targetCount} min={1} max={40} disabled={!!busy} onChange={event => setTargetCount(Math.min(40, Math.max(1, Math.round(Number(event.target.value) || 1))))} /></label><button type="button" className="script-primary" disabled={!!busy || !doc.sourceText.trim() || !!textModelError} onClick={analyze}><SparklesIcon />{doc.shots.length ? '重新生成分镜' : '生成分镜'}</button></div></div>
                <p className="script-source-hint">生成会调用后台配置的文本模型，可能产生 API 费用。原稿始终保留，AI 输出请人工核对。</p>
            </section>}
            {doc.shots.length ? doc.stage === 2 ? <ScriptAssetBoard doc={doc} busy={!!busy} activeAsset={activeAsset} onStyle={style => commit({ ...invalidatePrompts(docRef.current), style })} onAdd={addAsset} onEdit={editAsset} onDelete={deleteAsset} onUpload={uploadAsset} onGenerate={makeAssets} /> : <ScriptShotTable doc={doc} busy={!!busy} onEdit={editShot} onAction={shotAction} onSynthesize={synthesize} /> : !sourceOpen && <div className="script-empty"><FileTextIcon /><h2>从你的剧本开始</h2><p>上传原稿让 AI 拆分镜头，也可以手动添加镜头。</p><button type="button" onClick={() => setSourceOpen(true)}>上传 / 粘贴剧本 →</button></div>}
        </main>
        <footer className="script-workspace-footer">
            <div className="script-footer-left">{busy ? <><span className="script-busy-dot" /><span role="status">{backgroundRunning ? generation.progress + '% · ' : ''}{busy}</span>{backgroundRunning ? <button type="button" onClick={onClose}>返回画布等待 →</button> : <button type="button" disabled={stopping} onClick={() => { stop.current = true; setStopping(true); }}>{stopping ? '等待当前请求结束…' : '停止后续任务'}</button>}</> : doc.stage === 2 ? <span>{progress.images < doc.assets.length ? '还有 ' + (doc.assets.length - progress.images) + ' 项资产缺少参考图，可上传或生成。' : '资产已就绪。'}<small>参考图最长边 1536px · 更改随工程保存</small></span> : <><button type="button" disabled={doc.shots.length >= 40} onClick={addShot}><PlusIcon />添加镜头</button><small>更改随工程保存 · 最多 40 镜</small></>}</div>
            <div className="script-footer-actions">{doc.stage === 1 ? <button type="button" className="script-primary" disabled={!!busy || !progress.shotsReady} onClick={() => { commit({ ...doc, shotsConfirmed: true, stage: 2 }); setSourceOpen(false); }}>确认镜头，准备资产 →</button> : doc.stage === 2 ? <><button type="button" disabled={!!busy || progress.images === doc.assets.length} onClick={() => makeAssets()}><SparklesIcon />一键生成缺失资产</button><button type="button" className="script-primary" disabled={!!busy} onClick={() => { commit({ ...doc, stage: 3 }); setSourceOpen(false); if (progress.images < doc.assets.length) setNotice('可以先按文字设定合成提示词；缺少图片的资产不会作为视频参考图发送。'); }}>下一步：合成提示词 →</button></> : <><button type="button" disabled={!!busy || !progress.prompts} onClick={() => onSend('text', doc)}>发送文本节点</button><button type="button" disabled={!!busy || !doc.shotsConfirmed || progress.prompts !== doc.shots.length} onClick={() => onSend('video', doc)} title="创建待生成的视频节点，不自动调用付费接口"><VideoIcon />发送视频节点</button><button type="button" className="script-primary" disabled={!!busy || !doc.shotsConfirmed || !!textModelError} onClick={() => synthesize()}><SparklesIcon />合成缺失提示词</button></>}</div>
        </footer>
    </div>, document.body);
};

export default ScriptWorkspace;
