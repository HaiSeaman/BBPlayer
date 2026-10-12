# BBPlayer 格式扩展开发报告：让 RMVB / AVI / FLV / WMV / TS 真能播

> 报告日期：2026-10-10　　项目版本：BBPlayer 1.7.0（Electron 34.5.8 / Chromium 132.0.6834.210）
> 测试机器：Intel i3-12100F（4 核 8 线程）、15.8 GB 内存、NVIDIA GTX 1660 Ti、C 盘剩余 101 GB
> 本报告所有"实测"数据都在本机亲手跑出来，所有"调研"结论都附了出处链接。
> **本报告只做论证，没有改动任何项目代码。**

---

## 实施结果（2026-10-10 追加，方案 B + LGPL 版 + 加回 11 个关联 + 运行时兜底）

主人拍板后已按本报告实施完毕，落地情况与实施中发现的偏差如下（细节见 `docs/DEVELOPER.md` 第 20 节）：

| 项目 | 报告预估 | 实际落地 |
|---|---|---|
| 转换三档 | 换容器 / 换音频 / 重编码 | ✅ 全部实现，判定规则由 `verify-converter.js` 对账（13 个可探测样本全中） |
| 内置 FFmpeg | LGPL 版，约 60–95 MB | ⚠️ **实际 153.5 MB**（LGPL 共享版：ffmpeg.exe + 7 个 DLL；比静态版大，但动态链接是 LGPL 推荐的用法） |
| 硬件加速 | NVENC 优先 | ⚠️ **本机用不上**：ffmpeg master 版要求 NVENC API 13.1、本机驱动只有 13.0 → 自动退回 OpenH264 软编码（实测 1080p 8.5 倍速 / DVD 30 倍速 / 最坏 1.6 倍速） |
| 运行时兜底 | 需要 | ✅ 三条路径实测触发正确（.rmvb 请求转换 / Xvid-mp4 自动重编码 / DTS-mkv 自动换音频） |
| 常用格式速度 | 不应变慢 | ✅ 原生扩展名走快速通道，实测 0 ms（对比探测路径约 130 ms） |
| 端到端 | 全部格式可播 | ✅ 18 个产物过真实内核：17 个"有画面+有声音"，第 18 个是源文件本身没有音轨（正常） |
| 运行时兜底 | 需要 | ✅ 三条路径实测触发正确（.rmvb 请求转换 / Xvid-mp4 自动重编码 / DTS-mkv 自动换音频） |

**开发完成后的代码审查**（3 位独立只读审查员，共 22 条发现，全部处理）：

| 类别 | 例子 | 处置 |
|---|---|---|
| 真 BUG（严重） | 漏了 `-progress pipe:1` → 进度上报全程失效；兜底换源没有作废校验 → 会把用户正在看的新片劫持掉；`convertFallbackTried` 只增不减 → 同一文件第二次打开永久静音/黑屏；只有音轨的 mp4 被误判成"画面解不出" → 白跑一次重编码且进不了音乐模式 | 全部修复，并补了能抓住它们的测试（进度回调次数、强制档位绕缓存、二次打开复用产物、纯音频进音乐模式、清空后不被慢兜底绑回） |
| 真 BUG（中等） | 转码无超时 → 挂住的 ffmpeg 永久堵死全局队列；探测无并发闸门 → 循环调用可拉起几百个进程；取消/失败残留 `.part.mp4` 碎片；缓存上限只在启动生效；输入文件坏了还换 4 个编码器白跑；磁盘预检公式把 20GB 的 VOB 判成"需要 30GB" | 全部修复（看门狗 120 秒、探测限流 2、finally 清理碎片、转完顺手清缓存、输入错误直接失败、按产物码率估算空间） |
| 已核对无问题 | 三处 IPC 契约一致、`force` 不会进 argv（无注入）、多窗口按窗口 id 隔离、`fullPath` 保持原始文件（标题/历史/续播/字幕都对） | 不动 |

**打包实测**：用 `electron-builder --win --dir` 真跑了一遍，产物里 `resources/ffmpeg/`（9 个文件 153.5MB）与 `app.asar` 内的 `converter.js` 都在正确位置 ✔。

---

## 0. 一句话结论（给主人先看这段）

1. **换播放内核（mpv / libvlc）这条路，对 BBPlayer 是"推倒重来 + 失去一半现功能"，不建议。** 主要候选库都已经死掉或没人验证（详见第 3.C 节）。
2. **推荐方案：内置一个 FFmpeg 程序，按"三档"处理——能直接播的不动、只差容器的"秒级换壳"、编码真不行的才重编码（带进度条）。** 本机实测：换壳 **0.13 秒**，只换音频 **0.38 秒**，重编码 1080p 大约 **1.4～12 倍速**（取决于素材和用不用显卡）。
3. **11 个扩展名按"代价"分三拨**（这是最容易误解的地方，务必看清）：
   - **通常秒级（换壳就行）**：`.ts`、`.m2ts` —— 只要里面的画面是 H.264/HEVC
   - **看里面装什么**：`.avi`、`.flv` —— 装 H.264 就秒级；装 Xvid/DivX、FLV1/VP6 老编码就得重编码
   - **基本必然要重编码**：`.wmv`、`.rmvb`、`.rm`、`.mpg`、`.mpeg`、`.vob`、`.m2v`（7 个）
   - 另外，**任何容器里的 AC3/EAC3/DTS 音轨**（常见于 MKV 高清片源）属于"只换音频"，秒级、视频无损
4. **代价要说清楚**：安装后磁盘多占 **60～95 MB**（下载的安装包大约只多 15～35 MB，因为会压缩）、要处理临时文件与进度提示、有个授权（许可证）问题需要主人拍板。

### 0.1 两条写给实施者的"省时间情报"（调研中踩过的坑）

