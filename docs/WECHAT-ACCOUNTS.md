# Resonantor 微信扫码注册与账号后端

## 当前状态

- 首页提供“登录 / 注册”入口及独立的“注册新账号”表单，支持用户名与密码注册并自动登录，不依赖微信配置；微信扫码仍是可选登录方式。
- 画布已改为注册登录后使用，匿名只可浏览首页；后台入口为 /admin，管理员凭据与访问方法见 ADMIN-ACCESS.md。本地 Vite 的 HTTP 会话兼容规则也以该文档为准。

- 顶部 TapTV 已更名为 ResonTV，背景与现有导航布局保持不变。
- 账户登录内提供“微信扫码注册 / 登录”；Vite 3004 已挂载真正的账号接口，不再将不存在的接口回退成 HTML。
- 代码与模拟微信服务的注册链路已实现。真实微信扫码仍需要应用所有者提供已审核的网站应用凭据和授权回调域名；不会生成演示二维码或伪造微信用户。

## 微信开放平台配置

采用微信开放平台“网站应用微信登录”，不是公众号网页登录、小程序登录或个人收款码。
官方说明：https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html
官方嵌入组件参数参考：https://res.wx.qq.com/connect/zh_CN/htmledition/js/wxLogin.js

1. 在微信开放平台创建、审核网站应用并开通微信登录，取得 AppID、AppSecret。
2. 准备 HTTPS 域名，配置应用的授权回调域。域名必须路由到运行账号服务的同一个实例。
3. 参考 .env.wechat.example，将以下服务端变量添加到本地 .env.local（不要覆盖已有模型配置）：
   - WECHAT_APP_ID：网站应用 AppID。
   - WECHAT_APP_SECRET：微信平台签发的 AppSecret；不要发送到聊天、放入前端设置或使用 VITE_ 前缀。
   - WECHAT_REDIRECT_URI：例如 https://canvas.example.com/api/auth/wechat/callback，必须与应用审核的域名一致。
   - PUBLIC_ORIGINS：正式访问的 HTTPS 页面来源，多个值用逗号分隔。
4. 重启本地 Vite 服务以读取环境配置。独立 API 服务通过启动环境注入同名变量，不自动读取 Vite 的 .env.local。
5. GET /api/auth/wechat/config 返回 ready=true 只表示配置完整；真实授权是否成功仍取决于微信审核、域名和正确凭据。

本地 localhost 页面可发起联调，但 HTTPS 回调域名必须转发到这个运行实例。纯内网 IP 不能代替已配置的网站授权回调域。当前 Vite 3004 为兼容可信局域网 HTTP，默认不设置 Secure Cookie；独立 API 服务默认开启 Secure。生产环境必须使用 HTTPS 并设置 CANVAS_COOKIE_SECURE=true。

## 用户 ID 与会话密钥

- 首次验证微信授权并由发起扫码的浏览器确认后，服务端生成内部 UUID v4 标识及微信账号用户名。公开用户 ID 等于用户名；内部 UUID 仅用于持久化关联，不再作为界面用户 ID 展示。用户名密码注册时，用户自选且不可重复的注册名即公开用户 ID。
- 同一 AppID + OpenID 再次登录复用同一个 ID，不重复创建账号；不会仅凭浏览器提交的昵称、用户 ID 或 OpenID 注册。
- 最小化采集：只保存微信身份标识，不调用联系人、聊天或用户资料接口。微信 access_token 不返回前端、不持久化。
- 本地账号数据默认保存在 %LOCALAPPDATA%/Resonantor/auth，包含 users.json、sessions.json、session.key；可用 CANVAS_AUTH_DATA_DIR 指定本地存储位置。独立 API 服务使用 CANVAS_DATA_DIR。
- session.key 是启动时自动生成的 256 位服务端密钥，用于签名会话；已有密钥直接复用，损坏时拒绝静默覆盖。可改为通过 CANVAS_SESSION_SECRET 注入至少 32 字节的高熵密钥。
- session.key 与微信 AppSecret 不同。前者由本机安全生成，后者必须由微信平台签发，不能自行编造。
- 新会话使用随机令牌及 HMAC 签名，服务端仅保存令牌哈希。浏览器使用 HttpOnly、SameSite=Lax Cookie；Secure 策略见前述本地与独立服务说明。不将密钥或登录令牌放入 localStorage。
- 普通服务启动时没有设置 CANVAS_ADMIN_PASSWORD 不会创建默认管理员，旧的固定默认密码已停用。本机已显式运行 scripts/setup-local-admin.mjs 初始化随机强密码管理员，访问文件位置见 ADMIN-ACCESS.md；重复运行不会覆盖已有账号或密码。
- 备份数据时保护整个账号目录和会话密钥；限制目录为服务账号可读写。不要把账号目录或密钥打包到前端或提交 Git。

## 接口与安全边界

- GET /api/auth/me：当前会话的公开用户信息。
- POST /api/auth/login、POST /api/auth/logout：已有密码账号登录/退出。
- GET /api/auth/wechat/config：非敏感就绪状态。
- POST /api/auth/wechat/attempts：创建五分钟有效扫码任务，返回微信官方嵌入式二维码地址；身份绑定值保存在 HttpOnly Cookie。
- GET /api/auth/wechat/attempts/:id：仅发起浏览器可查的可信阶段，不表示扫描百分比。
- GET /api/auth/wechat/callback：微信回调，校验随机 state 并由服务器交换 code；不直接向回调访问者发放登录会话。
- POST /api/auth/wechat/attempts/:id/complete：仅原浏览器可确认注册和创建会话，任务一次性消费。
- POST /api/auth/wechat/attempts/:id/cancel：仅原浏览器可取消，过期或取消后不能再完成。
- 创建与确认要求同源 JSON 请求；state 防伪造/重放，扫码创建有频率和容量上限。上游仅调用固定微信官方 HTTPS 接口，失败不返回 token、AppSecret 或原始上游异常。
- 二维码任务暂存于单实例内存，重启后需重新扫码；用户、ID、密钥与会话持久化。当前 JSON 存储适合本机/单实例，不支持多个进程同时写入同一数据目录。
- 所有业务接口现在额外要求登录，原有 Host、Origin、本机桌面访问及任务归属限制仍保留。桌面工程库仍属于服务电脑，并未实现按账号隔离；账号系统不是桌面服务公开部署的完整安全替代方案。

## 验证

执行 npm run test:server 与 npm run build。wechat-auth.test.mjs 使用模拟官方响应覆盖首次注册、重复账号/重启、身份归属、state 重放、取消、过期、限流、错误信息脱敏、会话签名、退出与密钥持久化；测试不调用真实微信、不创建真实微信账号。
真实联调还需配置应用凭据后验证：手机扫码确认、同账号再次登录仍使用原 ID、拒绝授权/二维码过期、关闭弹窗、重新打开页面保持会话。
