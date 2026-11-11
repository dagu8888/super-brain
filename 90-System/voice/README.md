# 按住说话 · Moonshine 中文识别（服务器边车）

- 模型：Moonshine Voice `tiny-streaming-zh`（Mandarin Tiny Streaming，34M 参数，MIT），CDN 目录 `quantized_26_08_24`，
  8 个文件共 32,290,152 字节（≈30.8 MiB），SHA256 见 `model-tiny-streaming-zh.sha256`。包：`moonshine-voice==0.1.6`。
- 为什么不在浏览器里跑：`@moonshine-ai/moonshine-wasm@0.1.6` 的内置目录里中文只有 Community License 的非流式 base-zh（≈141MB），
  且它的加载器不认中文流式模型的 `frontend.model.ort`/`frontend.weights.ort` 拆分文件（实测报 Invalid argument）；
  再加 13MB wasm + 线程版需 COOP/COEP。等官方发布支持中文流式模型的 wasm 后再迁回本机识别。
- 链路：iPhone 按住 → Web Audio 采集（不依赖 MediaRecorder 格式）→ 16kHz/16-bit WAV →
  `POST /api/owner/stt`（只认已配对的 dagu-owner 设备令牌，≤30 秒）→ 本机 `127.0.0.1:18791` 边车 → 文字回填输入框，大古确认后才发送。
- 音频生命周期：浏览器只在内存里，发完即丢；主进程与边车都只在内存里转写，不落盘、不进日志/审计。
- 音频保留硬规则：任何录音/合成音频只留最近 10 条。`audio_retention.py` 只删音频目录本层、扩展名在白名单里的普通文件；
  边车每次请求后调用一次，`sb-audio-prune.timer` 每小时兜底；模型/WASM 不受影响。
- 资源：边车 systemd `MemoryMax=400M`、`CPUQuota=100%`、`Nice=10`，OOM 只杀边车。
- 安装：`bash 90-System/voice/setup_server.sh`（幂等，含 SHA256 校验）。测试：`python3 90-System/runtime/tests/test_voice.py`。
