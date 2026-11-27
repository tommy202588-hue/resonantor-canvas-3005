import React from 'react';
import { FileTextIcon } from './Icons';
import { createScriptDocument, SCRIPT_STEPS, scriptProgress } from '../services/scriptStoryboard.mjs';
import type { ScriptDocument, ScriptGeneration } from '../types/storyboard';
import './ScriptWorkspace.css';

export default function ScriptNodeCard({ document, generation, onOpen }: { document?: ScriptDocument; generation?: ScriptGeneration; onOpen: () => void }) {
    const doc = document || createScriptDocument();
    const progress = scriptProgress(doc);
    return <div className="script-node-card">
        <FileTextIcon className="script-node-symbol" />
        {generation && <div className={'script-node-generation ' + generation.status} aria-live="polite">
            <div><strong>{generation.status === 'error' ? '生成失败' : generation.status === 'success' ? '分镜已生成' : '分镜生成中'}</strong><b>{generation.progress}%</b></div>
            <div className="script-node-progress" role="progressbar" aria-label="分镜生成步骤进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={generation.progress}><span style={{ width: generation.progress + '%' }} /></div>
            <small title={generation.error || generation.stage}>{generation.status === 'error' ? generation.error : generation.stage}</small>
            {generation.status === 'running' && <small>步骤进度 · 等待模型时百分比保持不变</small>}
        </div>}
        <div className="script-node-steps">{SCRIPT_STEPS.map((label, index) => <div className={progress.completed[index] ? 'is-complete' : doc.stage === index + 1 ? 'is-current' : ''} key={label}>
            <span>{progress.completed[index] ? '✓' : index + 1}</span><small>{label}</small>
        </div>)}</div>
        <p>{doc.shots.length ? `${doc.shots.length} 个镜头 · ${progress.images}/${doc.assets.length} 项资产 · ${progress.prompts} 条提示词` : '上传一段剧本，开启你的故事'}</p>
        <button type="button" onMouseDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onOpen(); }}>打开脚本节点 <span>→</span></button>
    </div>;
}
