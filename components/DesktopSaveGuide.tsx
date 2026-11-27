import React from 'react';
import { apiPath } from '../services/apiClient';

export default function DesktopSaveGuide({ onClose }: { onClose: () => void }) {
    const download = (platform: 'win-x64' | 'mac-arm64' | 'mac-x64' | 'single-html') => apiPath('/api/desktop-companion/download?platform=' + platform);
    return <section className="home-glass home-dialog w-full max-w-lg rounded-3xl p-7 shadow-2xl">
        <div className="mb-5 flex items-center justify-between"><h2 id="project-dialog-title" className="text-xl font-semibold">保存到你的电脑</h2><button aria-label="关闭本机保存说明" onClick={onClose} className="px-2 text-white/60">✕</button></div>
        <div className="space-y-4 text-sm leading-6 text-white/75">
            <p>当前是局域网网页，不能直接写入你的桌面。运行本机启动器后，即可在自己的电脑新建和自动保存工程。</p>
            <ol className="list-decimal space-y-2 pl-5"><li>按电脑系统下载下方对应启动器，并完整解压。</li><li>Windows 双击「启动画布.vbs」；Mac 双击「启动画布.command」。</li><li>在自动打开的本机页面登录同一账号，再新建工程。</li></ol>
            <p className="rounded-xl bg-cyan-200/10 p-3 text-xs text-cyan-100">保存位置：你自己的桌面 / 共智体画布工程 / 账户目录。默认每 5 分钟保存一次，最多保留 5 份，可在 Auto save 调整。不会写入服务器桌面。</p>
            <p className="text-xs text-white/50">Mac 请下载 .tar.gz 后解压；若第一次被系统拦截，请在 Finder 中右键「启动画布.command」并选择“打开”确认。无需安装 Node 或 ComfyUI，模型仍由局域网服务器提供。</p>
        </div>
        <div className="mt-6 grid gap-2 sm:grid-cols-2"><a href={download('single-html')} download className="home-primary col-span-full rounded-xl px-3 py-3 text-center text-sm font-semibold text-zinc-950">下载双击 HTML（Mac / Windows）</a><p className="col-span-full rounded-xl border border-white/10 bg-black/15 px-3 py-2 text-xs leading-5 text-white/55">双击 HTML 无需解压或安装，但工程仅保存在浏览器本地；请通过导出 .js 备份。它不能自动写入桌面，也不能启动本机 ComfyUI。</p><a href={download('win-x64')} download className="home-glass rounded-xl px-3 py-3 text-center text-sm text-cyan-100">下载 Windows x64</a><a href={download('mac-arm64')} download className="home-glass rounded-xl px-3 py-3 text-center text-sm text-cyan-100">下载 Mac Apple 芯片</a><a href={download('mac-x64')} download className="home-glass rounded-xl px-3 py-3 text-center text-sm text-cyan-100">下载 Mac Intel</a><button onClick={onClose} className="home-glass rounded-xl px-3 py-3 text-sm text-white/70">稍后设置</button></div>
    </section>;
}
