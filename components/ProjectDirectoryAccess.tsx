import React from 'react';
import { FolderIcon } from './Icons';

interface ProjectDirectoryAccessProps {
    status: string;
    directory: string;
    busy: boolean;
    onChoose: (change?: boolean) => void;
    allowChange?: boolean;
}

export default function ProjectDirectoryAccess({ status, directory, busy, onChoose, allowChange = false }: ProjectDirectoryAccessProps) {
    const ready = status === 'ready';
    const unsupported = status === 'unsupported';
    const browserStorage = status === 'browser';
    return <section aria-label="本机工程文件夹" className="rounded-2xl border border-cyan-100/15 bg-cyan-100/5 p-4 text-left text-xs leading-6 text-white/65 backdrop-blur-lg">
        <p className="flex items-center gap-2 text-sm font-medium text-cyan-100"><FolderIcon className="h-4 w-4" />{browserStorage ? '工程保存在当前浏览器' : ready ? '工程保存在你的电脑' : '授权本机工程文件夹'}</p>
        <p className="mt-2">{browserStorage ? '当前连接不支持直接写入文件夹，工程将自动保存在这台电脑的浏览器中，可以直接创建。需要文件备份时，请在画布中点击“导出项目”。' : unsupported ? '请使用 Windows 或 Mac 版 Chrome / Edge，通过 HTTPS 打开网站。本机 3005 可用 localhost。' : ready ? '新建、手动保存与自动备份直接写入下列授权目录，不写入服务器电脑。' : '首次请选择“桌面”，或桌面已有的“共智体画布工程”文件夹，并允许读写。浏览器不能绕过你的授权。'}</p>
        {directory && <p className="mt-2 break-all select-text text-white/45">{directory}</p>}
        {!unsupported && !browserStorage && <div className="mt-3 flex flex-wrap gap-3">
            {!ready && <button type="button" disabled={busy} onClick={() => onChoose()} className="rounded-xl border border-cyan-100/20 bg-cyan-100/10 px-4 py-2 text-cyan-100 transition hover:bg-cyan-100/20 disabled:opacity-40">{busy ? '正在等待文件夹授权…' : status === 'permission' ? '重新授权文件夹' : '选择工程文件夹'}</button>}
            {allowChange && directory && <button type="button" disabled={busy} title="先保存当前工程，再切换到新目录" onClick={() => onChoose(true)} className="rounded-xl border border-white/15 px-4 py-2 text-white/60 hover:bg-white/5 disabled:opacity-40">更换工程文件夹</button>}
        </div>}
        <p className="mt-2 text-[11px] text-white/40">{browserStorage ? '默认每 5 分钟保存，保留 5 份本地快照，可在 Auto save 调整。工程按账号和访问地址分开保存；清除网站数据会丢失工程，请定期导出备份。需要直接保存到桌面时，使用 HTTPS 授权文件夹。' : '默认每 5 分钟保存，保留 5 份 .js 备份；可在 Auto save 调整。不同账号使用独立子目录，关闭页面或休眠时暂停保存。'}</p>
    </section>;
}
