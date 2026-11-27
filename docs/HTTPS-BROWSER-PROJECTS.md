# HTTPS 本机工程目录（3005 独立测试版）

## 当前状态与边界

- 2026-10-21 经用户明确授权发布会话检查修复，当前官网前端为 `20261021T014212Z`。本次仅切换前端，后端与 API 进程、模型/GPU/会话配置保持不变；发布、备份与验收见 `RELEASE-2026-10-21.md`。10 月 16 日首页品牌及 10 月 9 日下载、Ctrl+Z 与图片 CSP 修复继续保留，`connect-src` 允许 `data:` / `blob:`；实际 SSH 入口为 `8.218.158.34:51122`。
- 本轮仅改动 `main-3005-isolated`，不改动或重启 3004。
- 测试发布入口为 `https://www.resonantor.cn/resonantor-canvas/`，静态资源与 API 使用 `/resonantor-canvas/`。
- 2026-09-23 检查时，域名 HTTPS 证书有效，但测试入口仍是公司营销页的 fallback，并非新版画布。
- 2026-09-23 的历史准备阶段，服务器 `8.218.158.34:22` 的 SSH 连接超时，当时尚未登录或发布；当前状态以本节最新发布记录为准。
- 不把本机 Vite 3004/3005 或 ComfyUI 8188/8190 暴露到公网；工程接口不增加远程磁盘写入权限。

## 用户使用

1. Windows 或 macOS 用户使用 Chrome / Edge 打开 HTTPS 测试地址；本机开发可用 `http://localhost:3005/`。
2. 先注册、登录，再点击“选择工程文件夹”。浏览器必须由用户主动点击授权，网页不能无提示写入桌面。
3. 选择“桌面”，或桌面已经存在的“共智体画布工程”文件夹，允许读写。
4. 工程保存于所选位置的 `共智体画布工程/账户-<账号摘要>/<工程 UUID>/`；已选同名根目录不会重复嵌套。不同账号使用独立子目录，网页不会列出另一账号的工程。
5. 新建即保存一份。默认每 5 分钟自动保存，保留最近 5 份 `.js`，可在 Auto save 设置 1–120 分钟、1–100 份。生成图片仍使用原有独立的图片下载设置。
6. 重新打开同一网站和浏览器会恢复已保存的目录句柄；浏览器要求重新授权时，点击首页或 Auto save 中的“重新授权文件夹”。后台不会自行弹系统授权窗口。
7. 若文件夹暂时不可用，先导出工程，或点击“保留临时草稿并返回首页”，之后授权并“恢复草稿”另存。浏览器临时草稿不等于已经写入磁盘，清理浏览器数据会清除草稿。

Safari、Firefox 和 `http://192.168...` 这种非安全来源不支持此文件夹方案。2026-10-14 的 3005 本地修复在此情形下改用当前电脑的浏览器存储，可直接创建、保存和重新打开工程，按账号隔离；界面明确说明不会自动写入桌面，清除网站数据会丢失工程，应定期通过“导出项目”下载独立备份。此修复已随 2026-10-16 的前端发布上线，详见 `FIX-2026-10-14.md` 和 `RELEASE-2026-10-16.md`。手机浏览器不在本轮范围内。关闭网页、电脑休眠、断开移动磁盘时不能继续自动保存；退出前建议“立即保存”。

文件系统权限由操作系统和浏览器控制；账号目录分离不是对同一电脑操作系统用户的加密隔离。不要让不可信第三方脚本运行于网站同源页面。

## 文件与失败保护

- `project.json` 记录名称、自动保存设置、修订号和有效备份索引；文件内容与现有本机工程格式兼容。
- `snapshot-<时间戳>-<UUID>.js` 内容为 `export default {...};`，包含图片 base64、节点、连线、分组和视口；导入只解析 JSON，绝不执行 JS。
- 新快照关闭成功后才提交新索引，再清理被该索引明确淘汰的备份。写入失败不删除原有效快照；索引提交失败时新快照可能留作孤立的恢复文件，不擅自清理。
- 校验目录 ID、快照文件名、索引结构和修订号；同源页面使用 Web Locks 串行存取。来自不同网站、不同浏览器或外部编辑器的同时写入不属于 Web Locks 协调范围，请不要同时编辑同一磁盘工程。
- “删除工程”仅在索引标记删除并从最近项目隐藏，原目录和保留的 `.js` 备份不移动、不擦除；可手动导入备份恢复。
- localhost:3005、www 域名和其他子域名是不同来源，授权/登录/浏览器草稿不共享，需要在对应地址重新授权。磁盘工程可通过同一目录或导入备份继续使用。

