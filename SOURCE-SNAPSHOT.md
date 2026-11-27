# 共振画布 3005 源码

此仓库保存 2026-11-27 本地 `main-3005-isolated` 的源码快照，包含前端、后端、Electron 桌面入口、构建脚本、工作流、静态资源、测试及项目文档。

## 本地启动

建议使用 Node.js 22 或更新版本：

```sh
npm ci
npm run dev:3005
```

可选配置参考 `.env.example`、`.env.wechat.example` 和 `.env.deploy.example`。真实密钥和环境配置需在本地配置，不包含在仓库中。

## 构建与测试

```sh
npm run build
npm run test:server
```

此快照保留现有源码和历史说明。部分桌面打包名称仍使用 3004，具体以 `package.json` 和构建脚本为准。旧文档中的发布记录不代表本次快照已部署到官网。

不归档依赖目录、编译产物、安装包、日志、诊断截图、临时测试目录、本地账号/会话数据及真实凭据。
