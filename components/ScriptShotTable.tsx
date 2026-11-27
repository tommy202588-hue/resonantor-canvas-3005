import React from 'react';
import { CopyIcon, Trash2Icon, SparklesIcon } from './Icons';
import type { ScriptDocument, ScriptShot } from '../types/storyboard';

const columns: { key: keyof Pick<ScriptShot, 'description' | 'shotSize' | 'lighting' | 'dialogue' | 'sound' | 'camera' | 'prompt'>; title: string; width: number }[] = [
    { key: 'description', title: '画面描述', width: 300 }, { key: 'shotSize', title: '景别', width: 80 },
    { key: 'lighting', title: '光影氛围', width: 190 }, { key: 'dialogue', title: '对白·旁白', width: 210 },
    { key: 'sound', title: '音效', width: 170 }, { key: 'camera', title: '运镜', width: 170 },
    { key: 'prompt', title: '最终提示词', width: 230 }
];

interface Props {
    doc: ScriptDocument;
    busy: boolean;
    onEdit: (id: string, change: Partial<ScriptShot>) => void;
    onAction: (id: string, action: 'up' | 'down' | 'copy' | 'delete') => void;
    onSynthesize: (id: string) => void;
}

export default function ScriptShotTable({ doc, busy, onEdit, onAction, onSynthesize }: Props) {
    return <div className="script-table-scroll">
        <table className={'script-shot-table' + (doc.stage === 3 ? ' script-prompt-stage' : '')}>
            <colgroup><col style={{ width: '3.5%' }} /><col style={{ width: '4.5%' }} />{columns.map(column => <col key={column.key} style={{ width: (column.width / 1564 * 100) + '%' }} />)}<col style={{ width: '5.7%' }} /></colgroup>
            <thead><tr><th>镜号</th><th>时长</th>{columns.map(column => <th key={column.key} className={column.key === 'prompt' ? 'script-prompt-column' : ''}>{column.title}</th>)}<th>操作</th></tr></thead>
            <tbody>{doc.shots.map((shot, index) => <tr key={shot.id}>
                <td className="script-shot-index">{String(index + 1).padStart(2, '0')}</td>
                <td><div className="script-duration"><input aria-label={`镜头 ${index + 1} 时长`} type="number" min={1} max={30} step={1} value={shot.duration} disabled={busy} onChange={event => onEdit(shot.id, { duration: Math.min(30, Math.max(1, Number(event.target.value) || 1)) })} /><span>s</span></div></td>
                {columns.map(column => <td key={column.key} className={column.key === 'prompt' ? 'script-prompt-column' : ''}>
                    <textarea aria-label={`镜头 ${index + 1} ${column.title}`} value={shot[column.key]} disabled={busy} maxLength={column.key === 'prompt' ? 8000 : 4000} rows={column.key === 'prompt' && doc.stage === 3 ? 6 : 4} placeholder={column.key === 'prompt' ? '待合成提示词' : column.key === 'dialogue' ? '＋ 添加对白 / 旁白' : '点击填写'} onChange={event => onEdit(shot.id, { [column.key]: event.target.value })} />
                    {column.key === 'description' && doc.assets.length > 0 && <details className="script-shot-assets"><summary>关联资产 {shot.assetIds.length ? shot.assetIds.map(id => doc.assets.find(asset => asset.id === id)?.name).join(' · ') : '＋'}</summary><div>{doc.assets.map(asset => <label key={asset.id}><input type="checkbox" disabled={busy} checked={shot.assetIds.includes(asset.id)} onChange={event => onEdit(shot.id, { assetIds: event.target.checked ? [...shot.assetIds, asset.id] : shot.assetIds.filter(id => id !== asset.id) })} />{asset.name || '未命名'}</label>)}</div></details>}
                </td>)}
                <td><div className="script-shot-actions">
                    <button type="button" title="上移镜头" aria-label={`上移镜头 ${index + 1}`} disabled={busy || index === 0} onClick={() => onAction(shot.id, 'up')}>↑</button>
                    <button type="button" title="下移镜头" aria-label={`下移镜头 ${index + 1}`} disabled={busy || index === doc.shots.length - 1} onClick={() => onAction(shot.id, 'down')}>↓</button>
                    <button type="button" title="复制镜头" aria-label={`复制镜头 ${index + 1}`} disabled={busy || doc.shots.length >= 40} onClick={() => onAction(shot.id, 'copy')}><CopyIcon /></button>
                    <button type="button" title="删除镜头" aria-label={`删除镜头 ${index + 1}`} disabled={busy} onClick={() => onAction(shot.id, 'delete')}><Trash2Icon /></button>
                    {doc.stage === 3 && <button type="button" title="合成本镜提示词" aria-label={`合成镜头 ${index + 1} 提示词`} disabled={busy || !doc.shotsConfirmed} onClick={() => onSynthesize(shot.id)}><SparklesIcon /></button>}
                </div></td>
            </tr>)}</tbody>
        </table>
    </div>;
}
