# 双人对话分离 · Demo App + 演示视频

输入一段**两个人同时说话**的音频，输出**两条分轨**——一条只有说话人 1，一条只有说话人 2。
本仓库既是一个可以在浏览器里点着用的 demo app，也包含把整段真实操作录下来的演示视频。

## 成品

| 文件 | 规格 | 用途 |
| --- | --- | --- |
| `out/demo-双人对话分离.mp4` | 1920×1080 · 25 fps · 35.7 s · H.264 + AAC 192k | B 站 / YouTube / 微信视频号 |
| `app/` | FastAPI + 原生前端 | 本地跑起来自己试 |

视频里的每一个画面都是**真实 app 的操作录像**（Playwright 驱动 Chromium 录屏），
每一条波形、每一段时间轴、每一个语音秒数都来自**真实运行的分离结果**，没有一张贴图。

## 视频结构

| 时间 | 段落 | 画面 |
| --- | --- | --- |
| 0–6 s | 片头 | 两人对话的声波剪影 + 主张「谁在说话，分得一清二楚」 |
| 6–15.5 s | 上传 · 处理 | 拖入 `dialog.wav` → 五阶段进度（解码 / 声纹 / 聚类 / 掩码 / 写出）实时推进 |
| 15.5–22.4 s | 结果 · 说话人 1 | 两路波形 + 三条时间轴（混合、A、B），点「试听」播放说话人 1 的片段 |
| 22.5–28.2 s | 结果 · 说话人 2 | 同一界面切换到说话人 2，音频同步切换 |
| 28.2–30.4 s | 导出 | 两条分轨的 WAV 下载、指标脚注（处理耗时、倍速、聚类裕度） |
| 30.4–35.7 s | 收尾 | 三步流水线说明（ECAPA 声纹 → 2-means 聚类 → 掩码重建） |

音轨按画面上「试听」被点中的帧摆放：混合音在 7.05 s 起播，说话人 1 在 16.66 s，说话人 2 在 22.47 s。
对齐不是猜的——录屏开头有一帧白闪，脚本用它的墙钟时刻反推录屏起点偏移（±0.02 s）。

## 分离效果（实测，`scripts/eval_separation.py`）

素材：LibriSpeech test-clean（CC BY 4.0）两位说话人各 6 句，交替成 12 个回合，
其中若干回合故意**重叠 0.44 s**，混成 30.9 s 单声道对话。

| 输出 | 对应真值 | SI-SDR | 残留串音 | 与真值相关 |
| --- | --- | --- | --- | --- |
| `spk1.wav` | 说话人 A | **17.76 dB** | 0.77 | 0.992 |
| `spk2.wav` | 说话人 B | **17.10 dB** | 0.81 | 0.990 |

平均 **17.43 dB**，纯 CPU（16 kHz），30.9 s 音频处理耗时 **6.05 s ≈ 5.1× 实时**。

> 早期的分离器用的是 `speechbrain/sepformer-whamr16k`，在**真实重叠对话**上只有约 −0.9 dB（几乎不分离）：
> 该模型是按 8 kHz、含噪混响的合成数据训的，对干净的 16 kHz 对话会挑错输出通道。
> 所以最终引擎改成「VAD 切窗 → ECAPA-TDNN 声纹嵌入 → 余弦 2-means 聚类 → 掩码重建」，
> 同一份素材从 −0.9 dB 提到 17.4 dB，且天然支持多人轮次与重叠。

## 跑起来

```bash
./start.sh          # 收掉旧进程 → 起服务（默认监听 0.0.0.0）→ 打印本机 + 局域网地址
```

启动后会打印两个地址：

```
本机    → http://127.0.0.1:8010
局域网  → http://192.168.1.108:8010   （手机/平板连同一个 WiFi 直接打开）
```

- 手机、平板、另一台电脑连同一个局域网就能用，页面在窄屏下自动改成单列布局。
- 只想本机用：`HOST=127.0.0.1 ./start.sh`；换端口：`PORT=9000 ./start.sh`。
- 局域网打不开多半是防火墙：`sudo ufw allow 8010/tcp`。
- 服务没有鉴权，**只在可信网络里开着**，用完 `Ctrl+C` 或杀掉进程。

手写版：

```bash
HF_HUB_OFFLINE=1 .venv/bin/python -m uvicorn app.server:app --host 0.0.0.0 --port 8010
```

页面里有两条入口：**拖入任意双人对话音频**（WAV / MP3 / FLAC / M4A，引擎自己重采样到 16 kHz），
或者直接点 **「使用示例对话」** 用仓库里备好的 `samples/双人对话_30s.wav`（LibriSpeech 两位说话人，30.9 s）。

处理完会看到两路波形 + 三条时间轴（说话人 1 / 说话人 2 / 原始混音），可分别试听、下载。
原音频也能试听：文件名旁边的「▶ 试听原音频」，或者直接点「原始混音」那一行，
播放时时间轴上会跑一条播放头，方便和分出来的两条轨对比。
每路分轨额外生成一段 5.9 s 的 `*_preview.wav`：把该说话人的各个回合拼成连续片段，
因为真实的轮次之间隔着几秒停顿，直接整轨试听会听到大量空白。

想自己录演示视频，看 [`docs/录制指南.md`](docs/录制指南.md)：窗口尺寸、OBS 设置、30 秒点击流程都写好了。
改完前端或后端，用 `node scripts/check_app.mjs` 跑一遍（示例流程、试听、下载、拖拽、排版四项一起过）。

## 重新生成视频

```bash
.venv/bin/python scripts/make_dialog.py       # 合成双人对话 + 真值分轨（需 data/raw/*.parquet）
.venv/bin/python scripts/sep_engine.py data/dialog/mix.wav data/dialog/separated
.venv/bin/python scripts/eval_separation.py   # 写 data/dialog/separated/eval.json
node scripts/record_demo.mjs                  # 真实操作录屏 + 布局审计 → build/video/*.webm
.venv/bin/python scripts/make_video.py        # 配乐轨 + 封装 → out/demo-双人对话分离.mp4
```

`record_demo.mjs` 在录制过程中会顺手做布局审计（文字溢出、元素出界、画布留白），
任何一项不过都会打印在 `build/record.log` 的 `reports` 里；本次录制全部 `issues: []`。

## 目录

```
app/server.py          FastAPI：/api/jobs 提交、/api/jobs/{id} 进度、分轨音频
app/static/            index / title / outro 三个页面 + 前端逻辑
scripts/sep_engine.py  分离引擎（VAD + 声纹聚类 + 掩码重建）
scripts/eval_separation.py  SI-SDR / 串音 / 相关度评测
scripts/make_dialog.py     双人对话素材合成
scripts/record_demo.mjs    真实 app 操作录屏（Playwright）
scripts/make_video.py      音轨对齐 + 封装 MP4
data/dialog/           素材、真值分轨、分离结果
out/                   成品视频
```
