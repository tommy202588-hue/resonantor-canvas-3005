# SeedVR2 v2.5.1 · 画布 2× / 4×

## 当前接入

画布“高清放大”已从 Real-ESRGAN 替换为 SeedVR2 v2.5.1。默认 2×，可选 4×。
运行图由 server/upscale-workflows.mjs 生成，服务端固定选择模型、种子和服务地址。
原图短边通过 GetImageSize + ComfyMathExpression 乘以倍率后输入 SeedVR2；不封顶后插值、不先压缩原图。
输出节点仍为 9，保持任务查询、取消、结果回传、新建节点、项目持久化与自动下载协议。

- SeedVR2-2.5.1-2x-画布同款.json / 4x-画布同款.json：ComfyUI 编辑器预设。
- SeedVR2-2.5.1-2x.api.json / 4x.api.json：相同预设的 API 图；不是编辑器 JSON。
- 编辑器倍率开关关闭为 2×、开启为 4×；只需换输入图片，不用填写分辨率。
- 早先“已验证2048”文件为独立历史预设，不是画布当前运行图。
- 画布服务端另行合成原图透明通道并校验精确宽高；直接在 ComfyUI 运行展示图不包含这一步。

## 本机服务

- 环境：D:/other/comfyui/ComfyUI-aki-v1.7/ComfyUI-aki-v1.7。
- 高清放大固定使用回环 8190；去背景、缺少 engine 字段的历史任务仍使用 8188。
- 原 8188 进程未重启，不打断其他任务。8190 已加载新节点，运行中的用户编辑器内容未被覆盖。
- 未运行时使用同一 Python 隐藏启动 8190，仅启用 seedvr2_videoupscaler 自定义节点，保留 cuda-malloc / cpu-vae。
- 自动启动用户目录：ComfyUI/user/canvas-upscale/seedvr-user；两份倍率预设已放入 default/workflows。
- 当前复用先前验证进程，其 user/output 目录位于工作区 diagnostics；以后自动启动时改用上述固定用户目录及默认 ComfyUI 输出目录。结果始终通过任务 history/view 获取，不依赖输出磁盘路径。
- 重复启动请求合并；启动超时后不杀进程，再次点击也不创建本服务已登记进程的副本。
- 不向浏览器暴露任意命令、地址、模型路径、工作流提交能力，不更改现有登录及任务归属校验。

## 参数与来源

节点：官方 Comfy Registry 的 seedvr2_videoupscaler 2.5.1，未用最新版替代。
注册信息：https://api.comfy.org/nodes/seedvr2_videoupscaler/versions/2.5.1
分发包：https://cdn.comfy.org/ainvfx/seedvr2_videoupscaler/2.5.1/node.zip
模型来源：numz/SeedVR2_comfyUI（Hugging Face）；因直连不可用，经镜像下载并按官方登记 SHA256 校验。
节点 2.5.1 包内许可为 MIT；模型使用须另行遵循模型仓库附带的许可及使用条件，不能用节点许可替代模型许可。

模型位于 ComfyUI/models/SEEDVR2：
- seedvr2_ema_3b_fp8_e4m3fn.safetensors，3,391,544,696 字节，SHA256 3bf1e43ebedd570e7e7a0b1b60d6a02e105978f505c8128a241cde99a8240cff。
- ema_vae_fp16.safetensors，501,324,814 字节，SHA256 20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1。

固定种子 42，3B FP8 DiT，32 blocks CPU swap，SDPA，CPU offload。
VAE 分块编码与解码均为 512 / overlap 64；batch_size=1，max_resolution=0，LAB 色彩校正，不使用编译或 FlashAttention。
SeedVR2 会生成细节，可能改变文字、面部、纹理；大图仍可能因显存或内存不足失败，不保证任意尺寸或固定速度。

## 验证（2026-09-17）

- RTX 4080 16GB，真实服务链路提交 321×479 透明 PNG。
- 2×：642×958，约 7.2 秒；4×：1284×1916，约 10.2 秒（含上传、轮询与透明通道后处理，不是模型基准）。
- PNG 尺寸及原始透明通道缩放后逐像素比对通过，自动保存副本存在。
- Node 147 项测试通过，Python 4 项图像测试通过，Vite 构建通过。
- 可运行 node workflows/seedvr2-2.5.1/verify-canvas.mjs 复验；只使用 diagnostics/seedvr-canvas-validation 内的测试工程数据及下载目录，不操作用户画布工程。队列非空时退出，不清空或中断队列。

此前教程只能读取公开视频简介与预览图，未取得完整视频字幕或作者原始工作流；本图是按官方 2.5.1 节点接口搭建并实测的对应方案，不声称逐节点复制教程。
