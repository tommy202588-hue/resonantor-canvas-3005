import React from 'react';
import { UploadIcon, SparklesIcon, PlusIcon, Trash2Icon } from './Icons';
import { ASSET_LABELS } from '../services/scriptStoryboard.mjs';
import type { ScriptDocument, ScriptAsset, ScriptAssetKind } from '../types/storyboard';

interface Props {
    doc: ScriptDocument;
    busy: boolean;
    activeAsset: string;
    onStyle: (style: string) => void;
    onAdd: (kind: ScriptAssetKind) => void;
    onEdit: (id: string, change: Partial<ScriptAsset>) => void;
    onDelete: (id: string) => void;
    onUpload: (id: string, file: File) => void;
    onGenerate: (id: string) => void;
}

export default function ScriptAssetBoard({ doc, busy, activeAsset, onStyle, onAdd, onEdit, onDelete, onUpload, onGenerate }: Props) {
    return <div className="script-asset-board">
        <label className="script-global-style"><span>全局风格</span><textarea aria-label="全局风格" value={doc.style} maxLength={2000} disabled={busy} rows={2} onChange={event => onStyle(event.target.value)} placeholder="描述整体画风、年代、色彩与质感。未填写时忠实于原稿。修改后需重新合成提示词，已有参考图不会自动重绘。" /></label>
        {(Object.entries(ASSET_LABELS) as [ScriptAssetKind, string][]).map(([kind, label]) => <section className="script-asset-section" key={kind}>
            <h3>{label}<span>{doc.assets.filter(asset => asset.kind === kind).length}</span></h3>
            <div className="script-asset-grid">{doc.assets.filter(asset => asset.kind === kind).map(asset => <article className="script-asset-card" key={asset.id}>
                <div className={'script-asset-image' + (activeAsset === asset.id ? ' is-generating' : '')}>
                    {asset.imageDataUrl ? <img src={asset.imageDataUrl} alt={asset.name || label + '参考图'} /> : <div className="script-asset-placeholder"><SparklesIcon /><span>{activeAsset === asset.id ? '正在生成，请稍候…' : '生成或上传' + label + '图'}</span></div>}
                    <div className="script-asset-controls">
                        <label className={'script-icon-button' + (busy ? ' is-disabled' : '')} title="上传参考图"><UploadIcon /><input type="file" accept="image/png,image/jpeg,image/webp" aria-label={'上传' + (asset.name || label) + '参考图'} disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onUpload(asset.id, file); }} /></label>
                        <button type="button" title="生成参考图" aria-label={'生成' + (asset.name || label) + '参考图'} disabled={busy} onClick={() => onGenerate(asset.id)}><SparklesIcon /></button>
                        <button type="button" title="删除资产" aria-label={'删除资产' + asset.name} disabled={busy} onClick={() => onDelete(asset.id)}><Trash2Icon /></button>
                    </div>
                    {asset.imageDataUrl && <span className="script-asset-ready">✓ 已就绪</span>}
                </div>
                <input className="script-asset-name" aria-label={'资产名称 ' + asset.id} value={asset.name} maxLength={120} disabled={busy} placeholder={label + '名称'} onChange={event => onEdit(asset.id, { name: event.target.value })} />
                <textarea className="script-asset-description" aria-label={'资产描述 ' + asset.id} rows={3} value={asset.description} maxLength={2000} disabled={busy} placeholder="填写具体外观、服装、环境或材质…" onChange={event => onEdit(asset.id, { description: event.target.value })} />
            </article>)}
                <button type="button" className="script-add-asset" disabled={busy || doc.assets.length >= 60} onClick={() => onAdd(kind)} aria-label={'新增' + label}><PlusIcon /><span>新增{label}</span></button>
            </div>
        </section>)}
    </div>;
}