- **不要用 `fluent-ffmpeg`**：该库 2025-05 已**归档（ARCHIVED）**、npm 标 deprecated，作者自述"已不能配合新版 ffmpeg 工作"（[issue #1324](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg/issues/1324)）。直接 `child_process.spawn` 最省心，也少一个依赖。另外 **`ffmpeg-static` 只给 ffmpeg、不给 ffprobe**（[PR #113](https://github.com/eugeneware/ffmpeg-static/pull/113) 未并入）——正好和本报告"用 `ffmpeg -i` 解析、不带 ffprobe"的设计一致。
- **打包路径有经典坑**：若把 ffmpeg 放进 `node_modules` 再 `asarUnpack`，`require(...).path` 会指向 `app.asar` 内部，**必须替换成 `app.asar.unpacked`**，否则 `spawn` 直接报 ENOENT（Electron issue [#26708](https://github.com/electron/electron/issues/26708)：`spawn` 不像 `execFile` 那样会自动走 asar 重定向）。**建议直接用 `extraResources`（放进 `resources/` 根下、路径稳定、不进 asar）**，避开这个坑。
5. **最省事的替代方案（半天工作量）**：不内置转码，遇到不支持的格式就"一键交给系统里的 PotPlayer/VLC/mpv 打开"。零体积、零风险，但播放体验离开 BBPlayer。

---

## 1. 问题定位：为什么现在打不开（实测证据）

### 1.1 两种完全不同的"打不开"

主人上次看到的"11 种格式打不开"，其实混着两件不一样的事（这是选方案的关键）：

| 类型 | 意思 | 例子 | 解决代价 |
|---|---|---|---|
| **容器不认** | 文件"外壳"Chromium 不认识（连读都读不进去） | .ts / .m2ts / .avi / .flv / .wmv / .rmvb / .vob / .mpg | 只要里面的视频编码是 H.264/HEVC，**换个外壳就行（秒级、无损）** |
| **编码不会解** | 外壳认了，但里面的画面/声音编码 Chromium 没有解码器 | Xvid(DivX)、MPEG-1/2、WMV2/WMV3、RealVideo、Theora、ProRes、H.263、AC3/EAC3/DTS 音轨 | **必须重编码**（慢，有画质损失，但一定能出画面） |

实测证据（本机、用项目自带的 Electron 内核跑真实样本）：

| 原始文件 | 内核真实报错 | 属于哪一类 |
|---|---|---|
| 20_h264_aac.ts | `DEMUXER_ERROR_COULD_NOT_OPEN` | 容器不认（编码 OK） |
| 15_h264_aac.flv | 同上 | 容器不认（编码 OK） |
| 14_h264_aac.avi | 同上 | 容器不认（编码 OK） |
| 41_mkv_h264_ac3.mkv | 能开、**画面有、声音 0 字节** | 容器 OK、音频编码不会解 |
| 42_mkv_h264_dts.mkv | 同上 | 音频编码不会解（DTS） |
| 13_xvid_mp3.avi | `DEMUXER_ERROR_COULD_NOT_OPEN` | 容器+编码都不行 |
| 17_wmv2_wmav2.wmv | 同上 | 容器+编码都不行 |
| 27_rv20_ac3.rmvb | 同上 | 容器+编码都不行 |
| 19_mpeg2_mp2.mpeg / 22_...vob | 同上 | 容器+编码都不行 |
| 25_theora_vorbis.ogv | 能开、**只有声音没画面** | 视频编码不会解（Theora） |
| 50_mov_prores.mov | 能开、**只有声音没画面** | 视频编码不会解（ProRes） |

### 1.2 一个额外发现：AC3/EAC3 的"开关救不了"

很多 MKV 高清片源用 AC3/EAC3/DTS 音轨（画面正常、完全没声音）。我实测了"给内核加平台解码开关"这条路：

```
基线（不加开关）：     AC3 音频字节=0   EAC3=0   DTS=0   （AAC 对照=15559 ✅）
加平台解码开关后：     AC3 音频字节=0   EAC3=0   DTS=0   （AAC 对照=15351 ✅）
```

结论：**命令行开关无效**。出处印证：Chromium 源码里 `enable_platform_ac3_eac3_audio = proprietary_codecs && (is_cast_media_device || (is_ios && tvos))`——Windows 桌面版**编译期就没编进去**（[media_options.gni](https://chromium.googlesource.com/chromium/src/+/HEAD/media/media_options.gni)）。
→ 所以"AC3/DTS 没声音"这个毛病，**只能靠重编码音频**（或自编 Chromium，见 3.D）。

---

## 2. 行业成熟做法调研

### 2.1 三级策略（Jellyfin / Plex 的标准做法，直接照抄思路）

| 档位 | 做什么 | 触发条件 | 代价 | 出处 |
|---|---|---|---|---|
| **Direct Play** | 原样送播放器 | 全都兼容 | 零 | [Plex 官方](https://support.plex.tv/articles/200250387-streaming-media-direct-play-and-direct-stream/) |
| **Remux（换壳）** | 只重新封装，不重编码 | 只是容器不认 | 「几乎不耗 CPU、画质零损失」，Jellyfin 说连树莓派 3 都不怕 | [Jellyfin](https://jellyfin.org/docs/general/clients/codec-support/) |
| **Direct Stream（只转音频）** | 视频照抄、只把音频转成 AAC | 设备解不了 DTS | 远低于视频转码，画质零损失 | Plex「Partially-Transcoded Direct Stream」 |
| **Transcode（重编码）** | 解码再编码 | 视频编码/位深不支持 | CPU 密集、有画质损失、要等 | [Plex 转码](https://support.plex.tv/articles/200250377-transcoding-media/) |

### 2.2 桌面上的"全能播放器"靠什么？——都靠自带 FFmpeg

VLC / mpv / MPC-BE / PotPlayer 的"什么都能播"，来源都是**内置或挂载 FFmpeg（libavcodec）**，不是靠 Windows 系统解码器：
- VLC 官方 wiki：avcodec 模块提供 FFmpeg 的各路解码器（[链接](https://wiki.videolan.org/Documentation:Modules/avcodec)）
- MPC-BE 内部视频/音频滤镜以 FFmpeg 作软解主引擎（[链接](https://deepwiki.com/Aleksoid1978/MPC-BE/3-media-decoding-system)）

**这直接决定了：想让 BBPlayer"什么都能播"，最省的路就是"也用 FFmpeg"，而不是找系统帮忙。**

### 2.3 系统解码器（Media Foundation）帮不上忙

- Windows 自带 MF 原生格式很窄；MPEG-2 要另装"DVD 播放器"应用；AC-3 从 Win11 24H2 起不再随系统提供（[微软文档](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/supported-codecs)）
- 更关键：Chromium **没有任何开关**能把 MF 里的 MPEG-2 / VC-1 / RealVideo 解码器接进 `<video>`。Chromium 源码里 `kMPEG2 / kMPEG4 / kVC1` 一律 `return false`（[supported_types.cc](https://chromium.googlesource.com/chromium/src/+/HEAD/media/base/supported_types.cc)）

### 2.4 Chromium 的能力边界（源码级）

- 认可的容器（文件形式）：MP4/MOV、Matroska(MKV/WebM)、Ogg、WAV 等；**AVI、FLV、RM/RMVB、WMV/ASF、VOB/MPEG-PS 全不在列**
- 视频解码白名单：H.264、VP8/VP9、AV1、Theora（Theora 实测已失效）、HEVC（需显卡硬解）
- 音频解码白名单：AAC、MP3、Opus、Vorbis、FLAC、PCM + 专有开关里的 AAC；**AC3/EAC3/DTS/Cook/WMA 不行**
- MPEG-TS 为什么不能直接喂 `<video>`：TS 解析器只服务于 MSE（网页流媒体），不是文件播放（[mime_util_internal.cc](https://chromium.googlesource.com/chromium/src/+/refs/tags/144.0.7553.0/media/base/mime_util_internal.cc)）

---

## 3. 四个候选方案对比

### 3.A 方案 A：外部播放器交接（最省事，半天工作量）

**做法**：探测到"内核播不了"→ 弹提示 + 一个按钮"用外部播放器打开"（调用 `shell.openPath(file)` 用系统关联程序，或让主人配置 PotPlayer/mpv 的路径）。

- 优点：**零体积、零授权风险、零性能负担**；实现量约 40～80 行
- 缺点：播放体验离开 BBPlayer（没有播放列表/历史/字幕/截图/音乐模式）
- 先例：ZyPlayer（中文 Electron 播放器）README 明写「没有完美的播放器……建议切换播放器或者调用系统播放器」（[链接](https://github.com/Hiram-Wong/ZyPlayer)）；jellypot-shell 一键用 PotPlayer 直放原文件（[链接](https://github.com/Dongz9870/jellypot-shell)）
- **两个必须避开的坑（本项目特有）**：
  1. **死循环**：如果按第 8 节问题 3 把 11 个扩展名加回文件关联，那 `shell.openPath(file)` 会把文件**交回 BBPlayer 自己**（再开一个窗口），形成循环。→ 兜底必须走"主人指定的播放器 exe 路径"（`spawn` 那个 exe + 文件参数），**不能**用 `shell.openPath`。
  2. **本机现在没有对象可交**：实测本机没装 PotPlayer / VLC / mpv，只有 Windows 自带的 Windows Media Player（`C:\Program Files\Windows Media Player\wmplayer.exe` 存在），而 .rmvb 也没有任何系统关联。→ P0 需要一个"外部播放器路径"的设置项（默认给系统媒体播放器，主人可以自己填 PotPlayer/mpv 的路径）。
- **安全坑（必须避开）**：有项目因为"把渲染进程传来的路径直接 `shell.openPath`，且不校验扩展名"，被判定为**可执行任意本机 exe 的高危漏洞**（[Streambert 安全公告](https://github.com/truelockmc/streambert/security/advisories/GHSA-85vf-2qwc-qpm4)）。做这个方案必须锁死扩展名白名单 + 路径存在性校验。

### 3.B 方案 B：内置 FFmpeg 三档转换（**推荐**）

**做法**：打包一个 `ffmpeg.exe`，打开文件时先探测，再按第 2.1 节的三档处理，转好/换好之后照样喂给现有的 `<video>` 播放（UI 一行不用改）。

- 优点：**全部 11 种格式都能播**，其中 `.ts`/`.m2ts`（以及装了 H.264 的 AVI/FLV）与"AC3/DTS 音轨修复"是**秒级、视频无损**；UI/功能全部保留（列表、历史、字幕、截图、音乐模式、多窗口贴合）
- 缺点：安装包变大；重编码要等；要处理临时文件、进度、取消；有授权选择问题
- 本机实测（见第 5 节）：换壳 0.13 秒 / 只换音频 0.38 秒 / 重编码 1080p 1.4～12 倍速
- 先例：addon-previewer（ffmpeg 转码 + Range 随机读，明确列出 rm/rmvb/avi/flv，[链接](https://github.com/orcastor/addon-previewer)）

### 3.C 方案 C：换播放内核（mpv / libvlc）——**不推荐**

调研结论（每条都有出处，详见附录）：

| 候选 | 现状 | 能不能用 |
|---|---|---|
| mpv.js | 靠 Chromium 早已删除的 Pepper/PPAPI 插件机制 | **死路** |
| WebChimera.js（libvlc） | 仓库已 **ARCHIVED**，npm 标注 "no longer supported"，2021 年后无真更新 | **死路** |
| electron-mpv-video | libmpv 原生插件，思路正确，但 0 star、仅 1 个版本、作者只验证过 Electron 40 一个组合 | 实验品 |
| REVENGE977/electron-libmpv | 仅 Windows，3 star，太新 | 不建议押注 |
| node-mpv | 只是"起一个 mpv 外部进程 + IPC"，嵌入要自己传 `--wid`，issue 里有 Electron 里黑屏记录 | 只适合外部窗口 |
| iptvnator（7.3k star，活跃） | **最值得参考的工程范例**：HTML5 为主 + 内嵌 MPV 兜底 | 参考，不是库 |

**换内核会失去什么（这才是真正的成本）**：
- canvas 截图/逐帧取图（`drawImage(video)`）——原生子窗口的画面**不在 Chromium 位图里，根本抓不到**
- CSS 滤镜/旋转/圆角/object-fit
- **Web Audio 音量增益（200%）与音乐模式频谱可视化**（原生窗口的音频不经过 Web Audio）
- HTML 字幕渲染、`<video>` 的事件流（进度/时长/缓冲要改成轮询 IPC）
- 窗口贴合的层级问题：原生子窗口**会盖住 HTML，CSS z-index 打不赢**；DPI 缩放错位是重灾区（iptvnator issue #1145）；Windows 上鼠标事件透传没有官方开关
- 打包复杂度：原生 .node/.dll 必须 asar unpack，Win11 智能应用控制还会拦未签名 exe

**而且没有任何人做到"同一播放会话里从 `<video>` 无缝切到 mpv 且画面连续"**——查到的都是"按文件/按用户选择切播放器"级别。

### 3.D 方案 D：改造 Electron 内置 ffmpeg / 自编 Chromium ——**不推荐**

- Electron 官方构建的 `ffmpeg.dll` 确实**可以热替换**（维护者原话：by design hot swappable），但**只能换 H.264/AAC 这类"专有编码开关"覆盖的东西**（[issue #48097](https://github.com/electron/electron/issues/48097)）
- 想要 HEVC / AC3 / EAC3，必须**自己改 Chromium 源码重编**（社区补丁仓：electron-media-patch、BranchBit 预编译版），意味着自己维护一整条 Chromium 构建链
- 就算换了 ffmpeg.dll，Chromium 那层 C++ 的编码白名单（MPEG-2/VC-1/MPEG-4ASP 一律 false）**照样拦着**，AVI/RM 容器也进不来
- 结论：投入产出比极差，且每次 Electron 升级都要重做

### 3.E 四方案对比总表

| 维度 | A 外部交接 | **B 内置 FFmpeg（推荐）** | C 换内核 mpv | D 改 Electron |
|---|---|---|---|---|
| 能播的格式 | 全部（在别的软件里） | **全部（在 BBPlayer 里）** | 全部 | 只能多几种 |
| 改动量 | 40～80 行 | 中等（一个新模块 + 几个 IPC + 进度 UI） | 极大（等于重写播放层） | 极大且脆 |
| 安装包增量 | 0 | +60～95 MB | +30～50 MB（还可能要签名） | 0（但构建链爆炸） |
| 速度 | 立即（在外部播放器） | 秒级～几分钟（看档位） | 立即（硬解） | 立即 |
| 现有功能 | 播放中全部失效 | **全部保留** | 失去截图/滤镜/Web Audio/HTML 字幕/事件流 | 全部保留 |
| 授权 | 干净 | 需处理 FFmpeg 许可证 | 干净（LGPL）/ mpv 是 GPL | 需自编 |
| 风险 | 低 | 中（临时文件/进度/并发） | **高** | **极高** |
| 建议 | 可作为 P0 先垫上 | **主线方案** | 不做 | 不做 |

---

## 4. 推荐方案 B 的详细设计

### 4.1 总体流程

```
用户打开文件
   ↓
① 探测（ffmpeg -i 读编码信息，不额外带 ffprobe —— 已验证可行）
   ↓
② 判定档位（下表）
   ├─ 0 直接播      → 走现有逻辑（一行不改）
   ├─ 1 只换容器    → ffmpeg -c copy → 临时 MP4 → 播放（实测 0.13 秒）
   ├─ 1b 只换音频   → ffmpeg -c:v copy -c:a aac → 播放（实测 0.38 秒）
   └─ 2 重编码      → 弹进度条 → 转完播放（或先转前 N 秒先看起来）
   ↓
③ 产物进缓存目录（按"文件路径+大小+修改时间"做 key，重复打开不重转）
   ↓
④ 播放结束后按策略清理（退出时清 / 超过容量上限按最久未用清）
```

### 4.1.1 由谁发起、什么时机（**这条不先定，后面全要返工**）

**推荐做法：主进程在把文件交给播放器之前先探测；只有"判定为直接播"才照旧走现有流程，其余情况由主进程转好后把"可播路径"给渲染进程。**

理由（对着现有代码看出来的）：
- 渲染进程现在的失败处理是：`<video>` 报错 → 拉黑该文件 → **1.5 秒后自动跳下一个** → 全部失败就停在"列表中的媒体均无法播放"（`renderer.js` 里那段熔断逻辑）。若改成"先按原路径加载、报错再请求转换"，**.rmvb 会在还没开始转的时候就被自动跳掉**，必须先改造这套熔断/自动跳转逻辑，反而更麻烦。
- 走"先探测再决定"这条路，渲染进程只在拿到可播路径后才加载，**不碰** error / 自动跳转 / 熔断这三段已有逻辑。
- 播放列表连播时同理：切到下一集前先问一句"这个能不能直接播"，能就直接播，不能就先转（并把进度显示出来）。
- 多窗口全局队列也自然落在这个入口上：同一时刻只允许 1～2 个转换任务。

**代价**：首屏多一次探测（`ffmpeg -i`，实测毫秒级），双击 .rmvb 时看到的是"正在转换"而不是空白窗口。

### 4.2 判定表（已用 22 个真实样本对账，**预测 22 / 实测 22，100% 一致**）

| 视频编码 | 音频编码 | 判定 | 实测对应样本 |
|---|---|---|---|
| h264 / hevc / vp8 / vp9 / av1 | aac / mp3 / opus / vorbis / flac / pcm / **mp2** | 容器也认 → **直接播** | 05_h264_aac.mkv |
| h264 / hevc / vp8 / vp9 / av1 | 同上 | 容器不认 → **只换容器** | 14 AVI、15 FLV、20 TS、21 M2TS、**H.264+MP2 的 TS（实测有声音）** |
| h264 / hevc / vp8 / vp9 / av1 | **ac3 / eac3 / dts** | → **只换音频** | 41 / 42 / 61 / 62、o10(TS+AC3) |
| **mpeg4 / mpeg2video / wmv2 / wmv3 / vc1 / rv20 / rv30 / rv40 / flv1 / h263 / theora / prores** | 任意 | → **重编码** | 13 / 47 / 16 / 17 / 18 / 19 / 22 / 23 / 25 / 26 / 27 / 50 / 60 |

补充两条判定规则（都是实测定的，别凭直觉写）：

1. **表外的音频编码一律按"需要换音频"处理**（Cook、WMA、ADPCM、AC3/EAC3/DTS 等）：换音频只花不到 1 秒、视频无损，**猜错的代价极小**；反过来若误判成"能播"，用户就会遇到"有画面没声音"。
2. **MP2 是例外，它可以算"能播"**：DVB/电视录制常见 H.264+MP2 的 TS，实测**纯换容器就能出声**（解码出 84096 字节音频），不需要重编码音频——这条是实测推翻直觉的例子，写进判定表省掉一次多余的转码。
3. **HEVC 要额外小心**：本机实测 HEVC 依赖显卡硬解（关掉硬件加速就 0 帧），且 MP4 里的 `hvc1` 标签、10-bit H.264（Hi10P）、VP9 profile2 都可能"探测说能播、实际黑屏/有声无画"。**建议加一条运行时兜底**：判定为"能播/可换壳"但播了 3 秒仍无画面 → 自动降级去重编码（代价是判定从静态表变成"表 + 实测验证"，多写一点代码，但能挡住这类黑屏）。

> 这个判定逻辑我已经写成原型脚本跑过对账（`decide-prototype.js`），验证方式：拿规则预测 vs 拿真机内核实测结果比，22 个样本全部一致。
> 探测用 `ffmpeg -i <文件>` 的文本输出解析即可，**不需要额外再带一个 ffprobe**（静态版 ffprobe 同样是 90 MB 量级；原型已验证 `ffmpeg -i` 的文本能稳定解析出容器名/视频编码/音频编码）。

### 4.3 三档的 ffmpeg 命令（都是实测跑过的形态）

```powershell
# 档 1：只换容器（视频音频都不动，无损、秒级）
ffmpeg -hide_banner -y -i "输入" -c copy -movflags +faststart "输出.mp4"

# 档 1b：只换音频（视频照抄，音频转 AAC）
ffmpeg -hide_banner -y -i "输入" -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -movflags +faststart "输出.mp4"

# 档 2：重编码（CPU 通用版；有 NVIDIA 显卡可换 h264_nvenc，本机实测快 1.5～4.7 倍）
ffmpeg -hide_banner -y -i "输入" -map 0:v:0 -map 0:a:0 -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -movflags +faststart "输出.mp4"
ffmpeg -hide_banner -y -i "输入" -map 0:v:0 -map 0:a:0 -c:v h264_nvenc -preset p4 -cq 26 -pix_fmt yuv420p -c:a aac -movflags +faststart "输出.mp4"
```

工程细节（都是调研里踩过的坑，直接规避）：
- **必须 `-map 0:v:0 -map 0:a:0` 显式选流**：ffmpeg 默认只挑一条；裸 `-map 0` 遇到 VOB 会把 `dvd_nav_packet` 数据流一起带上导致封装失败
- **别手写 `-bsf:a aac_adtstoasc`**：写 MP4 时 ffmpeg 会自动插入；音频是 AC3 时手写它反而直接报错
- 时间戳异常的 TS 可加 `-fflags +genpts`（**必须写在 `-i` 之前**）
- **不要复制内嵌字幕**（`-c copy` 会把字幕也带走并报 `Could not find tag for codec subrip`）；VOB 的 DVD 字幕是图形字幕，MP4 根本装不了
- 转码产物建议 `.part` 后缀，转完再改名——避免播放器读到半截文件

### 4.4 缓存与临时文件

- 目录：`app.getPath('temp')/BBPlayer-convert/`（跟着系统临时目录走，不污染用户文件夹）
- 文件名：`<原文件名>.<大小>.<修改时间哈希>.mp4`（同一文件第二次打开直接命中缓存，秒开）
- 清理：① 换片/退出时清掉"当前没用到的"；② 容量上限（建议 20 GB）超了按最久未用删；③ 启动时清一次上次残留
- **磁盘空间预检**：开转前用 `fs.statfs`/剩余空间判断（实测体积参考：1080p 一小时 CPU crf23 约 2 GB，NVENC 约 3.5 GB，DVD 画质一小时约 0.6 GB）

### 4.5 进度、取消、失败降级

- 进度：`ffmpeg -progress pipe:1 -nostats`，主进程逐行解析（**本机实测可用**：一次 30 秒转码输出了 48 行键值，含 `out_time_ms`/`out_time_us`（已转出时长）、`speed=16x`（当前速度）、`progress=end`（结束标记））。百分比 = 已转出时长 ÷ 探测到的总时长；还可以用 `speed` 推算"还需约 X 分钟"
- 显示：复用现有的 Toast/进度条（最小改法）；建议额外做一个"转换中 45%"的覆盖层，并**暂时禁用进度条拖拽**
- 取消：用户关窗/换片时 `child.kill()`；Windows 下必要时 `taskkill /pid <pid> /T /F`
- 降级：ffmpeg 不存在/被杀软删了/转换失败 → 退回"提示 + 方案 A 的外部播放器按钮"，**绝不静默失败**
- 进程优先级：`os.setPriority(pid, 'below normal')`，避免转码把 UI 卡住

### 4.6 进度条（seek）策略

- 档 1/1b（换壳、换音频）：产物是完整 MP4，**seek 完全正常**（已实测 7 个产物全部 ✅）
- 档 2（重编码）：两种做法
  - **先转完再播（推荐 P0）**：简单、seek 正常、进度可预期；缺点是等
  - **边转边播（P1 可选）**：先转前 10～30 秒就能立刻开始看（实测 NVENC 转前 10 秒只要 0.82 秒），往后追着转；**用户一拖进度条就得"丢缓存重新起转"**（实测从第 20 秒起转 8 秒耗时 0.83 秒），所以可行性没问题，但要多写不少状态机代码

### 4.7 与现有功能的交互（要一起改的地方）

| 现有功能 | 影响 | 处理 |
|---|---|---|
| 扩展名白名单（`shared-video-exts.js`） | 需要变成三层：原生可播 / 需转换 / 不支持 | 见 4.8 的"要一起改的文件" |
| 文件关联（`package.json`） | **如果想让双击 .rmvb 也能用本软件打开，需要把上次删掉的 11 个扩展名加回来**（并标注"需转换"） | 主人决策 |
| 拖拽过滤、文件对话框 | 需转换的格式要放行并提示"正在转换" | 小改 |
| 音乐模式 | 音频 6 种本身都原生可播，**不受影响** | 不用改 |
| 多窗口播放 | 每个窗口各自转码会把 CPU 吃满 | 主进程加**全局转码队列（同时最多 1～2 个）** |
| 窗口贴合/截图/字幕/历史 | 因为还在用 `<video>`，**全部不受影响**（这是方案 B 相对方案 C 的最大优势） | 不用改 |
| 外挂字幕 | **前提是先按下一行拆开"影片身份"和"播放路径"**：同名 .srt 的查找是用"当前文件路径"去截取目录与文件名的。如果直接把播放源换成临时产物，同名字幕就再也找不到了 | 身份用原路径 → 字幕照旧；否则会静默失效 |
| **播放历史 / 续播 / 窗口标题** | **这是最容易写错的地方**：现在的代码用 `currentFilePath` 同时当"播放源"和"影片身份"（标题、历史键、续播键都靠它）。一旦播放的是转换产物，标题会变成临时文件名、历史与续播会记住临时路径（缓存一清就失效） | 必须把两者拆开：**影片身份继续用原始文件路径**（标题/历史/续播），**播放源用转换产物路径** |
| 内嵌字幕（MKV 里的 ASS/PGS） | 浏览器本来就渲染不了 PGS 图形字幕；要显示只能烧录（最耗 CPU） | 建议 P2 再考虑 |

### 4.8 需要一起改的文件清单（预估）

| 文件 | 改动 |
|---|---|
| `shared-video-exts.js` | 扩展名单分三层（原生 / 需转换 / 不支持） |
| `main.js` | 新增：探测、转码队列、进度 IPC、取消、缓存清理、外部播放器兜底 |
| 新增 `converter.js`（建议） | 把 ffmpeg 相关逻辑单独放一个文件，别塞进已经 672 行的 main.js |
| `preload.js` | 新增 3～5 个 IPC 方法（开始转换/查进度/取消/外部打开） |
| `renderer.js` | 判定结果处理、进度 UI、把"不支持"提示改成"正在转换" |
| `package.json` | `extraResources` 带 ffmpeg、文件关联（若加回）、版本号 |
| `verify-exts.js` | 跟着三层名单更新对账规则 |
| `README*.md` / `docs/DEVELOPER.md` | 格式支持表、体积、授权说明、转换机制说明 |

### 4.9 安全（照抄项目现有的做法，别开新口子）

- `spawn('ffmpeg.exe', [args])` —— **绝不用 shell 拼接字符串**（防注入）；必须带 `windowsHide: true`（否则 Windows 上会闪出一个黑框；注意它与 `detached: true` 互斥，本项目不需要 detached）
- 关窗/换片/退出时必须**确保子进程被杀掉**，否则会留下一直吃 CPU 的孤儿 ffmpeg（Windows 下必要时 `taskkill /pid <pid> /T /F`）
- 输入路径必须过现有的扩展名白名单 + `fs.existsSync`；输出路径由主进程自己拼（不接受渲染进程给的输出路径）
- 载荷上限：探测输出、进度输出都要限长；转码产物体积设上限（防"转出 100 GB 撑爆磁盘"）
- IPC 全部走现有 `isTrustedSender` 校验
- 外部播放器兜底（方案 A）必须锁死"只能打开白名单扩展名的真实文件"

### 4.10 打包与授权（需要主人拍板的一件事）

**体积实测/调研数据**：

| 来源 | 包体 | 说明 |
|---|---|---|
| 本机借用的 ffmpeg.exe（来自第三方软件 File Converter 的安装目录，gyan essentials 静态版） | **94.7 MB** | 单文件静态，含全部常用编解码；同目录**没有 ffprobe**。⚠️ **这个二进制是别的软件自带的，只能用来做验证，正式实施必须自己从官方下载**（BtbN/gyan） |
| BtbN 官方构建（GPL 静态 / 共享） | 191 MB / 84.8 MB（zip） | [releases](https://github.com/BtbN/FFmpeg-Builds/releases) |
| BtbN 官方构建（LGPL 静态 / 共享） | 169.6 MB / 75.8 MB（zip） | LGPL 版**不含 libx264/libx265**（H.264 软编码器是 GPL 的） |

**授权要点（事实 + 出处，法律判断请主人自行决定/咨询）**：
- FFmpeg 本体是 LGPL，但 `libx264/libx265` 等是 GPL——**只要用它们做软编码，整个 ffmpeg 就是 GPL 版**（[ffmpeg 官方 legal](https://www.ffmpeg.org/legal.html)）
- **好消息**：以**独立进程**方式调用（spawn 一个 exe，不链接、不静态链接）在业界被普遍视为"聚合"，主程序可以继续 MIT（Honeymelon 的合规指引明确写：进程调用 → 你的程序保持 MIT；[链接](https://docs.honeymelon.com/legal/license-compliance)）。Electron 生态里 ffmpeg-static（GPLv3 构建）被 MIT 项目直接打包也很常见（如 Kap，[issue 讨论](https://github.com/wulkano/kap/issues/1276)）
- **合规最低清单**：① 随包附 FFmpeg 许可证文本；② 在 README/关于页写明"本软件内置 FFmpeg（GPL/LGPL），仅作为独立程序调用，源码可从 xxx 获取"；③ 不改动 FFmpeg 二进制；④ 如果选了 LGPL 版，还要能提供对应源码/构建配置
- **两条路线**：
  - **想要授权最干净**：用 **LGPL 版**。它**不含 libx264/libx265**，但 BtbN 的 LGPL 构建里**带了 OpenH264**（BSD-2 许可的软件 H.264 编码器）和硬件编码器（NVENC/QSV/AMF），所以"重编码"照样能做：优先用显卡（主人的 GTX 1660 Ti 实测可用），没有显卡就退回 OpenH264 软编码（速度和质量不如 x264，属可接受的兜底）
    - ⚠️ 实施前必须用 `ffmpeg -encoders` 实际确认一次手里那个构建到底带哪些编码器（不同构建/版本会有差异）
  - **想要到处都能转、质量最稳**：用 **GPL 版**（含 libx264 软编码，任何电脑都能转）；代价是必须做第 4.10 节那套 GPL 合规声明

---

## 5. 本次实测数据汇总（全部在本机跑出来）

### 5.1 三档处理在各格式上的真实结果（22 个源文件 → 66 个产物，逐个喂内核验证）

| 方案 | 完整可播（有画面 + 有声音） | 覆盖了谁 |
|---|---|---|
| A 只换容器 | **5 / 22** | TS、M2TS、FLV(H.264)、AVI(H.264)、MKV(H.264+AAC) |
| B 只换音频 | **9 / 22**（含 A 的 5 个） | 上面这些 + MKV/MP4 装 AC3/EAC3/DTS 的 |
| C 重编码 | **21 / 22** | 全部；唯一"不满足"的是 23_mpeg2.m2v——它本来就没有音轨，画面正常，属正常结果 |

### 5.2 耗时与速度（30 秒素材，实测墙钟时间）

| 操作 | 耗时 | 折算速度 | 备注 |
|---|---|---|---|
| 1080p H.264 TS → MP4 换容器 | **0.13 秒** | ≈230 倍实时 | 无损 |
| 1080p+DTS → MP4 只换音频 | **0.38 秒** | ≈79 倍实时 | 视频无损 |
| 720p+AC3 TS → 只换音频 | 秒级 | — | 实测"画面+声音都有"；**纯换容器则只有画面没声音** |
| 1080p 重编码（好压素材）CPU veryfast | 3.75 秒 | 8 倍实时 | i3-12100F |
| 1080p 重编码（好压素材）NVENC p4 | 2.49 秒 | 12 倍实时 | GTX 1660 Ti |
| 1080p MPEG-2 重编码 CPU / NVENC | 3.23 / 1.88 秒 | 9.3 / 16 倍 | — |
| DVD 720×576 MPEG-2 重编码 CPU / NVENC | 0.99 / 0.58 秒 | 30 / 52 倍 | 老片最常见场景 |
| **1080p 高噪点（最难压）CPU veryfast** | **21.79 秒** | **1.4 倍实时** | 最坏情况 |
| **1080p 高噪点（最难压）NVENC** | **4.68 秒** | **6.4 倍实时** | 最坏情况 |
| 只转前 10 秒（NVENC，含启动） | 0.82 秒 | — | "边转边看"的可行性依据 |
| 从第 20 秒起转 8 秒（NVENC / CPU） | 0.83 / 0.99 秒 | — | 拖进度条的代价 |

> **换算成实际体验**：一部 1 小时的 1080p 老片，CPU 大约 5～45 分钟（看素材难度），NVENC 大约 5～10 分钟；DVD 画质的老片通常 1～3 分钟。**换壳和只换音频是"点开就到"级别。**
>
> ⚠️ 两点老实交代：① 上表的"速度"用合成素材测出，好压/难压两种极端都测了，真实影片介于两者；② **CPU 用 `-crf 23`、显卡用 `-cq 26`，这两个参数不是同一把尺**（业界实测同样数字下 NVENC 产物会大近一倍），所以上表里的"产物体积"不能直接拿来比画质，只是给主人一个磁盘占用的量级参考。

### 5.3 其他实测事实

- **进度条拖拽**：换容器 / 只换音频 / CPU 重编码 / NVENC 重编码 / 只转前 10 秒 —— 7 个产物**全部跳转正常**（跳转后帧数继续增长）
- **解码器齐不齐**：本机 ffmpeg 里 `rv30 / rv40 / cook / vc1 / wmv3 / wmapro / mpeg2video / theora / prores` 解码器**全部存在**
- **AC3/EAC3 开关实验**：无效（音频字节恒为 0）
- **判定规则对账**：22 个样本预测 vs 实测 **22 / 22 一致**

### 5.4 主人点开会看到什么（按扩展名的体验预期）

| 扩展名 | 文件里装的东西 | 点开后的实际体验 |
|---|---|---|
| `.ts` / `.m2ts` | H.264 / HEVC（+AAC/AC3） | **秒开**（换壳 0.13 秒）；若音轨是 AC3/DTS 会顺手转成 AAC，仍然秒开 |
| `.flv` | H.264 + AAC | **秒开** |
| `.flv` | FLV1(Sorenson) / VP6 老编码 | 出进度条，转完自动播放 |
| `.avi` | H.264 + AAC/MP3 | **秒开** |
| `.avi` | Xvid / DivX（MPEG-4 ASP） | 出进度条，转完自动播放 |
| `.wmv` | WMV2 / WMV3 / VC-1 | 出进度条，转完自动播放；老片有花屏风险（ffmpeg 官方承认 WMV9 解码"not completely working"） |
| `.rmvb` / `.rm` | RealVideo 9/10 + Cook 音频 | 出进度条，转完自动播放；**本机无真样本可测**（见 5.5），老片有花屏/解到结尾报错的风险 |
| `.mpg` / `.mpeg` / `.vob` / `.m2v` | MPEG-1 / MPEG-2 | 出进度条，转完自动播放；DVD 画质老片通常 1～3 分钟转完 |
| 任意 `.mkv` / `.mp4` 里装 AC3 / EAC3 / DTS 音轨 | 画面 H.264、音频不兼容 | **秒开且有声音**（只换音频 0.38 秒，视频无损） |

> 一句话：**主人手上如果是"下载的剧集/录制的电视/老 DVD 转出来的片子"，多数是"秒开"或"几十秒"；真正要等的是 RMVB 老番和 WMV/VOB 这类。**

### 5.5 诚实说明（这些我没能验证）

1. **真正的 RMVB（RV30/RV40 + Cook 音频）没有样本可测**：ffmpeg 只能解码、不能编码 rv30/rv40/cook，我无法在本机"造"出一个真 RMVB。我验证到的是：容器 demuxer 认识、解码器存在、决策规则与 rv20 实测一致。**风险**：ffmpeg 官方对 RV30 的措辞是 "still far from ideal"，个别老片可能花屏或解到文件尾报错。
2. **WMV3/VC-1** 同理（无编码器造不出样本），官方措辞是 WMV9 解码 "not completely working"。
3. **速度数据用的是合成素材**（好压/难压两种极端），真实影片介于两者之间；CPU 型号不同结果会差很多。
4. **未做真实 GUI 目视验证**：以上全部是无界面（隐藏窗口 + 真实内核）验证，符合项目"禁止 GUI 测试"的规矩，但"主人肉眼看到画面"这一步留到实施阶段验收。
5. **授权合规是工程惯例，不是法律意见**——最终请主人自行判断或咨询。

---

## 6. 分阶段实施计划（每阶段都能单独验收、单独回滚）

### P0：打好底子（预计 0.5～1 天）——"至少要能给个说法"
1. 遇到内核不支持的格式，给出明确提示 + "用外部播放器打开"按钮（方案 A）
2. 提示语从"系统无法解码该文件"改为"该格式需要转换，点此用外部播放器打开"
3. **验收**：拖入 .rmvb/.avi/.wmv → 有明确提示、点按钮能用系统播放器打开；**不影响任何现有格式**
4. **测试方式**（无界面可测）：用现有 IPC 打桩 + 拖放事件注入的冒烟台，断言 Toast 文案与 IPC 被调用

### P1：核心转码（预计 2～4 天）——"秒级的先能用"
5. 打包 ffmpeg（`extraResources` + 开发/打包两种路径解析）
6. 新增 `converter.js`：探测 + 判定 + 执行档 1 / 档 1b
7. 缓存目录、命名、清理、磁盘预检
8. **验收**：.ts / .m2ts / .flv(H.264) / .avi(H.264) / MKV+AC3/DTS **打开后 1 秒内出画面且有声**
9. **测试方式**：改造本次的"内核探针台"（报告画面帧数 + 音频字节数），对 5 个真实样本跑红-绿验证

### P2：重编码 + 体验（预计 3～5 天）——"慢的也能用"
10. 档 2 重编码 + 进度 IPC + 进度 UI + 取消
11. 全局转码队列（多窗口并发限流）、进程降优先级、NVENC 自动探测与回退
12. 失败降级到 P0 的外部播放器
13. **验收**：.rmvb / .avi(Xvid) / .wmv / .mpg / .vob → 出现进度条 → 转完自动播放 → 播放中可拖进度条；转码中换片能正确取消
14. **测试方式**：批量转换脚本（无界面）跑 11 种格式，逐个用探针台验证"帧数 > 0 且音频字节 > 0"

### P3：可选优化（不急）
15. 边转边看（先转 30 秒）、硬件编码优先策略、缓存容量设置界面、内嵌字幕烧录
16. **不做**：换内核（mpv/libvlc）、自编 Chromium

### 回滚方案
- 每个阶段都只"新增文件 + 少量开关改动"；P0 之后任何一步出问题，把 `shared-video-exts.js` 的名单和 `package.json` 的 `extraResources` 一撤就回到现在这版（不需要动 `<video>` 播放路径）

---

## 7. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| 老编码解码质量（RV30/WMV3） | 个别老片花屏/报错 | 提前在真实片源上抽样验证；失败就提示外部播放器 |
| 转码等待时间不可预期 | 用户体验差 | 进度条 + 取消 + "先转 30 秒立即开看"；NVENC 优先 |
| CPU/内存被吃满（多窗口/后台） | UI 卡顿、笔记本风扇狂转 | 全局队列限 1～2 个 + 进程降优先级 + 提供"只在空闲时转" |
| 临时文件占磁盘 | 撑爆系统盘 | 容量上限 + 退出清理 + 开转前预检剩余空间 |
| ffmpeg.exe 被杀软/安全软件删掉 | 功能失踪 | 启动自检 + 友好提示 + 允许主人手动指定路径 |
| 安装包从几十 MB 涨到上百 MB | 下载/传播变慢 | 选 LGPL-shared 版 / 只保留必要编解码器自编（可压到 20 MB 级，但要多花 1 天搭构建） |
| 授权合规 | 法律层面（个人自用风险极低） | 附许可证文本 + README 声明（第 4.10 节清单） |
| **主人上次刚删掉的 11 个扩展名要加回来** | 与上次改动方向相反 | 加回来时标注"需转换"，并在 README 写清"转换后才能播" |

---

## 8. 需要主人决策的问题（只有这些需要主人拍板）

1. **走哪条路？** ① 只做方案 A（外部播放器，半天）② 做方案 B（内置转换，2～5 天起）③ 先 A 后 B（推荐，分阶段）
2. **打包哪个版权的 ffmpeg？** ① LGPL 版（授权最干净：不含 GPL 的 x264/x265，但带 OpenH264 软编码兜底 + 硬件编码）② GPL 版（编码质量与兼容性最稳，但需要做 GPL 合规声明）
3. **要不要把上次删掉的 11 个扩展名加回文件关联？** 加回来 = 双击 .rmvb 会用 BBPlayer 打开（然后转码）；不加 = 双击仍由系统/别的播放器打开
4. **重编码时的体验选哪种？** ① 转完再播（简单、稳）② 先转 30 秒立即开看（体验好、代码多）
5. **缓存容量上限**设多少？（建议 20 GB，放系统临时目录）
6. **ffmpeg 用哪个精确版本、从哪里下？二进制要不要进项目目录/提交进 Git？**（95～170 MB 的二进制通常**不进 Git**，改为打包时下载或主人本地放一份；这件事要先说好，因为项目规定不允许我擅自用 git）
7. **要不要允许把"无界面测试脚本"放进仓库？**（本项目现在没有测试框架；我这次用的探针台都在临时目录。放进去的好处是每阶段"改坏了立刻发现"，代价是仓库多几个脚本文件）
8. **P0 的"外部播放器"交给谁？**（本机只有 Windows 自带媒体播放器；是否要设一个"外部播放器路径"设置项，让主人自己填 PotPlayer/mpv？）
9. **要不要加"运行时兜底"？**（探测说能播、实际黑屏/有声无画 → 自动改去重编码；能挡住 HEVC 无硬解、10bit、`hvc1` 标签这些坑，代价是多一点代码）
10. **真实老片样本**：主人手上如果有真的 `.rmvb` / `.wmv`（RV30/RV40、WMV3/VC-1 那种），放几部到固定目录给我，我就能把 P2 的验收从"合成样本"升级成"真片验证"；没有的话 P2 验收标准要写成"合成样本通过 + 失败即降级外部播放器"。

---

## 9. 附录

### 9.1 本次实测的证据文件（都在临时目录，可随时复查）

| 路径 | 内容 |
|---|---|
| `C:\Users\xi\AppData\Local\Temp\bbprobe\samples\` | 48 个自造测试样本（含 11 种待支持格式、坏文件、10bit/HEVC 等） |
| `C:\Users\xi\AppData\Local\Temp\bbprobe\result.json` | 45 个文件的内核解码总表 |
| `C:\Users\xi\AppData\Local\Temp\bbfmt\out\` | 66 个"换容器/换音频/重编码"产物 |
| `C:\Users\xi\AppData\Local\Temp\bbfmt\result-66.json` | 66 个产物的画面帧数 + 音频字节数（判定"真能播"的原始数据，报告第 5.1 节的 5/9/21 就出自这里） |
| `C:\Users\xi\AppData\Local\Temp\bbfmt\result.json` | 补充实验：同一份 H.264+AC3 的 TS，"纯换容器（0 字节音频）"vs"换容器+音频转 AAC（15586 字节）"的对比 |
| `C:\Users\xi\AppData\Local\Temp\bbfmt\matrix.json` | 各方案成功/失败与耗时 |
| `C:\Users\xi\AppData\Local\Temp\bbfmt\seek-result.json` | 进度条拖拽验证结果 |
| `C:\Users\xi\AppData\Local\Temp\bbfmt\decide-prototype.js` | 决策规则原型 + 22 样本对账脚本（可重复运行） |
| `C:\Users\xi\AppData\Local\Temp\bbperf\` | 真实分辨率性能素材与产物 |

### 9.2 关键外部参考（按主题）

- Chromium 支持边界：[supported_types.cc](https://chromium.googlesource.com/chromium/src/+/HEAD/media/base/supported_types.cc)、[mime_util_internal.cc](https://chromium.googlesource.com/chromium/src/+/refs/tags/144.0.7553.0/media/base/mime_util_internal.cc)、[音频视频支持](https://www.chromium.org/audio-video/)
- 三级策略：[Plex Direct Play](https://support.plex.tv/articles/200250387-streaming-media-direct-play-and-direct-stream/)、[Plex Transcoding](https://support.plex.tv/articles/200250377-transcoding-media/)、[Jellyfin codec support](https://jellyfin.org/docs/general/clients/codec-support/)
- FFmpeg：[官方文档](https://ffmpeg.org/ffmpeg.html)、[bitstream filters](https://ffmpeg.org/ffmpeg-bitstream-filters.html)、[格式支持总表](https://ffmpeg.org/general.html)、[许可与合规清单](https://www.ffmpeg.org/legal.html)
- 打包与授权：[BtbN 构建（含体积）](https://github.com/BtbN/FFmpeg-Builds/releases)、[进程调用保持 MIT 的合规说明](https://docs.honeymelon.com/legal/license-compliance)、[Kap 的 GPL ffmpeg 讨论](https://github.com/wulkano/kap/issues/1276)
- 换内核（结论：不做）：[mpv.js](https://github.com/Kagami/mpv.js)、[WebChimera（已归档）](https://github.com/RSATom/WebChimera.js)、[iptvnator 内嵌 mpv 实战坑](https://github.com/4gray/iptvnator/blob/master/docs/architecture/embedded-mpv-native.md)、[Electron 原生子窗口 issue #10547](https://github.com/electron/electron/issues/10547)
- Electron 换 ffmpeg：[issue #48097（可热替换）](https://github.com/electron/electron/issues/48097)、[issue #633（换 Chrome 的会坏）](https://github.com/electron/electron/issues/633)、[HEVC/AC3 需自编](https://github.com/0cch0/electron-media-patch)

### 9.3 报告自检记录

- 所有"实测"数字都来自本机命令输出（第 5 节表格与 9.1 的文件可逐项复核）
- 决策规则做过"预测 vs 实测"对账：22/22 一致
- 66 个产物的"可播"判定用的是**画面帧数 > 0 且音频字节 > 0**两个硬指标（不是"看起来成功"）
- 明确列出了 5 条**没能验证**的部分（第 5.5 节），没有拿推断当结论
- **定稿前又重跑了一遍关键证据**（不是复用旧结果）：决策规则对账 22/22 一致、1080p 换容器 0.13 秒、1080p+DTS 只换音频 0.37 秒、NVENC 编码可用、rv40/cook/vc1 解码器存在 —— 全部复现一致
- **自检过程中改正了自己写错的 4 处**（如实记录）：① 引用 66 个产物的原始数据文件曾被后续实验覆盖，已重跑并改用独立文件名；② 初稿把"22 个样本里 5 个只需换容器"错写成"11 个扩展名里只有 5 个需要重编码"，已按扩展名重新表述；③ 初稿写"LGPL 版没有硬件编码器就转不了"，查证后发现 LGPL 构建带 OpenH264 软件兜底，已更正；④ 初稿写"外挂字幕不受影响"，经独立复核发现：**只有把"影片身份"和"播放路径"拆开才成立**，已改正并补进 4.7 节
- **实测推翻过一条直觉假设**：原以为 MP2 音频（DVB/电视录制常见）Chromium 解不了，实测**纯换容器就有声音**（解码出 84096 字节），判定表已按实测修正 —— 这条能省掉一次多余转码
- 另请一位独立"挑刺"角色按"能不能直接开工"的标准审了这份报告，它提出的 8 个必须拍板的问题已全部并入第 8 节（决策清单从 5 条扩到 10 条）
- 未修改任何项目代码；本报告本身是新增文档