## 本机验证

```powershell
npm run build:web-test
npm run test:server
npm run test:browser-projects
npm run package:web-test
npm run test:web-test-package
```

浏览器测试需要 Playwright，可通过 `PLAYWRIGHT_MODULE_PATH` 指向已安装的模块，`CANVAS_VERIFY_BROWSER` 默认 `msedge`。测试使用独立浏览器上下文、真实 FileSystemHandle/IndexedDB 和 OPFS 私有文件系统，系统文件夹弹窗与权限状态由测试替身替代；不会登录真实账户、写入用户桌面、请求云端计费模型或 GPU。真实 Windows/macOS 系统文件夹弹窗和网站 HTTPS 授权仍需用户在目标电脑确认。

2026-09-23 验证记录：179 项 Node 服务测试全部通过，网站构建通过，3005 浏览器流程和发布包测试入口/CSP/后台 API/cookie 路径验证通过。全量 `tsc --noEmit` 仍报告项目原有的 `displayError`、`targetScale`、旧适配器类型等错误；未为本任务改动这些无关功能，不把构建成功描述为全量类型检查通过。

`npm run build:web-test` 的产物在 `dist-web-test`，不覆盖已有 `dist`。打包产物在 `web-test-release/<时间戳>.tar.gz`，包含固定的静态文件、后端运行所需源文件、隔离配置和 SHA256 清单；不包含 `.env.local`、私钥、用户数据库、会话、模型 API key、ComfyUI 模型或工程文件。

## 隔离发布顺序

1. 确认实例公网地址、SSH 实际端口和登录账号；只开放本机出口 IP 到该 SSH 端口。使用用户授权 PEM，以独占 ACL 保存在仓库外，禁止加入发布包。
2. 只读检查实际 `nginx -T`、Node 路径/版本、现有 3001/5112 业务、测试路径和 5113 是否空闲。先备份当前 Nginx 配置并记录公司首页与已有画布入口的响应摘要。不要执行旧 `remote-deploy-3004.sh`。
3. 新版本解压到 `/opt/web/resonantor-canvas/releases/<时间戳>/` 并校验 `sha256sum -c SHA256SUMS`，不覆盖 `/opt/web/dist`、`/opt/web/server`、`/opt/web/canvas3004`。目录对 Nginx 只读，对专用服务用户只读。
4. 使用独立系统用户 `resonantor-canvas-test` 和独立服务 `resonantor-canvas-test.service`；Node 22+ 的路径须根据服务器实际情况调整。服务仅监听 `127.0.0.1:5113`，数据位于 `/var/lib/resonantor-canvas-test`，与现有账号/工程/模型配置不混用。
5. 核实 `/opt/web/resonantor-canvas/current` 是本测试目录内的链接后再切换到新 release；不能递归移动或删除不明旧目录。首次启动会在私有数据目录生成 `admin-access.json` 和会话密钥，仅管理员通过 SSH 在服务器上读取，禁止输出到网页或公开日志。
6. 测试后台为 `https://www.resonantor.cn/resonantor-canvas/admin`，模型配置为 `/resonantor-canvas/admin/models`。登录 cookie 名为 `resonantor_canvas_test_session`、Path 为 `/resonantor-canvas`、Secure/HttpOnly，后台链接与 API 也带同一前缀，不接管现有 `/admin` 或 `/api`。
7. 只有确认现有配置内容后，才把本包 `deploy/web-test-locations.conf` 作为 include 加入该域名的 **HTTPS server 块**。它不是整个站点配置，不能覆盖公司站点配置；旧 `/共振画布/` 和 `/canvas3004-api/` 保持不变。若 HTTP 未重定向，仅对测试入口增加精确 HTTPS 跳转。
8. `nginx -t` 成功才平滑 reload（不重启公司主业务）；验证测试 HTML 标题、所有 `/resonantor-canvas/assets/`、登录/注册、cookie Path、后台访问及普通用户不能访问管理 API，同时重新核对公司首页/旧业务响应。
9. HTTPS 电脑浏览器实测授权桌面、创建/重命名/删除、2 分钟/5 分钟自动保存、刷新恢复和媒体节点。不能仅凭返回 HTTP 200 声称发布成功。

