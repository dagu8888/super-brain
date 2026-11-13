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

## 2.8.0 语音模式与 Deepgram

浏览器只请求本机 API，不直连 Deepgram，永久密钥不下发。

- 按住说话：仍走 Moonshine `POST /api/owner/stt`，松手只填字，不自动发送。Deepgram 已配置时，幕僚长回复可改由文静朗读。
- 流式：同一台香港 Moonshine 边车做滚动识别，可随时打断。本机不装 ZipVoice / Kokoro。没有本地 TTS 时，朗读改用 Deepgram 文静；没配密钥就退回浏览器语音。
- 实时：服务端代理 Nova-3（`language=zh`）和 Flux `/v2/speak`（`model=flux-wenjing-zh`）。对话仍发给幕僚长 `grok-chief`，不使用 Deepgram Voice Agent。
- 欢迎语是静态文件 `70-Console/design/prototype/v2/audio/welcome-dagu-wenjing.mp3`（可再配同名 ogg），文案「大古，欢迎回来」。文件由幕僚长用文静生成后放进该路径。没有文件就跳过欢迎语，背景音乐照样按默认开播。
- 密钥：环境变量 `DEEPGRAM_API_KEY`，或 `/root/provision/deepgram.env`（`chmod 600`）。模板见 `deepgram.env.example`。Gemini Live、ElevenLabs、阿里云百炼只预留槽位。查看语音状态走读接口鉴权（主人会话或令牌）；保存密钥仍要当日口令。