网站测试后端是隔离实例，现有账户和模型配置不会自动复制。需管理员配置测试模型、有效 API key 与 HTTPS 下载白名单；微信登录需独立确认 callback 为 `https://www.resonantor.cn/resonantor-canvas/api/auth/wechat/callback`。没有配置时不得声称云模型或微信已可用。GPU 设置页面存在，但公网到本机 GPU 的安全通道及任务后端尚需实机核实；本轮不额外公开 ComfyUI 端口，也不承诺线上高清放大/去背景验收通过。

## 模型设置保存（隔离发布版）

- 2026-09-28 排查确认，站点级安全规则只允许 GET、HEAD、POST；原先的 PUT 保存请求在到达模型后端前被代理返回 405 HTML，并非导入 JSON 损坏或管理员登录过期。
- 模型管理页使用 POST 提交 `/resonantor-canvas/api/admin/model-settings`。后端同时兼容 POST 与原有 PUT，保持管理员、同源、JSON 格式、1 MB 请求上限及修订号校验；不放宽共享 Nginx 规则，不修改 3004。
- 导入只填表；保存失败保留当前内容，按实际 HTTP 状态提示，不自动重试。保存成功后密钥不回显，重新加载仍能读取所保存的模型配置。
- 回归命令：`node --test server/model-settings.test.mjs server/model-console-client.test.mjs server/public-path.test.mjs`，覆盖仅允许 POST 的代理、JSON 导入与保存、密钥保留、越权/跨站/版本冲突及错误提示。

## 图像处理后端（隔离发布版）

- 2026-09-28 查明原 5113 发布服务没有挂载 `/api/upscale`，Vite 开发版才注册了该接口，因此线上图像任务及轮询均返回 404。正式 API 已挂载同一处理服务，并校验登录会话、同源来源、客户端 UUID、账户级任务归属、并发及频率限制。
- 发布包必须包含 `server/upscale-service.mjs`、`server/upscale-workflows.mjs` 与 Python Pillow helper `server/upscale-image.py`；打包测试检查这三项，防止再次只发布前端而漏掉运行依赖。
- 正式服务通过后台 GPU 设置选择已启动的 ComfyUI/SeedVR2 节点，不开放 ComfyUI 端口，不允许浏览器选择目标主机。远程 GPU 需有服务端可达的可信内网连接；需在后端 Python 环境安装 Pillow。页面会显示连接、模型、Python/Pillow 的实际检查错误及 GPU 设置入口。
- 当前云主机检查记录：无 NVIDIA GPU 工具/运行时，无 ComfyUI 进程及 8188/8190 监听；未配置 GPU 服务，系统 Python 3.6 环境也缺少 Pillow。因此接通 API 后仍需部署/连接实际 GPU 与 ComfyUI，并安装 Pillow 才能真正生成图片。此运行依赖不能靠前端修复替代；不伪称图像生成已实机验收。
- `/api/upscale/*` 回归包含匿名拒绝、跨站拒绝、无效客户端拒绝、注册用户可访问及不同账户任务隔离；实机成功验收需另行确认 GPU 服务、所需模型/节点和显存。

## 回滚

首次发布：移除本次添加的测试 location include，`nginx -t` 成功后平滑 reload，仅停止 `resonantor-canvas-test`，保留 `/var/lib/resonantor-canvas-test` 数据。再次发布：把本测试 `current` 链接切回已记录的旧 release，并仅重启测试 API；保留旧 release 和私有数据。不得停掉、覆盖或清队列 3004、原网站服务或 ComfyUI。

