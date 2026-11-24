# BBPlayer 开发者文档

> 本文档面向后续维护者，记录项目架构、关键机制与版本变更明细。
> 面向用户的功能介绍见 [README.md](./README.md)。

---

## 一、项目结构与文件职责

```
BBPlayer/
├── main.js                 # Electron 主进程：多窗口工厂/状态记忆、IPC 信任面、文件对话框、目录扫描、媒体兼容层接线
├── preload.js              # 预加载脚本：contextBridge 暴露 electronAPI（渲染进程唯一系统入口）
├── renderer.js             # 渲染层全部业务逻辑（约 2760 行，单文件策略，每窗口一份独立实例）
├── converter.js            # 媒体兼容层：探测 + 三档转换（换容器/换音频/重编码）+ 缓存 + 并发队列（v1.8.0 新增）
├── updater.js              # 启动时静默检查 GitHub Release，有新版本才弹窗并下载安装包（v1.10.0 新增）
├── index.html              # 界面结构 + 全部内联 CSS（"安静玻璃"低占用视觉 + 彩虹品牌体系 + 音乐播放效果层）
├── shared-video-exts.js    # 媒体扩展名单一事实来源：{ video, convertibleVideo, audio, all, nativeAll }
├── shared-subtitle-exts.js # 字幕扩展名单一事实来源：['srt','vtt','ass','ssa']（v1.6.1 新增）
├── verify-exts.js          # 扩展名一致性对账脚本（shared-video-exts ↔ package.json fileAssociations）
├── verify-converter.js     # 转换层自检：判定规则单测 + 真实样本对账 + 真实转换冒烟（v1.8.0 新增）
├── verify-renderer.js      # 渲染层无界面自检：DOM 桩真实执行 renderer.js 顶层脚本与事件回调（v1.8.0 新增）
├── verify-wiring.js        # 端到端接线对账：打包清单/preload API/IPC 通道/HTML 引用（v1.8.0 新增）
├── vendor/ffmpeg/          # 内置 LGPL 自编精简版 FFmpeg（单文件 ffmpeg.exe 14MB + LICENSE，v1.9.1；不进仓库，打包经 extraResources 落到 resources/ffmpeg）
├── run-test.bat            # 源码方式启动测试（自动检测 Node/Electron 环境）
├── build/                  # 打包图标（彩虹渐变播放三角 ico/png，v1.6.1 重制）+ afterPack.js 打包后钩子（v1.9.1）
├── tools/                  # 开发期工具（diag-cpu-gpu.js 无界面 CPU/GPU 诊断，v1.9.1；不进打包）
└── package.json            # 元数据 + electron-builder 配置
```

**依赖纪律**：运行时零 npm 依赖；仅 `electron` 与 `electron-builder` 两个 devDependencies。
扩展名单一事实来源有两份（v1.6.1 起）：`shared-video-exts.js`（结构化 `video / convertibleVideo / audio / all / nativeAll`）与
`shared-subtitle-exts.js`（`['srt','vtt','ass','ssa']`）。主进程直接 require 两者；
preload（沙箱无法 require 本地模块）与渲染进程经 IPC `app:getVideoExtensions` 获取同一份数据
（返回值含 `subtitle` 字段）。此前字幕白名单在主/渲染进程共 4 处硬编码，已全部收敛。
`package.json` 的 `build.fileAssociations` 为 electron-builder 独立配置，与媒体扩展名的一致性由
`npm run verify`（对账脚本）自动校验。

---

## 二、关键机制说明

### 1. 顶部标题栏与底部功能栏显隐状态机（v1.4.3 全面重做）

标题栏与功能栏均采用"智能热区感应 + 沉浸自适应"双轨机制：

| 元素 | 唤出条件 | 隐藏条件 |
|---|---|---|
| 顶部标题栏 `#titlebar` | 鼠标进入顶部感应区（`TITLEBAR_HOTZONE_HEIGHT`=56px）、或点击视频画面 | 已加载媒体（播放或暂停）：离开顶部感应区且未按住鼠标拖动 → **立即隐藏**；或播放中 3 秒无操作（兜底）；**空状态（无媒体）常驻** |
| 底部功能栏 `#controls-overlay` | 鼠标进入底部感应区（离底边 ≤ `CONTROLS_HOTZONE_HEIGHT`=120px）或悬停其上 | 移开感应区且不在功能栏上 → **立即隐藏**；或播放中 3 秒无操作（兜底） |

核心设计与状态控制函数（renderer.js 尾部）：

- `updateControlsOnMouseMove(e)` — 每次 mousemove 统一裁决；
  - **性能关键**：单次 mousemove 仅执行 1 次 `getBoundingClientRect()`，顶部与底部感应区共用 Rect，杜绝多次 Forced Reflow；
- `isPointerOverControlBar(e)` — 用 `e.target.closest('#controls-overlay')` 判断功能栏悬停（包含其弹出子菜单）；
- `isPointerOverTitleBar(e)` — 用 `e.target.closest('#titlebar')` 判断鼠标悬停或拖拽按住标题栏；
- `isImmersiveMode()` — 判断是否处于沉浸模式（有媒体且播放中），仅决定是否启用 3 秒闲置兜底；
- `hasMediaLoaded()` — 是否已加载媒体（播放或暂停）；移开即隐以此为条件，空状态（无媒体）标题栏常驻，
  保证空窗口始终有最小化/关闭按键可用；
- `clearTitlebarIdleTimer()` — 清闲置兜底计时器（`hideTitleBarNow`/`showTitleBar`/悬停分支共用）；
- **`hideTitleBarNow()` 悬停守卫（v1.6.0）**：收起前用 `titleBar.matches(':hover')` 确认真实非悬停，
  防止 3 秒兜底计时在用户停放标题栏上时误触发隐藏；
- 拖拽安全防护：`e.buttons !== 0`（按住鼠标）时不隐藏，确保拖拽窗口不脱手。

> **v1.6.0 重要变更**：标题栏不再使用 `-webkit-app-region: drag`。OS 级拖拽区在 Windows 下被
> 视为 HTCAPTION，会**吞掉该区域全部鼠标事件**——隐藏后鼠标移进顶部热区收不到 mousemove
> （唤不出），停放标题栏上 3 秒兜底计时无人清零（当面收起）。改为 JS pointer 拖拽（见下节）
> 后事件全程可达，显隐契约行为确定化。

### 2. 窗口拖拽（视频画面 + 标题栏）与单击播放手势

视频画面与标题栏共用同一套拖拽实现 `bindWindowDrag(el, callbacks)`（v1.6.1 起为单一函数，
此前两处约 45 行近重复实现已合并）：

- **统一契约**：左键 `pointerdown` 起手记录屏幕坐标，位移 >4px 确认为拖拽
  （经 IPC `window-move` 让主进程移动，rAF 合帧每帧至多同步一次）；
  `pointerup`/`pointercancel`/窗口 `blur`（Alt-Tab）均兜底清理监听器，防累积；
- **回调注入差异**：`onPointerDown(e)` 返回 false 可否决本次按下（标题栏用它排除
  `.window-controls` 按键区）；`onDragStart()` 拖拽确认瞬间回调；`onPointerUp(dragged)`
  左键释放回调（dragged=是否发生了拖拽）；
- **视频画面**：`onPointerDown` 清掉上一次单击挂起的 250ms 延时计时器；
  `onPointerUp(false)`（纯单击）时延时 250ms 触发播放/暂停——延时用于给双击全屏让路
  （双击会取消该计时器）；
- **标题栏**（v1.6.0 起 JS 拖拽，替代被移除的 `app-region: drag`）：纯拖拽无附加回调；
  双击标题栏空白区 = 最大化/还原（对齐原生标题栏习惯，双击处理已排除窗口按键区）。

### 3. 拖放文件

`dragover`/`drop` 必须调用 `preventDefault()`，否则 Chromium 会用默认行为直接打开被拖入的文件
而不是交给播放器。拖拽高亮用嵌套计数器 `dragDepth` 管理：`dragenter` 加一、`dragleave` 减一、
`drop` 归零，仅在归零时清除高亮——比"坐标归零"判断在多显示器/DPI 缩放下更可靠。
同时拖入「视频 + 字幕」时两者都生效：视频照常入列表，字幕经登记表机制挂到配套视频上（见第 8 节）。

### 4. 字幕引擎

自研 SRT/VTT/ASS 解析（浏览器原生 `<track>` 无法处理 file:// 路径与 ASS 格式）：
解析后按开始时间排序，播放时二分定位 + 向前回扫最多 200 条以兼容重叠时间轴；
`lastRenderedSubText` 缓存避免每帧无效 DOM 写入；SRT/VTT 内联标签
（`<i>` `<font>` 等）由 `stripInlineTags()` 剥离（仅匹配字母开头标签，避免误删正文比较符号）。

**编码嗅探管线**（v1.4.1 新增；当前工作区收敛为单一实现）：唯一实现在主进程
`decodeSubtitleBuffer()`，渲染端拖入字幕经新增 IPC `file:decodeSubtitle`（ArrayBuffer 载荷，
10MB 上限）交主进程解码——曾为两份实现手工同步，已按瘦身审查合并：
UTF-8/UTF-16LE/UTF-16BE BOM 识别 → UTF-8 `fatal:true` 严格解码（非法字节即抛错）→ GBK 回退 → latin1 兜底。
覆盖中文环境最常见的 ANSI(GBK) 老字幕。主进程读取有 10MB 上限（`MAX_SUBTITLE_BYTES`）。

**v1.7.0 修复**：ASS 格式判定原为区分大小写的 `/^\s*Dialogue:/m`，而逐行解析却用
`toLowerCase()` 判断，两者口径不一致 → 小写 `dialogue:` 的字幕文件会被误当 SRT 解析、
最终一条字幕都读不出来；判定已改为大小写不敏感。
另外，字幕文案缓存 `lastRenderedSubText` 原先只在"无字幕可显示"时才清空，换片时未重置 →
新片首句若与上一部末句同文，会被判为"无需重绘"而漏显；现已在换片与清空播放器时一并重置。

### 5. IPC 安全面（v1.4.4 起为多窗口信任面）

所有主进程 IPC 处理器经 `isTrustedSender()` 校验发送方：
- v1.4.4 前：仅接受顶层主窗口 frame；
- **v1.4.4 起**：接受 `playerWindows` 集合内任意播放器窗口的顶层 frame。
  集合在 `createPlayerWindow()` 创建时加入、`closed` 时移除；发送窗口由 `windowOf(event)`
  （`BrowserWindow.fromWebContents(event.sender)`）定位。
- 字幕读取有扩展名白名单 + 10MB 上限；`will-navigate` 与 `window-open` 已封死；
- 新窗口播放入口 `window:openInNewWindow` 校验扩展名白名单 + `fs.existsSync`。

**v1.7.0 加固**：
- `file:findCover` 补扩展名白名单（入参必须是受支持的媒体文件）——此前入参不校验时，
  该接口等价于"传任意图片路径即可读回其 base64"，是一条越权读图通道；同时把
  `existsSync/statSync/readFileSync` 全部改为 `fs.promises`，避免同步磁盘读阻塞主进程；
- `dialog:saveScreenshot` 新增载荷上限 `MAX_SCREENSHOT_BYTES`（64MB），拒绝异常/恶意超大载荷；
- 新增 `MAX_PLAYER_WINDOWS`（16）限制同时在世的播放器窗口数，防止注入后循环开窗耗尽资源；
- 主进程新增 `process.on('uncaughtException'/'unhandledRejection')` 兜底：任何一处 IPC 回调
  意外抛错不再让整个播放器退出，记录后继续运行（本地播放器的取舍）；
- CSP 补 `object-src 'none'` 与 `base-uri 'none'`。

### 6. 持久化键（localStorage）

- `bb_player_history`：播放进度（上限 `HISTORY_MAX`=200 条，写入时裁剪）；
- `bb_player_settings`：音量/倍速/字幕样式偏移/播放模式。

### 7. 内存管理要点

- Blob 播放的 URL 由 `revokeCurrentBlobUrl()` 统一回收；
- 截图走 `ArrayBuffer` 过 IPC（避免 base64 膨胀 33%）;
- 文件夹扫描上限 500 个文件、深度 3 层；触顶时经 `dialog:openFolder` 返回的
  `truncated` 标志由渲染进程提示用户（v1.4.1 起）。

### 8. 视频加载异步化与令牌防护（v1.4.1 新增）

`loadAndPlayVideo()` 为 async 函数：本地路径转 `file://` URL 走主进程
`path-to-url` handle（旧版为 `sendSync` 同步阻塞，已废弃）。两道令牌防竞态：

- **加载序号 `loadSequence`**：函数入口 `++loadSequence` 取号，两个 `await`
  （URL 转换）返回后校验，若期间用户已切换到其他视频则整体作废，防止旧调用交错写入播放器状态；
- **字幕路径令牌**：同名字幕自动加载沿用 `currentFilePath === videoKey` 校验。

**混拖字幕登记表**：视频 URL 转换与字幕文件解码完成顺序不定，
拖入「视频 + 字幕」时把 `{ forVideo, text }` 登记到 `pendingDropSubtitle`，
双方完成后各自调 `tryApplyPendingDropSubtitle()`——谁后到谁触发应用，
事件驱动零轮询。附带效果：用户切走后再点回配套视频，字幕会自动补挂。

### 9. 窗口比例锁的解除机制（v1.4.1 新增）

换片时主进程仍按视频分辨率 `setAspectRatio()` 贴合并锁定窗口比例；
新增 `will-resize` 监听（**仅用户手动拖拽窗口边缘时触发**，程序化 `setSize` 不触发）：
用户一旦手动调整即 `setAspectRatio(0)` 解除锁定，还用户自由变形权。
极端竖屏视频在"最小宽 480px 补偿导致高度超出工作区"时，优先保证不溢出屏幕并放弃锁比例。
下次加载新视频自动重新贴合。

### 10. Web Audio API 200% 音频增益与防破音管线（v1.4.2 新增）

原生 HTML5 `<video>` 的 `volume` 属性被浏览器限制在 `[0, 1]` 范围。为支持 200% 音量（声音翻倍 Audio Gain/Boost），引入了基于 **Web Audio API** 的专业级数字调音管线：

```
[HTML5 <video>]
      │ (MediaElementAudioSourceNode)
      ▼
 [GainNode 增益放大器] ── 0.0 ~ 2.0 (即 0% ~ 200%)
      │ (线性声压放大)
      ▼
[DynamicsCompressorNode 动态压缩器] ── 防破音安全气囊 (Threshold: -3dB, Ratio: 12:1)
      │
      ▼
[AudioContext.destination (系统扬声器)]
```

- **单例守卫**：同一个 `<video>` DOM 在整个生命周期中只能调用一次 `createMediaElementSource()`（重复调用会抛出 `InvalidStateError`）。采用 `initAudioPipeline()` + `audioPipelineReady` 幂等保护，切片换源绝不重建管线；
- **防破音（Anti-Clipping）安全气囊**：串联 `DynamicsCompressorNode`，在音量放大逼近极限（-3dB）时自动柔和压缩波峰，防止高音破音、刺耳失真；
- **自愈与降级**：每次应用音量时检测 `audioCtx.state === 'suspended'` 并自动 `resume()`；若环境不支持 Web Audio API 则无缝降级回原生 `0~100%` 控制；
- **UI 增益警示**：音量超过 100%（进入超额放大区）时，滑块自动变为霓虹橙色（`#volume-range.boost`），提醒用户当前处于高增益状态。

**v1.7.0 变更——管线改为首帧后惰性建立**：`initAudioPipeline()` 涉及 `new AudioContext()` 与
`createMediaElementSource()`，需要初始化音频输出设备与音频线程，属于不可忽略的同步开销。
它不再在 `restoreSettings` 中同步调用（那会把首帧、进而窗口内容一起往后推），改为首帧之后经
`requestIdleCallback`（退回双 `requestAnimationFrame`）惰性建立；建成后立刻重跑
`applyMasterVolume()`，让存档中 >100% 的增益档位立即生效。建管线之前音量只能走原生 0~100%，
因此这段窗口期内会出现"UI 显示 150%、实际 100%"的短暂过渡。
`enterMusicMode()` 另有一次保底初始化，确保频谱所需的 `analyserNode` 必然存在。

### 11. 多窗口架构（v1.4.4 新增）

**目标**：多个视频在各自独立窗口同时播放（类似 PotPlayer/VLC 多开），每个窗口都是完整播放器。

**核心设计**：

1. **窗口工厂 `createPlayerWindow({ isMain, initialFile })`**：主窗口与新窗口弹窗共用同一套
   无边框/沉浸/比例锁/最小化自动暂停逻辑。`isMain` 决定是否记忆窗口状态（仅主窗口持久化
   bounds 到 `window-state.json`）；`initialFile` 让弹窗在 `did-finish-load` 后自动播放指定文件。
   **v1.7.0 起窗口以 `show: true` 创建**（立即显示，不再等 `ready-to-show`；详见第 19 节）。
2. **信任面 `playerWindows: Set`**：所有播放器窗口（含弹窗）加入该集合，`closed` 时移除；
   IPC 处理器一律通过 `windowOf(event)` 定位**发起窗口自身**（最小化/最大化/关闭/全屏/
   对话框/截图/窗口自适应缩放/移动），各窗口互不干扰。
3. **弹窗级联偏移**：新窗口默认在主窗口右下 40px 级联展开，并钳制在所在显示器工作区内，
   防止主窗口靠边/最大化时把弹窗挤出屏幕。
4. **三条打开新窗口的入口**：
   - 播放列表项悬停 **↗** 按钮 → `window:openInNewWindow(path)`；
   - 播放列表头部外链按钮 → 把当前播放视频弹到新窗口；
   - **运行中再次双击视频文件**（`second-instance`）→ 直接新窗口播放（v1.4.4 起，
     旧行为是并入主窗口播放列表）。
5. **窗口关闭语义**：主窗口关闭但弹窗仍在时应用不退出（`window-all-closed` 才 `app.quit()`）；
   主窗口引用置空后，新弹窗级联退化为居中显示。
6. **渲染进程独立性**：每个窗口各自加载一份 `index.html`/`renderer.js`，播放状态、
   字幕引擎、音量增益管线（各自独立 AudioContext）完全隔离；`localStorage` 因同源 file://
   共享，历史与设置跨窗口一致。
7. **限制**：弹窗仅能打开**具备本地绝对路径**的视频（`canOpenInNewWindow` 判定盘符/UNC），
   拖拽且无物理路径的 blob 临时文件无法在另一窗口播放，UI 会给出明确 Toast。

---

### 12. 纯音频音乐播放效果层（v1.5.0 新增）

**目标**：软件同时充当音乐播放器——主流音频格式直接可播，纯音频时窗口呈现音乐播放界面。

**核心设计**：

1. **格式支持零成本**：Electron 官方构建的 Chromium 自带全部六种解码器（mp3/flac/wav/ogg/m4a/aac，
   实测含裸 ADTS `.aac`），运行时零新增依赖；仅需扩展名白名单放行。
2. **纯音频判定**：`loadedmetadata` 后 `videoWidth === 0 && videoHeight === 0`（实测确认的可靠信号），
   据此切换音乐模式：显示效果层、隐藏截图/字幕按钮、跳过同名字幕自动查找。
3. **频谱可视化**：`AnalyserNode`（fftSize 256、smoothing 0.82）串入既有增益管线
   （source → gain → analyser → compressor → destination），只读分流不改音质；32 根圆角渐变柱
   由 `requestAnimationFrame` 驱动，暂停即 cancelAnimationFrame 并清空画布（省电）。
4. **封面与主色环境光**：主进程 `file:findCover` IPC 查找同目录 cover/folder/同名图片；
   封面加载成功后 24×24 canvas 采样主色，55% 压暗生成背景渐变 + `--cover-glow` 光晕
   （Ambient 风格，每首歌背景色不同）；canvas 受限时 try/catch 保留默认深色背景。
5. **令牌防串台**：`musicCoverToken` 令牌 + 闭包捕获，快速切歌时旧封面加载结果一律丢弃。

**v1.7.0 变更**：
- **误判自愈**：极少数容器在 `loadedmetadata` 阶段仍拿不到画面尺寸，会被误判为纯音频，
  界面被音乐效果层盖住（字幕/截图按钮被隐藏）且此后没有纠正机会 →
  新增 `loadeddata` 复检，一旦发现有画面立即 `exitMusicMode()`；
- **频谱采样缓冲复用**：`drawSpectrumFrame` 原先每帧 `new Uint8Array(frequencyBinCount)`，
  改为复用 `spectrumBins`（仅在桶数变化时重建），消除音乐播放期间每秒约 60 次的短命分配。

### 13. 窗口关闭与退出策略（v1.5.0 曾为托盘常驻，现已改为关闭即退出）

**目标**：主窗口点"关闭"直接退出软件；最小化策略按视频/音频分流。

**核心设计**：

1. **关闭即退出**：主窗口 `win.on('close')` 不再拦截（托盘常驻模式已移除，`Tray`/`isQuitting`
   相关代码全部删除）；关闭前取消挂起的防抖保存并强制落盘一次 `window-state.json`。
2. **退出链路**：`window-all-closed` 无条件 `app.quit()`——最后一个窗口关闭（含主窗口点"关闭"）
   即结束进程；系统关机路径无需特殊处理（无拦截）。
3. **最小化-恢复事件转发**：`win.on('minimize'/'restore')` 发送 `window-minimized`/`window-restored`
   消息，渲染进程按 `isMusicMode` 决策：**视频暂停、纯音频继续后台播放**
   （`backgroundThrottling: false` 保证后台不卡顿）。
4. **second-instance 唤起**：运行中再次双击 exe（无文件参数）时 `showMainWindow()` 恢复/前置主窗口。
5. **窗口状态**：仅主窗口持久化窗口状态；落盘使用 `win.getNormalBounds()`（最大化时取恢复后边界）
   + `maximized` 标志，启动时恢复最大化，避免"伪最大化"占满工作区；程序化自动贴合
   （`resize-window-to-video` 的 setSize）经 `programmaticResizeWindows`（WeakSet）标记后不再触发
   状态记忆，避免覆盖用户手调尺寸。

---

### 14. 双主题外观（v1.5.1 新增）

**目标**：浅色 / 深色两套外观一键切换，品牌色共享、中性色反转，文字与控件始终清晰。

**核心设计**：

1. **变量体系**：`:root` 定义深色默认变量集；`:root[data-theme='light']` 整体覆盖为浅色系
   （背景 `--bg-obsidian` / 抬升面 `--surface-raised` / 功能栏毛玻璃 `--dock-glass` /
   文字 `--text-*` / 幽灵按钮悬停 `--ctrl-hover-bg` / 实心强调 `--accent-solid` / 菜单 /
   进度条 / 字幕 / 音乐背景等 30+ 语义变量）。所有颜色必须走变量，禁止硬编码。
2. **强调色三级**：`--accent-neon`（进度条等线性元素渐变端点）、`--accent-text`（强调文字，
   深色亮青 `#00f2fe` / 浅色深青蓝 `#0284c7`，纯青在浅底对比度不足）、
   `--rainbow-gradient`（v1.6.1 起播放键/进度条品牌渐变，由 `--rw-1..7` 色标变量合成；
   v1.6.0 的 `--accent-solid`/`--accent-on-solid` 纯色强调变量已随彩虹化移除）。
3. **切换**：`renderer.js` 的 `applyAppearance(isLight)` 设置 `document.documentElement.dataset.theme`；
   外观按钮 `#btn-appearance`（循环播放键左侧）图标太阳（深色）/ 月亮（浅色）提示目标状态。
4. **持久化**：`bb_player_settings.appearance`（'light' / 'dark'），启动恢复。
5. **音乐模式适配**：`applyCoverGlow` 按主题拼接两套封面环境光衬底（深色压暗 55% 配深蓝，
   浅色提亮 90% 配浅蓝白）；切换主题时若封面光晕在线则重算；无封面时回落到 CSS `--music-bg`。
6. **边界说明**：多窗口并存时外观仅作用于当前窗口 DOM；新开窗口按存档主题初始化
   （如需全窗口实时同步需主进程广播，当前未实现）。

**浅色可读性专项**（审查要点）：字幕白底深字（叠黑视频画面上更醒目）、歌名/副标题阴影换浅、
空状态 SVG Logo 走 `--empty-logo-fill/stroke` 变量（浅色下换深色描边）、进度条圆点 `--handle-bg` 换深蓝。

---

### 15. 标题栏透明化与品牌图标（v1.5.1；v1.6.0 重构拖拽方式）

**标题栏**：`#titlebar` 保持全透明通栏 42px 形态（无底色，仅文字与按键）。v1.6.0 起
文字可读性仅依赖 `--titlebar-shadow`（text-shadow，深黑/浅白两套）；图标 `drop-shadow`
投影已随视觉减法移除（`--titlebar-icon-shadow` 变量删除）。`-webkit-app-region: drag`
已整体移除（吞事件问题见第 1 节），窗口拖拽改由 JS pointer 手势实现（见第 2 节）。
**颜色主题契约**：顶栏文字/按键/悬停全部取自主题变量（`--text-*`/`--win-*`），
与底部功能栏共用同一套 `:root` 深浅色板——切换主题时顶部同步变色；不允许在顶栏写死
主题相关颜色（仅品牌 Logo 渐变与关闭键悬停红 `#e81123` 为固定色）。

**品牌图标**（v1.6.1 彩虹化重制）：`build/icon.png`（512px）与 `build/icon.ico`
（16/24/32/48/64/128/256 七尺寸）为"彩虹渐变播放三角"：横向彩虹（红→橙→黄→绿→青→蓝→紫，
渐变按三角包围盒归一化保证完整色带落在形状内）+ 半透明深蓝描边 + 全透明底。
素材由一次性 Python/Pillow 脚本 4x 超采样抗锯齿绘制（脚本在 `.workbuddy/tmp/gen_rainbow_icon.py`，
未入库；几何参数：512 基准三角 (95,70)/(95,440)/(420,255)，描边 13px）。
图标出口覆盖：应用窗口/任务栏（icon.png → BrowserWindow.icon）、打包 EXE 资源
（icon.ico → electron-builder win.icon）、文件关联（v1.6.1 起 fileAssociations 显式指定
`"icon": "build/icon.ico"`，不再依赖默认值）。Windows 图标有缓存，替换后如资源管理器
未刷新可重启资源管理器或清图标缓存。

---

### 16. "安静玻璃"低占用视觉体系（v1.6.0 重做）

**设计语言**：简洁 + 无边框 + CPU/内存/GPU 占用越低越好。播放器的英雄是画面本身，UI 随时消失；
品牌青从"装饰"降级为"信号"——只出现在进度填充、播放键、正在播放条目三处。

1. **去模糊**：v1.5.2 的 7 处 `backdrop-filter` 全部移除，面板统一用近实底
   `--surface-raised`（深 0.96 / 浅 0.97）——blur 是界面最大的 GPU 开销项。
   **唯一保留**：底部功能栏 `--dock-glass`（深浅各 0.72 透明度 + blur(20px) saturate(160%)），
   为用户指定的视觉效果。
2. **去发光**：进度把手 / 按钮 hover / 主按钮 / 续播条 / 音量增益 / 标题栏图标的
   glow 与 drop-shadow 全部移除；强调语义由颜色承担而非光晕。
3. **圆角 token 化**：`--r-sm(8) / --r-md(12) / --r-lg(16) / --r-full(999)` 四档全局统一。
4. **幽灵按钮**：`.ctrl-btn` 无边框无投影，默认 `--text-secondary` 图标色，悬停浮现
   `--ctrl-hover-bg` 浅底，激活态只染 `--accent-text`；文字按钮（倍速/比例/CC）同体系。
5. **职能分组**：右栏以 `.ctrl-divider`（1px hairline）分为
   [倍速·比例·CC] | [音量] | [外观·模式·截图·旋转] | [全屏·列表] 四组；所有功能保持可见
   （用户否决了溢出菜单方案）。
6. **播放键品牌强调**（v1.6.1 彩虹化）：`#btn-play` 40px 圆角方形（`--r-md`），
   **底色透明**，播放三角/暂停双竖条图标本身呈彩虹渐变（`fill="url(#rainbowPlay)"`），
   hover 仅 scale(1.05) + 幽灵浅底（详见第 18 节）。
7. **窗口控制按键贴角**：44×42 矩形热区经负 margin 延伸到窗口右上角（VS Code/Chrome
   式原生无边框样式），无圆角无边框；关闭键 hover 纯红 `#e81123`。
8. **菜单**：左对齐 + `::before` 指示点标记选中项（所有条目占位保证文字对齐），
   移除底色块高亮。
9. **播放列表**（详见第 17 节）：正在播放 = 左缘 3px 强调条 + 三根跳动小均衡器；
   操作按钮（↗ 新窗口 / ✕ 移除）从文字字符改为 14px SVG，与全局图标体系一致；
   上下缘 22px 渐隐 mask；面板 300→320px；计数改胶囊徽标（`--accent-tint`）。
10. **可访问性**：`button:focus-visible` 焦点环（仅键盘导航显示）；
    `prefers-reduced-motion` 全局动效关停；`transition: all` 六处全部收窄为具体属性。
11. **变量清理**：删除闲置的 `--panel-glass` / `--ctrl-bg` / `--ctrl-border` /
    `--ctrl-hover-border` / `--ctrl-text` / `--ctrl-hover` / `--menu-bg` / `--tooltip-bg` /
    `--accent-glow` / `--titlebar-icon-shadow` 共 10 组。

### 17. 播放列表"正在播放"指示与轻量高亮路径（v1.6.0）

**结构**：每条 `.playlist-item` 固定预置 `.item-index`（等宽两位序号）与
`.eq-indicator`（三根 `i` 柱，`transform: scaleY` 关键帧动画）双份 DOM，
由 `.active` 类经 CSS 切换可见性。

**为什么双份**：`playPlaylistItem()` 存在一条轻量高亮路径——列表 DOM 与数据同步时只
切换新旧条目的 `.active` class、不重建 DOM（避免整列表重排）。若均衡器/序号是二选一
生成的单份 DOM，轻量路径会导致旧条目均衡器残留、新条目只有序号。双份预置 + CSS 切换
让快慢两条渲染路径行为一致。

**暂停联动**：`updatePlayPauseUI(isPlaying)` 同步切换 `.playlist-items.is-paused`，
CSS `animation-play-state: paused` 让均衡器随播放状态起停（暂停时不空转耗电）。

---

### 18. 彩虹品牌体系与进度条裁剪渲染（v1.6.1 新增）

**彩虹色标单一来源**：`:root` 定义 `--rw-1..7` 七个色标变量（红 `#ff3b4e` / 橙 `#ff8a00` /
黄 `#ffd400` / 绿 `#2ecc5b` / 青 `#00c2ff` / 蓝 `#2e6bff` / 紫 `#a24bff`），四处品牌渐变
共用这一组值，改品牌色只需改这里：

- `--rainbow-gradient`（CSS 渐变：进度条填充、封面兜底区等，7 停靠点全用）；
- 三处 SVG 渐变 `#rainbowPlay`（播放键）/ `#logoGlow`（标题栏 Logo）/ `#emptyNeon`
  （空状态 Logo）：stop 经 `.rw-*` 类引用变量（`stop-color` 是可 CSS 化的展示属性），
  5 停靠点取 1/3/4/5/7 号色。

**播放键彩虹图标的关键约束**：`updatePlayPauseUI()` 会整体重写 `#icon-play-state` 的
innerHTML（切换播放/暂停两态图形），渐变 `<defs>` 若放在该 svg 内部会被抹掉——因此 defs
放在 `#btn-play` 内独立的 `.svg-defs` svg（0 尺寸，内联样式覆盖 `.ctrl-btn svg` 的尺寸规则），
跨 svg 以 `url(#rainbowPlay)` 同文档引用。两套图形（三角/双竖条）的 innerHTML 都必须自带
`fill="url(#rainbowPlay)"`（展示属性优先于继承的 `fill: currentColor`）。渐变用
`gradientUnits="userSpaceOnUse" x1=0 → x2=24`，让暂停双竖条的颜色在 24×24 视口上连续过渡。

**进度条彩虹渐变（clip-path 恒定色带）**：若渐变直接设在随播放变宽的 `#progress-fill` 上，
色带会随进度被压缩变形。实现为填充层恒为容器全宽彩虹，由 `--progress` 变量经
`clip-path: inset(0 calc(100% - var(--progress, 0%)) 0 0 round 4px)` 裁剪显示区域；
JS 在三处写 `progressContainer.style.setProperty('--progress', …)`
（timeupdate / loadedmetadata 重置 / handleSeek）。两个联动约束：

- **进度把手必须在填充层外**：把手原是填充层子元素，clip-path 会把它一起裁掉；
  现为容器直接子元素，`left: var(--progress)` 定位；
- 自定义属性会继承，写在 `#progress-container` 上，填充层与把手各自消费。

**窗口控制按键**：图标默认 `--text-primary`（与 BBPLAYER 字样同色，深色主题即纯白，
解决灰图标看不清），悬停底色 `--win-hover` 换为深色高亮块（深色主题 `rgba(30,41,59,0.85)`，
比暗背景亮、比视频画面暗，双向可见；浅色主题深青蓝 0.14）；关闭键悬停红不变。

**正确性修复**：播放列表点击委托原用 `e.target.classList.contains('remove-btn')` 判断，
点在按钮内部 SVG 图形上时 target 是 svg/path（无该 class），会穿透成"播放该条目"——
改用 `closest('.remove-btn')`/`closest('.new-win-btn')` + `itemDiv.contains()` 双重校验。
`failedPlaylistKeys` 在 `removePlaylistItem` 时删除对应 key、`resetPlayerToEmpty` 时
`clear()`，修复"删除失败条目后重新添加同名文件仍被拉黑跳过"的问题。键盘 → 键 seek 的
时长校验统一为 `hasSeekableDuration()`（Infinity 不再误通过）。

---

### 19. 启动路径与首帧预算（v1.7.0 新增）

**目标**：把"从双击到看见窗口"的等待压到最短。用户感知的"打开慢"，主要来自**窗口迟迟不出现**，
而不是播放本身慢。

**关键约束**：`renderer.js` 是 `index.html` 底部同步执行的经典脚本（非 module、无 defer）。
脚本求值期间做的**任何同步工作都会挡在首帧之前**，进而推迟窗口内容的绘制。
因此"启动关键路径"上只允许留必要且廉价的工作。

**三条预算纪律**：

1. **窗口立即显示**（`main.js`）：`BrowserWindow` 以 `show: true` 创建，窗口"壳"在构造瞬间即出现；
   底色 `backgroundColor: '#08090C'` 与页面背景一致，所以不会闪白。
   旧版等 `ready-to-show`（首帧绘制完成）才 `show()`，用户在 Electron 整个启动期间看不到任何东西，
   体感就是"点了没反应、卡很久"。Electron 官方文档对复杂应用正是推荐"立即显示 + 设好 backgroundColor"。
2. **音频管线移出关键路径**（`renderer.js`）：`initAudioPipeline()`（`new AudioContext()` +
   `createMediaElementSource`）需要初始化音频输出设备与音频线程，不再于 `restoreSettings` 中同步调用；
   改为首帧之后经 `requestIdleCallback`（退回双 `requestAnimationFrame`）惰性建立，
   建成后立刻重跑 `applyMasterVolume()` 补齐存档中 >100% 的增益档位。
   `enterMusicMode()` 另有一次保底初始化，确保频谱所需的 `analyserNode` 必然存在。
3. **强制布局延后**：`applyAspectMode()` 会读 `videoContainer.clientWidth/clientHeight`（强制同步布局），
   同样延后到首帧后的 `requestAnimationFrame` 执行。`index.html` 中比例按钮文案与菜单选中态
   本来就是"自动"这一默认状态，因此延后看不出任何差别。

**由此引入的时序陷阱（维护必读）**：`restoreSettings` 在**脚本求值阶段**就同步执行。
凡是被它（直接或间接）调用的函数所引用的顶层 `const`，**都必须声明在它之前**，
否则触发暂时性死区（TDZ）抛 `ReferenceError`——而该异常会被 `restoreSettings` 自身的
`try/catch` 吞掉（仅打一行 console 日志），导致其**后面所有设置恢复静默失效**。
v1.7.0 修复的真实案例就是 `SUN_ICON` / `MOON_ICON`（见版本明细 B 节）。
新增"会被 restoreSettings 间接引用"的常量时，一律放到 `restoreSettings` 之前，或改为函数内惰性取值。

**临时诊断手段（v1.7.0 发布版已移除，可按需重建）**：定位启动耗时分布时，曾在主/渲染两进程
植入 `Date.now()` 墙钟打点，经 IPC `startup-report` 汇总写入 `userData/startup-log.txt`，
记录 Electron 二进制加载、窗口构造、loadFile、did-finish-load、ready-to-show、窗口显示
以及渲染端各阶段耗时。复测时按本节纪律重新植入即可；
`release-dist/measure-with-tracing/` 保留了一份带打点的可运行版本可供对照。

---

### 20. 媒体兼容层：内置 FFmpeg 三档转换（v1.8.0 新增）

**目标**：让内核（Chromium）打不开的老格式也能在同一个 `<video>` 里播——
AVI / FLV / WMV / TS / RMVB / RM / MPG / MPEG / M2TS / VOB / M2V，以及"容器合法但音轨解不出"的
AC3 / EAC3 / DTS（高清片源"有画面没声音"的元凶）。

**论证与全部实测数据见 `docs/FORMAT-EXPANSION-REPORT.md`**（含 22 样本 × 3 档的真机对账、
性能测量、四个方案对比、以及"为什么不能换 mpv/libvlc 内核"的调研出处）。这里只记工程实现要点。

**核心设计**（`converter.js`，主进程侧，刻意不依赖 electron 以便用普通 node 自检）：

1. **三档判定**（`decideTier`）：容器在内核白名单内 + 视频/音频编码在内核白名单内 → `native`（什么都不做）；
   只差容器 → `remux`（`-c copy`，实测 0.1 秒级、无损）；视频 OK 但音频不 OK → `audiofix`
   （`-c:v copy -c:a aac`，同样秒级）；视频编码内核不认 → `transcode`。
   音频白名单**必须按实测来**：MP2 实测内核能解（算"能播"），表外编码一律按"需要换音频"处理（代价极小）。
2. **原生扩展名走快速通道**：`mp4/mkv/mov/webm/m4v/3gp/ogv/f4v` + 全部音频扩展名**不探测、不转换**，
   直接原样播放——不能为了少数老格式让日常格式多付一次 ffmpeg 启动开销（实测 0ms vs 130ms）。
   这些文件里的怪编码（mp4 装 Xvid、MKV 装 DTS、无硬件解码的 HEVC）交给运行时兜底。
3. **运行时兜底**（渲染端，每个文件只兜一次）：加载后仍拿不到画面尺寸且不是音频文件 → 请求重编码；
   画面正常但 `webkitAudioDecodedByteCount` 恒为 0 且文件确有音轨 → 请求只换音频。
4. **播放源与影片身份分离**：`currentFilePath`（标题/历史/续播/同名字幕）始终是**原始文件**；
   转换产物只作为 `<video>` 的 src。否则标题会变成临时文件名、历史会记一堆临时路径、同名字幕会找不到。
5. **产物与缓存**：`%TEMP%/BBPlayer-convert/<原名>.<路径哈希>.<大小>.<时间>.<档位>.<管线版本>.mp4`；
   先写 `.part.mp4` 再原子改名（**必须保留 .mp4 结尾**——ffmpeg 靠扩展名挑封装器，写成 `.mp4.part` 会直接失败）；
   启动时清碎片、超 20GB 按最久未访问淘汰。
6. **并发与取消**：全局队列并发 1；同一窗口换片时按"代号"作废旧任务并杀掉子进程；
   关窗/退出时 `killActive()`，不留孤儿 ffmpeg。进程优先级降到 below normal。
7. **编码器选择**：`h264_nvenc → h264_qsv → h264_amf → libx264（GPL 构建才有）→ libopenh264`（LGPL 构建的软编码兜底）。
   注意三点实测经验：① 硬件编码器"列在表里"不等于能用——本机 ffmpeg master 版要求 NVENC API 13.1、
   驱动只有 13.0，会报 `Driver does not support the required nvenc API version`，**这种错必须被识别成"换下一个编码器"**，
   否则本该退到软编码的转码会直接失败；② **输入文件本身的错误（坏文件/半截下载/没权限）必须直接失败**，
   不能也当成"换编码器重试"，否则一个坏文件会白跑 4 遍；③ OpenH264 只能按码率来，必须随分辨率给值
   （≥1000 像素高 6M / ≥700 4M / 其余 2M），否则 SD 老片会被灌成 4Mbps 的巨文件。
8. **进度上报**：命令里必须带 `-progress pipe:1 -nostats`。**漏掉这个参数时 ffmpeg 一个字都不往 stdout 写，
   进度回调永远不会触发**（界面在长转码期间看不到任何百分比）——`verify-converter.js` 里有一条测试专门盯它。
9. **看门狗与并发闸门**：转码进程 120 秒无任何输出就杀掉（源文件在掉线网络盘/坏道上时 ffmpeg 会不退出也不报错，
   而队列并发是 1，会永久堵死整个转换层）；探测进程限流 2 个并发（渲染端一旦循环调用不会拉起几百个 ffmpeg）；
   所有子进程登记在册，关窗/退出统一杀干净。
10. **缓存的两条语义**（容易搞混，改代码前先看这条）：
    - 普通打开：命中缓存直接用（第二次打开秒开）。
    - **强制档位（`force`）= 运行时兜底**：说明现有产物播不出来，**必须绕过缓存重转一次**，否则命中同一个废产物、兜底等于空转。
    - 反过来，原生扩展名的文件（mkv/mp4 装 AC3/DTS、mp4 装 Xvid）在普通打开时会先查"有没有它的强制档产物"，
      有就直接复用——否则第二次打开又会静音/黑屏，而"每文件一次"的兜底已被挡掉，用户只能重启。
11. **磁盘预检按产物估算**，不是按源文件体积：换容器/换音频 ≈ 源大小+300MB；重编码按 `目标码率×时长×1.5`。
    曾经用"源×1.5"估，结果 20GB 的 VOB 被要求 30GB 空间（实际产物 1~2GB），明明能转却被拒。
12. **安全**：`spawn` 传参数组（不拼 shell 命令）、`windowsHide`、输入路径过扩展名白名单 + 存在性校验、
    输出路径由主进程自己拼、磁盘空间预检、单文件产物体积有上限。

**验证**：`npm run verify` 会跑 `verify-exts.js`（扩展名三层对账：原生 8 + 需转换 11 + 音频 6 = 25）
与 `verify-converter.js`（判定规则单测 + 真实样本对账 + 真实转换冒烟 + 缓存命中）。
设 `BB_SAMPLES` 指向样本目录即可启用"真实样本"部分：

```powershell
$env:BB_SAMPLES = "D:\你的\样本目录"   # 至少包含 20_h264_aac.ts / 13_xvid_mp3.avi / 41_mkv_h264_ac3.mkv
npm run verify
```

**未做（有意）**：换播放内核（mpv/libvlc，代价见报告 3.C）、自编 Chromium 拿 HEVC/AC3 平台解码（报告 3.D）、
边转边播（P3 可选）、多音轨选择、内嵌字幕烧录。

#### 精简版 FFmpeg 构建（v1.9.1）

内置转换器由"LGPL 全量共享版"（`ffmpeg.exe` + 7 个 DLL，153.5MB）换成**自源码编译的
精简静态版**（单文件 14MB，仅依赖 Windows 系统 DLL，LGPL-2.1，省约 140MB）。构建要点：

- **工具链**：MSYS2 + mingw-w64（gcc / nasm / yasm / pkgconf）。**nasm 不能省**——缺它
  FFmpeg 会关闭全部 SIMD 汇编优化，解码性能大幅下降。
- **配置思路**：`--disable-everything` 后按白名单逐项 `--enable-*`，保住项目实际用到的
  全部解码器（含 avi/flv/wmv/rmvb/ts/vob 等老格式）+ LGPL 兼容编码器
  （`libopenh264` 软编 + `h264_nvenc`/`h264_qsv`/`h264_amf` 硬件编码）。
- **必须启用的"非产品但必备"项**（**否则项目自己的测试基建会失效**）：
  - `--enable-avdevice --enable-indev=lavfi`：`verify-converter.js` 与 `tools/diag-cpu-gpu.js`
    都用 `-f lavfi -i testsrc` 造测试样本；lavfi 是**输入设备**（属 libavdevice），不是 demuxer。
  - `--enable-decoder=wrapped_avframe`：lavfi 把帧交给编码器所必需，缺了会报
    `no decoder found for: wrapped_avframe`。
  - `--enable-encoder=mpeg4` + `--enable-libmp3lame` + `--enable-muxer=avi`：
    `verify-converter.js` 用 `-c:v mpeg4 -c:a libmp3lame` 造 `.avi` 测试样本。
  - `--enable-zlib`：png 解码依赖它（关掉 `--disable-autodetect` 会连带关掉 png）。
- **静态化踩坑**：`--pkg-config-flags=--static` + `--extra-ldflags="-static -static-libgcc
  -static-libstdc++"`；**MSYS2 的 libvpl 是 C++ 静态库，gcc 链接必须再给
  `--extra-libs=-lstdc++`**，否则 configure 会误报 `libvpl >= 2.6 not found`
  （实为链接期 `operator new` 等符号未定义）。另：MSYS2 提供的是 `vpl.pc` 而 FFmpeg 找
  `libvpl`，需为 pkg-config 建一个 `libvpl.pc` 副本。
- **产物核对**：`objdump -p ffmpeg.exe | grep "DLL Name"` 应只剩 Windows 系统 DLL；
  用白名单脚本逐项核对解码/编码/封装能力；并真实跑一次"造 .avi → transcode → 产物可解析"
  的端到端转换（`vendor/ffmpeg` 已在 `.gitignore`，替换前务必另存备份）。
- **许可**：LGPL-2.1，`vendor/ffmpeg/LICENSE.txt` 取自源码 `COPYING.LGPLv2.1`。

---

### 21. 启动更新检查与自动安装（v1.10.0 新增）

**目标**：打开软件后自动检查有没有新版本；没有更新就不打扰，有更新才弹窗由用户决定。

**数据来源**：GitHub Releases API（`api.github.com/repos/HaiSeaman/BBPlayer/releases/latest`）。
仓库公开、无需 token；每次启动只请求 1 次（未认证限流 60 次/小时/IP，足够用）。

**为什么不用 electron-updater**：本项目的发布物里没有 `latest.yml`，引入 electron-updater 还要改发布流程、
增加一批运行时依赖，与"运行时零依赖"纪律冲突。`updater.js` 只用 Electron 自带的 `net.fetch`
完成"读 Release → 比版本 → 下载 → 启动安装器"。

**流程**（`main.js` 在 `app.whenReady` 成功后 `setTimeout(..., 3000)` 调用一次，避免和启动期抢资源）：

1. 拉最新 Release 取 `tag_name`，与 `app.getVersion()` 做**数字段比较**（`1.9.10 > 1.9.9`，忽略 `v` 前缀）；
2. 不新于当前版本 → 直接返回，**不弹任何窗**；断网/限流/解析失败同样静默（只写 console）；
3. 有新版本 → 原生对话框「确定更新 / 取消」，取消即结束；
4. 选安装包：便携版（存在 `PORTABLE_EXECUTABLE_FILE`）取 `BBPlayer.<ver>.exe`，安装版取 `Setup` 包；
   找不到对应资源就退回浏览器打开发布页；
5. 流式下载（不整包进内存），任务栏图标显示进度，30 分钟超时兜底，并用 Release 里的 `size` 校验完整性；
6. 收尾：
   - **便携版**必须 `app.relaunch({ execPath })` 再退出——直接 spawn 新 exe 会撞上本进程的单实例锁，
     新实例秒退（症状是"更新完毫无反应"）；新版下载到旧文件旁边，旧 exe 由用户自行删除；
   - **安装版**启动 Setup 后退出。Windows 上 `spawn` 无效 exe 会**同步抛错**，必须 try/catch；
     启动失败要留在软件里报错，不能"退出又没装上"。

**边界与安全**：下载地址只来自固定仓库的 Release；文件名取 `path.basename` 防目录穿越；只接受 HTTPS；
不做数字签名校验（已知风险：仓库账号被盗时可能下发恶意安装包，靠主人保管好 GitHub 账号）。

**测试**：`verify-wiring.js` 用真值表锁住版本比较与安装包选择，并静态盯住三件事——
主进程确实调用了检查、便携版确实用 `relaunch`、下载路径确实取了 `basename`。

---

## 三、版本变更明细

### v1.10.0——窄窗口 UI 自适应 + 启动自动检查更新 + 全量审查修复

> 本节记录 v1.10.0 相对 v1.9.2 的实际改动。**无存储格式变化**，覆盖安装即可，
> 设置 / 播放列表 / 观看历史全部保留。

#### A. 修复：窗口缩小后底部功能栏溢出（用户报告的 UI 错位）

**现象**：把播放窗口拖窄，底部悬浮功能栏里的按钮不跟着收，窄到一定程度后按钮冲出胶囊面板、
被窗口边缘裁掉（UI 错位）。

**根因**：面板宽度跟随窗口（`calc(100% - 48px)`），但内部按钮是固定尺寸、且那一排 `flex` **不允许换行**。
实测整排固有宽度约 787px，因此窗口窄过约 870px 就开始互相挤压；480px 时右侧按钮组比面板宽出 **305px**，
其中 **281px 跑出窗口**被裁。

**修复**（CSS，`index.html`）：

- 按钮 / 时间 / 下拉容器统一 `flex: 0 0 auto` 与 `white-space: nowrap`——空间不够时不再被压扁变形；
- 分组允许 `flex-wrap` 兜底换行；
- `@media (max-width: 920px)`：左右两组改为**上下两排居中**，隐藏装饰性分隔线，音量滑块收窄；
- `@media (max-width: 600px)`：再缩一档（按钮 30px、间距 6px、面板留白减小），保证每组仍是单排；
- 面板变高后，字幕层与续播提示同步上移到 `bottom: 150px`，不被面板遮住；
- 最小窗口下最左侧的倍速菜单加 8px 右移补偿，避免弹层被窗口边缘裁掉 4px。

**验证**：无界面实测 1280 / 1000 / 960 / 921 / 920 / 900 / 861 / 760 / 700 / 620 / 601 / 600 / 561 / 560 / 520 / 480
共 16 档宽度：按钮溢出 **0**、出窗 **0**、面板自身内容溢出 **0**，右侧按钮组始终单排
（栏高 80 → 120 → 98，随断点变化）。

#### B. 新功能：启动自动检查更新

详见第二章第 21 节。要点：无更新静默、有更新弹窗确认、确认后自动下载并启动安装包；
便携版与安装版分别处理；所有失败都不影响播放。

#### C. 全量审查修复的 11 个缺陷

| # | 缺陷 | 根因 / 修法 |
|---|---|---|
| 1 | 转码兜底成功后画面停住，图标还显示"播放中" | 改 `src` + `load()` 会让元素回到暂停态，且**实测不触发 `pause` 事件** → 换源前记住是否在播，换源后恢复 `play()` |
| 2 | 软件已开着时双击另一个视频毫无反应 | 旧逻辑只在"文件已在列表里"时切播 → 双击/选择文件打开一律切播；同时避免空列表"自动播 + 显式播"叠加成两次加载 |
| 3 | 清空播放列表后，空窗口里标题栏也会自动隐藏 | `video.src = ''` 会被 URL 解析成文档地址（实测拿回 `index.html`），旧 `!!video.src` 判空失效 → 改用 `isVideoLoaded` |
| 4 | 右键点进度条也会跳转 | `mousedown` 未判按键 → 只响应左键 |
| 5 | 音乐封面阴影 / 光晕 / 描边全部消失 | `0 26px 70px var(--shadow-cover)` 里变量本身是完整阴影值，拼接后整条声明非法 → 改为 `var(--shadow-cover), …` |
| 6 | 第二个实例可能"闪一下黑窗"并重复跑清理与更新检查 | `app.whenReady` 写在单实例锁分支外 → 未抢到锁直接 return |
| 7 | 便携版点"确定更新"后毫无反应 | 新 exe 先启动会撞上旧进程的单实例锁 → 改用 `app.relaunch` |
| 8 | 更新下载遇连接半开时永远卡住 | `net.fetch` 无超时 → 30 分钟兜底（约 57KB/s 也能下完 100MB） |
| 9 | 更新包路径 / 完整性可被发布信息利用 | 直接用网络来的文件名拼路径、只比 content-length → `path.basename` + Release `size` 校验 |
| 10 | 截图默认名可能带 `:` 等 Windows 非法字符 | 只替换了斜杠 → 统一替换非法字符、去掉结尾点/空格、挡掉 `.` 与 `..` |
| 11 | 转码缓存可能删掉正在播的产物（拖进度失败） | 只按"最后 prepare 时间"淘汰 → 最近 10 分钟用过的产物不淘汰 |

#### D. 死代码与重复代码清理

- `index.html`：删除永不命中的 `.menu-item:focus-visible` / `.resume-btn:focus-visible`（div/span 没有 tabindex，
  实测 `tabIndex === -1`）；删掉与 `gap` 重复的 `row-gap`；删掉与 `show: true` 重复的 `ready-to-show → win.show()`；
- `main.js`：封面查找里重复的 `stat.size > 0`；主窗口关闭处与真实行为不符的注释；
- `converter.js` / `updater.js`：移除无外部消费者的导出（`availableEncoders`、`fetchLatestRelease`、`downloadFile`）；
- `renderer.js`：把两个逐字相同的"打开文件夹"按钮处理器合并为一个循环；
- 文档：`docs/DEVELOPER.md` 的扩展名键列表更正为 `video / convertibleVideo / audio / all / nativeAll`。

#### E. 测试基建修复（重要：此前会"假通过"）

- `verify-renderer.js` 有两个用例把 **async 函数**传给**同步 `ok()`**，断言失败只会变成未处理的 Promise 拒绝，
  测试仍然打印"通过"。已改为 `await okAsync`；
- 监听器泄漏断言由 `leaked <= 0` 改为 `strictEqual(leaked, 0)`（少挂监听器也属于回归）；
- 测试桩里的扩展名清单改为直接 `require` 共享模块，避免"源码改了测试还绿"；
- `verify-exts.js` 补上 `nativeAll === video + audio` 对账（converter 快速通道完全依赖它）；
- 新增 3 条回归锁：兜底换源后保持播放/暂停状态、清空后不视为已加载媒体、双击打开只加载一次；
- renderer 自检 **45 → 48 项**，`npm run verify` 全绿。

#### F. 验证

- `npm run verify`：扩展名对账、converter 35 项、renderer 48 项、接线对账（9 个打包文件 / 24 个 API / 18 发 5 收 IPC）全部通过；
- 无界面实测：16 档窗口宽度下的功能栏布局；封面阴影计算样式恢复为三层合法值；
  便携版更新链路（下载到同目录 → `relaunch` 指向新包 → 请求退出、无报错）；
- 关键结论均有实测支撑：`video.src=''` 会解析成文档地址、改 `src` 不触发 `pause` 事件、
  Windows 上 `spawn` 无效 exe 会同步抛错——三条都是先用无界面脚本跑出来的，再据此修复。

#### G. 有意未改（评估后放弃，附理由）

- 全局吞 `uncaughtException`：这是项目刻意的"播放器不许崩"策略，改成退出反而更糟；
- 滚轮调音量每次落盘、resize / 进度条 mousemove 未做 rAF 合帧：微优化，收益小、改动面大；
- `loadWindowState` 里两次 `getDisplayMatching`：去重只省一次启动调用，但那段是"窗口不能宽出屏幕"的
  关键不变量，还有测试盯着具体写法，不动更安全；
- 打开文件夹"读取失败"与"空文件夹"提示相同：要改 IPC 返回结构，收益低；
- 音频管线建链失败后可能永久无声的极端路径：概率极低，改它要动整条音频链路。

### v1.9.2——右侧黑边修复 + 续播提示 10 秒自动消失

> 本节记录 v1.9.2 相对 v1.9.1 的实际改动。两处均为 UI 行为修复，无数据格式/存储变化，
> 升级覆盖安装即可，设置/播放列表/观看历史全部保留。

#### A. 修复：窗口右边框的黑色阴影（播放列表抽屉投影渗漏）

**现象**：播放任意视频时，窗口右边框内侧始终有一条黑色渐隐竖条；左侧、上侧、下侧都没有。

**根因**：`index.html` 的 `#playlist-panel` 用 `right: -320px` 把整个抽屉平移到
窗口外隐藏，但 `box-shadow: var(--shadow-drawer)` 不受"元素是否在屏幕内"影响。
深色主题的投影是 `-10px 0 30px rgba(0, 0, 0, 0.6)`——向左偏 10px、模糊 30px，
会向窗口内渗出约 40px；`#player-container` 的 `overflow: hidden` 裁掉窗口外部分后，
正好剩一条贴着右边框的黑色渐隐竖条。抽屉从 `top: 42px` 开始，因此标题栏以下更明显，
观感就是"只有右边框有阴影"。与视频本身无关，所以换任何片子都一样。

**修复**：投影只属于打开状态——基础态改为同几何的全透明投影，
`#playlist-panel.open` 恢复 `var(--shadow-drawer)`；`transition` 增加
`box-shadow 0.25s ease`，开关抽屉时投影淡入淡出，不会瞬间跳变。

**验证**：用无界面离屏渲染加载真实 `index.html`，白色画面模拟视频，采样右边缘各列
平均亮度（0=黑 / 255=白）：

- 修复前：740→253、750→245、760→225、770→192、780→154（越靠右越黑）；
- 修复后：700~782 全部 255（黑边消失）；
- 抽屉打开时投影正常恢复。

#### B. 修复：续播提示（左下角"跳转续播"）永不消失

**现象**：重新打开有观看记录的视频后，左下角弹出"跳转续播"提示条，不点它就永远留在
画面上，不会自动消失。

**根因**：`checkHistoryResume()` 只负责把 `#resume-toast` 设为 `display:flex`，
没有任何隐藏路径（只有用户点"续播/✕"或换片才会消失）。

**修复**：`renderer.js` 新增 `showResumeToast()` / `hideResumeToast()` 统一管理显示与
计时（常量 `RESUME_TOAST_AUTO_HIDE_MS = 10000`）：

- 显示后 **10 秒无操作自动隐藏**；
- `mouseenter` 暂停倒计时、`mouseleave` 重新计 10 秒（鼠标停在提示上时不会消失）；
- 点击"续播"/"✕"、换片、清空播放器一律走 `hideResumeToast()` 并清除计时器，
  避免旧计时器误关新提示。

#### C. 工程质量

- `verify-renderer.js`：**44 → 45 项**。新增"续播提示 10 秒无操作自动隐藏，悬停暂停
  倒计时"行为锁：显示为 flex + 存在 10s 计时器 → 悬停暂停 → 移开重启 → 到期隐藏 →
  手动隐藏清计时器。
- `npm run verify` 全绿：converter 35 项 + renderer 45 项 + 扩展名/接线对账。
- 无新增运行时依赖；无存储键变化。

#### D. 有意未改

- 抽屉投影本身保留（打开状态需要它与画面分隔）；本版只在关闭态把投影置零，
  打开时的观感完全不变。

### v1.9.1——体积瘦身 213MB + 播放期 GPU 开销收敛 + 全量审查修复

> 本节记录 v1.9.1 相对 v1.9.0 的实际改动。本版有三大块：**安装体积瘦身**（-213MB）、
> **播放期 GPU 开销收敛**，以及**一轮全量代码审查**驱动的 7 项正确性修复与死代码清理。
> 无界面验证方式见 D 节。

#### A. 体积瘦身：装完占用 521MB → 308MB（−213MB / −41%）

三块独立收益，均已用 `--dir` 真实打包逐项核对：

1. **语言包 55 → 2（−47MB）**：Electron 自带 55 个 `.pak` 语言文件，本项目只需
   中文与英文。`package.json` 新增 `electronLanguages: ["zh-CN", "en-US"]`。
   electron-builder 26.x 对此有保护：若名单匹配不到任何语言，会**跳过清理并告警**
   （不会打包出空 `locales/` 导致启动即崩——见 electron#52307 / electron-builder#10007）。
   打包后断言 `locales/` 恰为 2 个文件。
2. **删除 WebGPU 着色器编译器（−26MB）**：`dxcompiler.dll` + `dxil.dll` 仅 WebGPU
   用来编译 GPU 着色器，本项目只用 `<video>` 播放，完全不需要（Electron 官方 28.0.0
   的 PR #41120 也曾主动移除）。新增 `build/afterPack.js` 钩子，在 Windows 打包后删除
   这两个文件；文件不存在则静默跳过，删除失败也不阻断打包。`build/afterPack.js` 自身
   通过 `files` 的 `!build/afterPack.js` 排除，不进安装包。
3. **内置 FFmpeg 换精简自编版（153.5MB → 13.4MB，−140MB）**：原为 LGPL 全量共享版
   （`ffmpeg.exe` + 7 个 DLL，含大量用不到的组件——单 `avfilter` 就 30MB，而项目零滤镜
   用法）。改为**自源码编译的精简静态版**：单个 `ffmpeg.exe` 14MB，仅依赖 Windows 系统
   DLL，LGPL-2.1。构建要点与踩坑见第 20 节末尾"精简版构建"。

#### B. 播放期 GPU 开销收敛（控制栏毛玻璃）

**问题**：底部功能栏 `#controls-overlay` 的 `backdrop-filter: blur(20px)` 在背后画面
变化时**每帧都要重算**。而控制栏默认可见（`opacity:1`），只有"鼠标进底部热区再移开"
才收起——用户点开视频后鼠标不动时，控制栏整场亮着，毛玻璃就整场每帧重算，是播放期
GPU 的主要开销（依据见 `docs/PERF-REVIEW-1.7.0.md` 第六节实测结论）。

**修复（两处配合）**：

1. `renderer.js` 新增 `hideControlsIfUnused()`：`video` 的 `play` 事件里调用——
   播放一开始，若指针**不在**底部感应区、且未悬停功能栏本体，就自动收起控制栏。
   指针位置由 `lastPointerClientY`（`mousemove` 时记录）判断，不用易变的 `devicePixelRatio`。
   鼠标一移到位，既有的 `updateControlsOnMouseMove` 照常把它唤出。
2. `index.html` 的 `#controls-overlay.hide` 新增 `backdrop-filter: none`：**收起时彻底
   关掉毛玻璃**。不可见时的模糊纯属白算——更关键的是设备像素比（dpr）变化会重建
   `backdrop-filter` 的模糊缓存，若隐藏时仍挂着模糊，"控制栏一直藏着"的场景（如纯音频
   播放）会因 dpr 抖动反复重建、每帧白烧一次 GPU。

**视觉零变化**：控制栏可见时的外观完全不变（毛玻璃只在它收起后关闭）。

#### C. 全量审查修复的 7 个缺陷

由只读子代理审查 + 逐条独立实测确认（**其中 2 条经实测证伪，未改**，见 D 节）：

1. **历史视图 ↔ 列表视图切换后条目串台（中）**：`renderer.js` 的 `renderPlaylist()` 增量
   分支只认 `.playlist-item` 这个 class，而历史视图的条目**共用同一个 class**却不设
   `dataset.index`——从历史视图切回列表视图时，会把残余的历史条目误当成"已有列表项"而只做
   增量追加，导致列表前几行仍是历史条目（无序号/均衡器，点击还会跳回历史视图）。
   修复：增量分支追加 `firstChild.dataset.index !== undefined` 校验。
2. **无边框窗口"关不掉"（中高）**：`main.js` 的 `loadWindowState()` 中，尺寸钳制曾挂在
   "x/y 存在"的前置条件上；而上面的可见性校验会把屏幕外的 x/y `delete` 掉——于是最需要
   钳制的场景（存档来自已拔掉的显示器）**反而跳过尺寸钳制**，窗口宽出一大截，
   `frame:false` 的右上角自绘按钮整体落在屏外。实测复现：4K 副屏存档（x=2560,w=3000）
   换到 1080p 工作区（1920 宽），窗口仍返回 3000 宽。修复：尺寸钳制**无条件执行**，
   位置信息在时按其显示器钳、已被删时退回主显示器钳。
3. **点过按钮后快捷键全失效（中）**：`renderer.js` 的 `keydown` 首行曾对
   `input, button, textarea, select` 一律 `return`。按钮被点击后会保持焦点，于是
   "点播放 → 按方向键快进"完全失效（方向键/F11/S/M 全被吞）。真实 Chromium 实测确认：
   按钮聚焦时 `e.target` 为 `BUTTON`、命中拦截。修复：文本输入类控件全放行，**按钮仅在
   Space/Enter 上让行**（保留"防与按钮自身 click 双重触发"的原意）。
4. **程序化挪窗覆盖用户位置偏好（中低）**：`resize-window-to-video` 贴合时若窗口贴边会
   `setPosition` 把它挪回屏内，而 `move` 监听此前**无条件**写入窗口状态记忆（`resize`
   有 `programmaticResizeWindows` 保护，`move` 没有）。修复：新增
   `programmaticMoveTargets`（WeakMap），登记程序化挪窗目标坐标，`move` 到达时按坐标
   核对、一致则跳过并消费登记（只消费一次）。
5. **缓存清理误删正在写入的产物（低）**：`converter.js` 的 `cleanup()` 在转换成功后以
   fire-and-forget 方式发起（不 `await`），它在 `await readdir/stat` 让出期间，队列里
   下一个任务可能已开始写自己的 `.part.mp4`——残留碎片清理会把这个"正在写的半成品"删掉，
   正在跑的 ffmpeg 就写向已删除路径而失败。修复：新增 `activeParts` 集合登记在写的
   `.part`，`cleanup` 扫描时跳过；每个 `.part` 的写入 try/finally 中登记与注销。
6. **多文件开窗绕过窗口上限（低）**：`MAX_PLAYER_WINDOWS` 此前只在
   `window:openInNewWindow` 检查；`second-instance` 与冷启动的多文件开窗循环未检查——
   一次"打开方式"选大量文件即可绕开上限。修复：两处循环同样判上限。
7. **分辨率参数缺上界（低）**：`resize-window-to-video` 只校验
   `number/isFinite/>0`，无上界；极端宽高比会算出无效尺寸。修复：加 `> 16384` 拒绝
   （正常路径只发真实分辨率，最大 8K≈7680）。

此外还修正了 `converter.js` 中两处**与实测矛盾的误导性注释**：曾写"Windows 上 kill 不带
signal"，实测为 `code=null, signal=SIGTERM`（**带** signal）。该错注释正是审查者误报
"转换被 kill 后会被当成编码器失败重试"的根源，已按实测更正——若真照错注释删掉
`if (signal)` 判断，主动取消将无法识别。（属注释修正，不计入上面的 7 个缺陷。）

#### D. 验证：实测证伪了两条候选，未做无谓改动

审查共报出候选若干，**逐条实测**后只修确认为真的：

- ❌ **"磁盘预检 `estimateOutputBytes` 无上限、长视频会被误拒"——实测证伪**：
  调真实模块算 SD（480p）10 小时仅约 **12.87GB**，低于 `maxOutputBytes`（16GB）上限，
  不会被拒。**未改**。
- ❌ **"`shared-video-exts.js` 的 `nativeAll` 字段无人使用、是死代码"——核实为误报**：
  它被 `converter.js` 的 `NATIVE_EXTS` 真实使用，删了会坏。**未改**。
- 另：重复实现（`basename` 手写 6 处、扩展名提取 3 套写法、删除按钮 SVG、hms→秒换算
  两遍）确存在，但属**惯用写法**，按"禁止随意重构、简单能用就不要复杂化"**不改**。

#### E. 死代码与失真物清理

- `index.html`：删除无消费者的 `.rw-2` / `.rw-6` CSS 规则（三处 SVG 渐变只用
  1/3/4/5/7；**变量保留**，`--rainbow-gradient` 仍用）；删除死 class `class="music-title"`
  （样式走 `#music-title` id，仍保留）。
- `renderer.js`：删除 `bindWindowDrag` 的死参数 `onDragStart`（两个调用点均未传）。
- `converter.js`：移除无消费者的 4 个导出（`NATIVE_CONTAINERS` / `OK_VIDEO` / `OK_AUDIO` /
  `PIPELINE_VERSION`——内部仍在使用，只是不再对外暴露）。
- `preload.js`：修正失真注释（曾写返回 `{video, audio, all}`，实际为
  `{...VIDEO_EXTS, subtitle}`，即含 `convertibleVideo` / `nativeAll` / `subtitle`）。
- `.gitignore`：新增 `.qwen/`（此前某 AI 工具残留目录未被忽略）。

#### F. 新增：无界面 CPU/GPU 诊断工具

`tools/diag-cpu-gpu.js`：**隐藏窗口**运行（`show:false`，用户看不到界面），用
`app.getAppMetrics()` 按进程度量 CPU/私有内存，用 `app.getGPUInfo()` 读设备与图形栈，
再解码一段测试视频统计推进与丢帧——结论全部走命令行输出。支持
`<视频> --seconds=N --blur --visible`。

**如实记录的局限**：隐藏窗口下 Chromium 往往**不初始化图形栈**
（实测 `auxAttributes.glImplementationParts=(gl=none,angle=none)`、`skiaBackendType=None`），
故"硬解还是软解"在隐藏模式下**测不准**——脚本会明确输出"本次无法判定"，并提示改
`--visible`（会短暂显示窗口）重测。本工具是开发期诊断用，**不进打包**（`files` 白名单不含 `tools/`）。

#### G. 测试基建扩充

- `verify-renderer.js`：**37 → 44 项**。新增控制栏自动收起 5 项（远离底部收起 / 指针在
  感应区不收 / 悬停功能栏不收 / play 事件接线正确 / `showControls` 能重新唤出）、
  历史↔列表视图切换不串台 2 项。
- `verify-wiring.js`：新增第 8 组 **8 条静态契约**，逐条钉住本版修复（尺寸钳制无条件 /
  keydown 不对 button 一刀切 / `programmaticMoveTargets` 存在且 `move` 不可无条件保存 /
  `MAX_PLAYER_WINDOWS` 至少 5 处引用 / 4 个多余导出已移除且 `NATIVE_EXTS` 保留）。

#### H. 遗留事项（评估后未改，附理由）

- 同 v1.9.0 E 节：多窗口 localStorage 互相覆盖、外部播放器兜底按钮、边转边播/多音轨/
  内嵌字幕烧录，均维持"未做（有意）"。
- 删 DLL 化（dxcompiler/dxil）与语言包裁剪均为打包期移除，**未修改** Electron 发行包本体；
  若将来 Electron 版本行为变化导致这两个文件变为必需，`afterPack.js` 需复核（届时视频
  播放会先暴露异常）。
- `.qwen/` 残留文件本身未删（涉及 git 操作，待用户决定）。

### v1.9.0——Electron 34→44 升级 + 审计确认 bug 修复 + 运行时开销收敛

> 本节记录 v1.9.0 相对 v1.8.0 的实际改动。审计依据见 `electron-perf-research.md`
> 与 `docs/PERF-REVIEW-1.7.0.md`（含实测数据）；这里只记"改了什么、为什么"。

#### A. 依赖升级

1. **Electron 34.5.8 → 44.7.0**（最新稳定版）：吃到官方三个启动优化 PR
   （主进程 Node 启动快照 −25% spawn→ready、js2c 构建期代码缓存、preload 字节码缓存
   + mojo 预推），Electron 34 已 EOL。静态核对 34→44 全部破坏性变更
   （clipboard 渲染端移除 / macOS 12 下线 / ANGLE 静态链接 / net.request 帧校验 /
   32 位构建移除）与本项目 API 面零冲突——项目不用 clipboard、不发网络请求、只发 x64。
2. **electron-builder 25.1.8 → 26.17.0**：清掉 `npm audit` 报的 1 critical + 16 high
   （全部在打包工具链的 tar/xmldom/glob 依赖里，不进软件本体），同时确保对新
   Electron 44 的打包兼容。剩余 8 个低危均为工具链传递依赖。

#### B. 正确性修复（每条都有新增测试盯住，测试先 RED 后 GREEN）

1. **拖入字幕解码期间换片：旧字幕挂上新视频（竞态）**：
   `loadDraggedSubtitle()` 纯拖字幕分支在两次 await 后直接应用到"当前"画面，
   未核对发起时的视频路径——解码期间用户切片，旧字幕串到新视频上，且
   `manualSubtitleFor` 被污染，新片的同名自动字幕被永久压制。姐妹函数
   `loadSubtitleFromPath` 有 `expectedVideoPath` 校验，唯独拖拽路径漏了。
   修复：入口记 `startVideoPath`，应用前不一致即丢弃。
2. **`scheduleAudioCheck` 少查 `loadSequence`（竞态）**：只比 `currentFilePath` 不足以
   识别"同路径重新加载"（失败自动跳回 / 清空重开），3 秒后的探测会落在新的加载序列上。
   修复：安排定时器时记 `scheduledSeq`，回调开头先比对（对齐兄弟函数
   `scheduleNoPictureCheck` 的既有纪律）。
3. **`loadAndPlayVideo` 历史续播监听器泄漏**：`hasRealPath` 分支每次加载注册一对
   `loadedmetadata`/`error` 临时监听器，靠这两个事件触发清理；但"旧加载被新加载打断"
   时换 `src` 只触发 `emptied`/`abort`，旧对永远等不到自己的事件——快速连切 20 次
   实测泄漏 40 个监听器，之后每次 `loadedmetadata` 都空跑一批作废回调。
   修复：单例注册（新加载先卸旧对，任何时刻至多 1 对在挂）；红绿回滚验证 +
   续播功能行为锁（有历史的视频 loadedmetadata 仍弹续播提示）双确认。

#### C. 运行时开销收敛（审计确认的热路径，逻辑零变化）

1. **mousemove 热路径 rAF 合帧**：`updateControlsOnMouseMove` 内有
   `getBoundingClientRect()` 强制同步布局，高回报率鼠标（1000Hz）下每秒可达千次。
   改为 rAF 合帧（一帧只处理最后一次事件，与 `bindWindowDrag` 同一思路）。
2. **截图位图立即释放**：4K 一张约 33MB 的 canvas 位图，`toBlob` 后立即
   `canvas.width = canvas.height = 0`，不等 GC——连续截图峰值从 N×33MB 压回单张量级。
3. **频谱渐变缓存（尝试后撤销）**：曾把逐帧 `createLinearGradient`×32 改为固定坐标
   (0,0)-(0,H) 缓存，代码审查发现矮柱（3px 基座）落在固定渐变最暗端几乎不可见
   （视觉回归），已回退为原版逐帧创建并在代码注释记录结论——GC 代价审计定级
   "可忽略"，视觉保真优先。

#### D. 验证（全部无界面）

37 项 renderer 自检 + exts/converter/wiring 四件套全绿；打包产物逐项核对。

#### E. 遗留事项（评估后未改，附理由）

- **多窗口 localStorage 互相覆盖**：各窗口各持一份 history/settings，后写覆盖先写；根治要改为
  主进程集中持久化，属架构级改动，本版未动（同 v1.8.0 G 节）；
- **外部播放器兜底（方案 A）**：仍只做到"明确提示失败原因"（Toast 显示具体原因），
  未提供"用系统里其它播放器打开"的按钮——属新功能，不在本版夹带（同 v1.8.0 G 节）；
- **边转边播（P3）、多音轨选择、内嵌字幕烧录**：维持"未做（有意）"；
- **频谱渐变缓存优化**：本版尝试过后因视觉回归**主动回退**（见 C 节第 3 条），不再列为待办。

### v1.8.0——媒体兼容层（内置 FFmpeg 三档转换）+ 全量审查修复与无界面测试基建

> 本节记录 v1.8.0 相对 v1.7.0 的实际改动。转换层的设计与实测数据见第 20 节与
> `docs/FORMAT-EXPANSION-REPORT.md`；这里只记"改了什么、为什么"。

#### A. 新功能

1. **媒体兼容层**（新模块 `converter.js` + `main.js` 接线 + `renderer.js` 反馈/兜底）：
   avi/flv/wmv/ts/rmvb 等内核打不开的格式，按"能播不动 / 只换容器 / 只换音频 / 重编码"
   四档处理；带缓存、全局并发 1 的队列、按窗口作废、看门狗、编码器逐个回退。详见第 20 节。
2. **扩展名三层化**：`shared-video-exts.js` 拆为 `video` / `convertibleVideo` / `audio` / `all` / `nativeAll`，
   文件关联同步加回 11 个"需转换"扩展名（总计 25）。字幕扩展名抽出 `shared-subtitle-exts.js`
   收敛原先 4 处硬编码。

#### B. 正确性修复（本轮全量审查，每条都有测试盯住）

1. **换片时旧转换任务作废失效（严重，实测堵住新片 37.8 秒）**：
   `prepare()` 里"记下当前代号"的 `const myGen = generationOf(key)` 原本写在**探测之后**，
   而探测是最慢的一步（起一个 ffmpeg 解析头部，可能要几秒）。于是这条时间线会出事：
   打开长片（开始探测）→ 用户 80ms 后换片（`invalidate` 让代号 +1）→ 长片探测完**才**读代号，
   读到的已经是**作废后的新代号**，于是长片误以为自己有效，把整个长片完整转码排进队列，
   把用户真正在等的新片堵在后面（队列并发是 1）。
   **实测数据：修复前新片等 37791ms，修复后 436ms（快约 87 倍），且旧任务被正确作废。**
   修复与纪律：**代号必须在 `prepare()` 一进来、任何 `await` 之前记录**，
   并在每个耗时 await（`stat` / `isAvailable` / `probeFile`）之后补校验点。
   这条已固化为 `verify-converter.js` 第二层 A 的"换片作废"用例（自带样本，
   默认就会跑，不依赖 `BB_SAMPLES`）。
2. **菜单里手动选字幕被静默拒绝（严重）**：`loadSubtitleFromPath()` 内原有
   `if (manualSubtitleFor === expectedVideoPath) return false` 这道"手动优先"保护，
   本意是**只拦同名字幕的自动加载**，但菜单里"加载字幕文件…"走的也是同一个函数、
   传的 `expectedVideoPath` 正是当前视频——于是用户一旦给这个视频配过字幕（拖入过），
   再想换一个字幕就会被判为"加载字幕文件失败"，且此后**再也换不了字幕**（永久卡死）。
   修复：把"手动优先"判断上移到 `checkAndAutoLoadSubtitles()`（自动加载专属），
   菜单加载成功后反向登记 `manualSubtitleFor`，手动优先契约保持不变。
3. **产物体积上限缺失**：第 20 节与开发报告都声称"单文件产物体积有上限"，代码里其实没有——
   磁盘预检只是"按目标码率×时长估算"，估算偏小或素材异常时仍可能把磁盘写满。
   修复：新增 `maxOutputBytes`（16GB）闸门，判定依据用 ffmpeg 自报的 `total_size`
   （`-progress` 输出本就有，零额外 IO）。**为什么不用 ffmpeg 的 `-fs`**：实测它触顶时
   以异常码退出、产物根本不落地，等于把已经转了一半的工作白扔；这里改为实时监控、
   超限主动中止，并抛出带 `isOutputTooLarge` 标记的明确错误（不再被当成编码器故障重试）。
4. **子进程收尾非幂等**（进程泄漏）：`runFfmpegOnce` 的 `finish()` 没有幂等保护，
   而实测 `spawn` 失败时 `'error'` 与 `'close'` **都会**触发 → `finish()` 跑两次，
   第二次会把 `activeChild`/`activeKey` 无条件置空。若此时队列已换到下一个任务，
   就会把"正在跑的进程"的登记抹掉，导致 `invalidate()` 再也杀不掉它（孤儿 ffmpeg 吃 CPU）。
   修复：加 `finished` 幂等闸 + `if (activeChild === child)` 只清理属于自己的登记。
5. **转码进程未降优先级**：第 20 节与开发报告都写了"进程优先级降到 below normal"，
   代码里没有。修复：`lowerPriority()` 对子进程调 `os.setPriority(PRIORITY_BELOW_NORMAL)`，
   失败一律忽略（权限不足时只影响流畅度，绝不让转换失败）。
6. **进度文案与文档不符**：README 承诺显示"正在换容器… 45%"，而 `converter` 从不回传真实档位、
   界面只有笼统的"正在转换格式"，用户无法区分"秒级换壳"与"要等几分钟的重编码"。
   修复：`prepare()` 探测出档位后立刻回报一次（`stage:'decided'`），
   渲染端用 `CONVERT_TIER_LABEL` 单一映射表翻译成"正在换容器/转换音频/重新编码"。
7. **主进程同步磁盘读回流**：v1.7.0 明文纪律"把 `existsSync/statSync/readFileSync` 全部改为
   `fs.promises`，避免同步磁盘读阻塞主进程"，而本次新增的 `media:prepare` / `media:probe` /
   `window:openInNewWindow` / `path-to-url` 又用了同步 `fs.existsSync`。
   修复：抽出共用的异步校验 `resolveMediaPath()`，四处统一走它（多窗口并存时同步读等于卡住所有窗口）。
8. **看门狗超时被误报成"用户取消"，真实原因被静默吞掉**：
   看门狗 120 秒无输出就 `kill`，而 close 回调里 `if (signal) return reject(makeCancelledError())`
   会先命中——**实测 Windows 上 kill 后回调正是 `code=null, signal=SIGTERM`**，与"用户换片主动取消"
   在事件层面完全一样。于是"源文件所在磁盘/网络位置断开、有坏道"这类真实原因被伪装成"用户取消"，
   再被 `main.js` 静默处理，用户只看到"无法解析媒体源"，误以为文件坏了。
   修复：看门狗触发前先置 `timedOut` 标志，close 回调里**优先于 signal** 判断它，
   抛出带 `isTimeout` 标记的明确错误（"转换超时：源文件 120 秒无任何响应，可能所在的磁盘/网络位置
   已断开或存在坏道"），并在转码重试循环里直接失败（换编码器只会再等 120 秒）。
9. **窗口尺寸未钳进工作区 → 换小屏后无边框窗口关不掉**：
   `loadWindowState()` 原本只校验"可见区 ≥50×50"，**不钳制宽高**。
   实测复算：在 4K 屏存下 3000×1600，之后用 1920×1080 屏启动 → 可见区 1820 通过了校验，
   x/y 保留，但窗口比屏幕宽 1180px。本软件是 `frame: false` 无边框窗口，
   最小化/最大化/关闭三个按钮**都画在窗口右上角**（DOM 自绘，不是系统标题栏）——
   它们整体落在屏幕外，用户**关不掉也拖不动**这个窗口。
   修复：位置校验通过后，把 `width/height` 用工作区尺寸钳一次，再把 x/y 收进工作区。
10. **缓存"按最久未访问淘汰"在 Windows 上失效，退化成按创建时间**：
    `cleanup()` 用 `st.atimeMs || st.mtimeMs` 排序，而**实测 NTFS 默认不更新 last access time**
    （写文件后读取一次，`atimeMs` 完全不变，恒等于创建时间）。
    后果与设计意图正好相反：天天看的老剧（老文件）先被删、只看过一次的新文件反而留着；
    且 `maxOutputBytes=16GB / maxCacheBytes=20GB`，攒够两个大产物就会触发淘汰，
    可能删掉用户**正在看**的那个产物（拖进度到未缓冲处就失败）。
    修复：新增内存表 `lastUsedAt`，在每次产物被使用（命中缓存或新产出）时打标记，
    淘汰按"进程内最后使用时间"排序，缺记录（刚重启）才退回 `mtime`。**绝不再用 atime**。
11. **原生扩展名的强制档产物复用顺序反了**：
    快速通道里 `for (const t of ['audiofix', 'transcode'])` 先命中 audiofix。
    而 transcode 产物是在"画面也解不出"时转的，是 audiofix 的超集；反过来会导致
    "先只换音频、后又要重编码"的文件第二次打开复用到那个**已知播不出来**的 audiofix 产物，
    必然又黑屏一次。修复：顺序改为 `['transcode', 'audiofix']`。
12. **目录扫描深度超限静默丢文件**：`scanDirectorySafe` 的 `if (depth > maxDepth) return;`
    既不收文件也不置 `truncated=true`（而数量触顶那段会如实标记）。
    目录嵌套超过 4 层时深层视频静默消失，用户以为"这个文件夹就这些片子"。
    修复：深度超限时同样置 `truncated=true`，由界面统一提示"文件夹较大/较深，未全部载入"。

#### C. 性能

- **均衡器暂停指示收敛作用域**：`is-paused` 原先挂在**整个列表容器**上，导致每次播放/暂停切换
  （`updatePlayPauseUI`）都要让列表里每一条的动画样式重算（500 条 = 1500 个子元素），
  而其中只有当前那一条真正在动。改为只标当前条目（`syncPlaylistPauseIndicator()`，
  在重建列表与轻量高亮路径后都会重挂），CSS 选择器同步改为 `.playlist-item.is-paused`。
  这是 `docs/PERF-REVIEW-1.7.0.md` 补充四认定的"唯一确认的真问题"，本轮已修完。
- **清理界面里 147 处 `data-page-node-id` 属性**：外部工具误注入，全仓无任何 JS/CSS 引用，
  纯属污染（index.html 减少约 7.6KB）。

#### D. 工程质量（无界面测试基建）

v1.7.0 的质量保障只有"语法门禁 + 扩展名对账"，渲染层 2600 行完全没有自动化测试——
而框架最容易出的恰恰是"静默失效"（顶层求值抛错被 try/catch 吞掉、DOM id 改名导致功能失效）。
本轮补齐三套无界面自检，并把它们串进 `npm run verify`：

| 脚本 | 覆盖 |
|---|---|
| `verify-converter.js` | 第一层纯逻辑单测；**第二层 A 自带样本的真实转换**（默认就跑：换片作废、真实转换落地、缓存命中、体积闸门）；第二层 B 真实样本对账（可选，需 `BB_SAMPLES`） |
| `verify-renderer.js` | Node `vm` + DOM/Electron 桩**真实执行 renderer.js 顶层脚本**并驱动事件回调：界面结构契约（id 对账）、设置恢复链路完整性、字幕解析（10 种真实畸形写法）与加载、播放列表索引维护、失败熔断与自动跳集、音乐模式判定与自愈、均衡器作用域、兜底令牌防竞态、时长不可用时不写入无效值 |
| `verify-wiring.js` | 零构建应用的手写契约对账：打包清单、主进程依赖、preload 暴露的 API ↔ renderer 调用、IPC 通道收发双向、HTML 资源引用 |

关键设计两条：

1. **`verify-renderer.js` 测的是真代码**（`vm` 执行真实 `renderer.js`），不是复制出来的副本——
   否则"改了产品代码但忘了同步测试副本"就会变成假绿。
2. **关键的转换行为必须自带样本**：旧版把"换片作废 / 产物落地 / 体积闸门 / 进度上报"
   全部塞在"需要 `BB_SAMPLES` 外部样本"的分支里，结果默认环境下一条都跑不到，
   等于没有保护（本轮那个"换片堵 37.8 秒"的严重缺陷正是因此长期没被发现）。
   现在这些用例自己用内置 ffmpeg 造样本，只要 ffmpeg 在就会跑。

每条修复都补了能抓住它的断言，并做了红-绿验证（把修复还原 → 测试确实失败 → 恢复 → 通过）。

#### E. 文档一致性

- README_CN.md 删掉与内置 FFmpeg 直接矛盾的"全部解码由 Chromium 原生完成——零第三方解码器"，
  改为"除内置转换器外无其它第三方解码库、无运行时 npm 依赖"；
- DEVELOPER.md 语法门禁文件清单补入 `converter.js` / `verify-converter.js` / 两个新脚本
  （新增 JS 文件必须同步加进这个清单）；项目结构树、测试章节同步补齐。

#### F. 验证

- 10 个 JS 文件 `node --check` 逐个通过；
- `npm run verify` 四套自检全绿：扩展名对账（25 = 8+11+6）、converter 35 项（含自带样本的
  换片作废 / 真实转换 / 体积闸门，以及看门狗错误分类、atime 淘汰、产物复用顺序的静态盯防）、
  renderer 32 项、接线对账（含窗口钳制与目录截断标记的静态盯防）；
- 端到端静态对账：打包 8 个必需文件齐全、3 个主进程依赖可解析、renderer 调用的 24 个 API
  全部已暴露、IPC 18 发/5 收全部对得上、HTML 引用齐全；
- **红-绿验证（两轮）**：
  - 把"换片作废"的修复还原成缺陷态后，`verify-converter.js` 确实失败（退出码 1）；恢复后通过
    （新片 394ms 返回）；
  - 把 atime 淘汰、产物复用顺序、目录截断标记三处还原成缺陷态后，`verify-converter.js` 与
    `verify-wiring.js` 均确实失败（分别报出"不能按 atime 排序"与"深度超限必须置 truncated"）；
    恢复后全部通过。证明这些盯防断言有分辨力，不是摆设；
- 真实转换实测：换容器产物落地且二次打开命中缓存、产物体积闸门在 1 秒内拦住超限并清掉碎片、
  上限恢复正常后同一文件能正常转出（闸门不误伤）；
- 打包产物校验：`electron-builder` 打出安装版与便携版，`app.asar` 内的 7 个源文件与工作区
  源码**逐字节哈希一致**（确认打进 exe 的就是修复后的代码），`resources/ffmpeg` 9 个文件
  153.5MB 随包齐全；
- 未做 GUI/界面测试（按项目铁律，只做无界面逻辑验证）。

#### G. 遗留事项（评估后未改，附理由）

- ~~**升级 Electron**~~：已于 v1.9.0 完成（34.5.8 → 44.7.0，含官方三个启动优化 PR：
  主进程 Node 启动快照 / js2c 构建期代码缓存 / preload 字节码缓存）。
  静态核对确认 34→44 全部破坏性变更（clipboard 渲染端移除、macOS 12、ANGLE 静态链接、
  net.request 帧校验、32 位构建移除）与本项目 API 面零冲突；34 项无界面自检全绿；
- **多窗口 localStorage 互相覆盖**：真实存在（各窗口各持一份 history/settings，
  后写覆盖先写），根治要改成主进程集中持久化，属架构级改动，本版未动；
- **外部播放器兜底（方案 A）**：开发报告 4.5 提到"转换失败 → 退回提示 + 外部播放器按钮，
  绝不静默失败"。当前实现只做到"明确提示失败原因"（Toast 显示具体原因），
  没有提供"用系统里其它播放器打开"的按钮——它需要新增设置项与 `shell.openPath` 接线，
  属新功能而非缺陷修复，未在本轮夹带；
- **边转边播（P3）**、多音轨选择、内嵌字幕烧录：开发报告已列为"未做（有意）"。

### v1.7.0——启动体感优化 + 严重时序 BUG 修复 + 安全加固 + 性能收敛

#### A. 启动与体感优化（用户需求：缩短打开等待）

1. **窗口立即显示**：`BrowserWindow` 改为 `show: true` 创建（底色与页面背景一致的 `#08090C`，
   不会闪白），窗口"壳"在构造瞬间出现；不再等 `ready-to-show` 才显示——旧版在整个 Electron
   启动期间用户看不到任何东西，这才是"打开慢"的体感主因。详见关键机制第 19 节；
2. **音频增益管线移出启动关键路径**：`initAudioPipeline()`（`new AudioContext()` +
   `createMediaElementSource`，需初始化音频输出设备与音频线程）不再于 `restoreSettings` 中同步调用，
   改为首帧后 `requestIdleCallback`（退回双 rAF）惰性建立，建成后重跑 `applyMasterVolume()`
   补齐 >100% 增益档位；`enterMusicMode()` 另有保底初始化；
3. **强制同步布局延后**：`applyAspectMode()`（内部读 `clientWidth/clientHeight`）延后到首帧后执行；
4. **主进程不再被同步磁盘读阻塞**：`file:findCover` 的 `existsSync/statSync/readFileSync`
   全部改 `fs.promises`（多窗口下同步读等于卡住所有窗口）。

#### B. 严重 BUG 修复：启动设置恢复链路静默中断（Critical）

**根因**：`restoreSettings` 在脚本求值阶段同步执行，其中调用的 `applyAppearance()` 引用了
在文件**后面**才用 `const` 声明的 `SUN_ICON` / `MOON_ICON`，触发暂时性死区（TDZ）
抛 `ReferenceError`；异常被 `restoreSettings` 自身的 `try/catch` 吞掉（仅打一行 console 日志）。

**后果**（抛错点之后的恢复代码**全部不执行**）：音量恢复失效（存档的 200% 每次重启退回 100%）、
字幕字号未应用、字幕开关文案与倍速按钮文案未同步、倍速菜单选中态未同步。

**修复**：把两个图标常量上移到 `restoreSettings` 之前声明，并在原位置留注释说明原因。
**回归测试**：无界面冒烟测试在修复前 7 项失败、修复后全部通过（红-绿已验证）。

#### C. 正确性修复（全量审查）

1. **双击已打开过的视频毫无反应**：`addFilesToPlaylist` 去重后返回 0，调用方无任何后续动作，
   而"双击关联文件"正是主路径 → 新增 `playExistingFile()`，去重命中时切到该条目播放；
   文件对话框选中的文件全为列表已有项时同样处理（`openFolderAndAdd` 也补了提示，不再静默）；
2. **清空观看历史后又冒回来**：5 秒定点打卡会把正在播放的条目写回 →
   新增 `historySuppressedKey`，清空历史时记录当前路径并暂停写入，切换视频后自动解除；
3. **源解析失败导致列表状态错位**：`toFileUrl` 返回空串（文件被删/扩展名不支持）时提前 return，
   但 `currentPlaylistIndex` 与高亮已被改写 → 新增 `playlistIndexBeforeSwitch`，失败时回滚并提示文件名；
4. **纯音频误判无法自愈**：极少数容器在 `loadedmetadata` 阶段拿不到画面尺寸会被误判为纯音频，
   界面被音乐效果层盖住且永不纠正 → 新增 `loadeddata` 复检，发现有画面立即 `exitMusicMode()`；
5. **换片后首句字幕漏显**：字幕文案缓存 `lastRenderedSubText` 未随换片清空，新片首句若与
   上一部末句同文会被判为"无需重绘" → 在换片与清空播放器时一并重置；
6. **小写 `dialogue:` 的 ASS 字幕一条都读不出**：格式判定 `/^\s*Dialogue:/m` 区分大小写，
   而逐行解析用 `toLowerCase()` 判断，两者口径不一致 → 判定改为 `/^\s*Dialogue:/im`；
7. **窗口拖动坐标 NaN 未过滤**：`typeof NaN === 'number'`，漏掉 `isFinite` 会把 NaN 喂给
   `setPosition` → 补 `isFinite` 校验（与其它坐标入口口径一致）。

#### D. 安全加固

1. **`file:findCover` 越权读图**：入参不校验类型时等价于"传任意图片路径即可读回其 base64"
   → 增加与其它文件类 IPC 一致的媒体扩展名白名单；
2. **截图 IPC 载荷无上限** → 新增 `MAX_SCREENSHOT_BYTES`（64MB）；
3. **新窗口数量无上限**（注入后可循环开窗耗尽资源）→ 新增 `MAX_PLAYER_WINDOWS`（16）；
4. **主进程无进程级异常兜底**：任何一处 IPC 回调抛错都会让整个播放器退出
   → 新增 `process.on('uncaughtException'/'unhandledRejection')`，记录后继续运行；
5. **CSP 补全**：新增 `object-src 'none'` 与 `base-uri 'none'`。

#### E. 性能与内存

1. **频谱采样缓冲复用**：`drawSpectrumFrame` 原先每帧 `new Uint8Array(frequencyBinCount)`，
   改为复用 `spectrumBins`（仅在桶数变化时重建），消除音乐播放期间每秒约 60 次的短命分配。

#### F. 验证

- `node --check` 语法门禁 6 个文件全过；`npm run verify` 扩展名对账通过；
- **无界面冒烟测试**（Node + DOM 桩，真实执行 renderer.js 顶层脚本）：35 项断言全过；
  同一测试跑在修复前代码上 7 项失败，证明测试确有分辨力（红-绿验证）；
- 打包产物校验：逐项确认修复已进入 `app.asar`，且 `SUN_ICON` 声明时序正确。

#### 遗留事项（评估后未改，附理由）

- **播放列表全量重建**：仅 500 条大列表有感，而"轻量高亮路径"是第 17 节明确依赖的设计，
  重写风险大于收益；
- **频谱渐变每帧重建**：需改离屏色带重写绘制，且无法在无界面环境目视验证渲染效果；
- **多窗口 localStorage 互相覆盖**：真实存在，根治需改为主进程集中持久化（架构级改动）；
- 进度条 hover 取 rect、5 秒打卡全量读写、截图画布内存峰值：量级可忽略或属功能取舍。

---

### v1.6.1——彩虹品牌主题 + 播放栏彩虹化 + 双轴全量审查修复与瘦身

#### A. 彩虹品牌主题（用户需求）

1. **应用图标彩虹化重制**：`build/icon.png`（512px）与 `build/icon.ico`（7 尺寸）重绘为
   彩虹渐变播放三角（保留深色描边 + 透明底构图；Pillow 4x 超采样，渐变按三角包围盒归一化）；
   覆盖窗口/任务栏/打包 EXE/文件关联（fileAssociations 显式指定 icon）；
2. **界面品牌元素同步彩虹化**：标题栏 BBPLAYER Logo、空状态大 Logo、音乐封面兜底区；
3. **色标单一来源**：`--rw-1..7` 变量统一 4 处渐变（CSS + 3 处 SVG），消除 22 处硬编码 hex；
4. **窗口控制按键提亮**：图标灰色 → `--text-primary`（与软件名同色），悬停深色高亮块；
   清理死变量 `--win-hover-border`。

#### B. 播放功能栏彩虹化（用户需求）

1. **播放/暂停键**：底色透明，图标本身呈彩虹渐变（播放三角 / 暂停双竖条两态）；
   渐变 defs 独立于被 JS 重写的图标 svg（详见关键机制第 18 节），图标 20→24px；
2. **进度条**：恒定全宽彩虹 + `clip-path` 裁剪驱动（`--progress` 变量，3 处写入点），
   色带位置不随进度压缩变形；进度把手移出裁剪层改 `left: var(--progress)` 定位。

#### C. 正确性修复（双轴全量审查：正确性轴 + 过度设计轴并行）

1. **播放列表点击穿透**：点在"移除/新窗口"按钮内部 SVG 图形上时事件穿透成"播放该条目"
   → 改 `closest()` 命中 + `itemDiv.contains()` 双重校验；
2. **失败条目永久拉黑**：删除/清空播放列表不清理 `failedPlaylistKeys`，重新添加同名文件
   仍被自动跳过 → 删除条目时移除对应 key，清空播放器时全量清空；
3. **键盘 → 键 seek 校验口径**：`!isNaN(duration)` 对 Infinity 误通过 → 统一
   `hasSeekableDuration()`。

#### D. 工程瘦身（过度设计轴，净约 -50 行）

1. **拖拽实现合并**：视频画面与标题栏两套近重复 pointer 拖拽（各 ~45 行）→ 单一
   `bindWindowDrag(el, callbacks)`（回调注入差异行为：250ms 单击延时、按键区否决）；
2. **字幕扩展名单一来源**：主/渲染进程 4 处硬编码 → 新增 `shared-subtitle-exts.js`，
   主进程经 `app:getVideoExtensions` 下发 `subtitle` 字段（**打包清单已同步加入**）；
3. **死代码清理**：`progressFill` 常量（--progress 方案后零引用）、
   `--accent-solid`/`--accent-on-solid`（播放键彩虹化后无引用）、`--win-hover-border`；
4. **对账脚本挂载**：`npm run verify`（verify-exts.js 此前只能手动执行）。

#### E. 验证

6 个 JS `node --check` 全过；`npm run verify` 对账通过；grep 确认清理项零残留；
Electron 真实启动冒烟测试零报错。

---

### v1.6.0——"安静玻璃"低占用视觉重做 + 标题栏拖拽重构 + 正确性修复

#### A. 视觉体系重做（设计语言：简洁 / 无边框 / 低资源占用，用户需求）

1. **去模糊降 GPU**：7 处 `backdrop-filter` → 近实底 `--surface-raised`；
   唯一保留底部功能栏毛玻璃（`--dock-glass` + blur(20px)，用户指定）；
2. **去发光**：进度把手/按钮 hover/主按钮/续播条/音量增益/标题栏图标的 glow 与
   drop-shadow 全移除；圆角 token 化（--r-sm/md/lg/full 四档）；
3. **控制栏幽灵化**：`.ctrl-btn` 无边框无投影 hover 浅底；新增 `.ctrl-divider` 分组
   （倍速·比例·CC | 音量 | 外观·模式·截图·旋转 | 全屏·列表），所有功能保持可见；
4. **播放键唯一实心**：40px 圆角方形纯色强调（`--accent-solid`），无渐变无发光；
5. **窗口控制按键贴角**：44×42 矩形热区延伸到窗口右上角（原生无边框样式），
   关闭键 hover 纯红 `#e81123`；
6. **菜单左对齐** + `::before` 指示点选中态；播放列表 320px、渐隐 mask、SVG 操作图标、
   计数胶囊徽标；空状态文案精简；
7. **可访问性**：`:focus-visible` 焦点环 + `prefers-reduced-motion`；
   `transition: all` 全部收窄；清理 10 组闲置 CSS 变量。

#### B. 标题栏拖拽重构与显隐修复（重要 BUG，用户报告）

**根因**：`-webkit-app-region: drag` 的 OS 级拖拽区在 Windows 下视为 HTCAPTION，
**吞掉该区域全部鼠标事件**——隐藏后鼠标移进顶部热区收不到 mousemove（唤不出）；
停放标题栏上 3 秒兜底计时无人清零（当面收起）。

1. 标题栏移除 `app-region: drag`，改用与视频画面同一套 pointer + rAF 的 JS 拖拽
   （4px 阈值判拖/点，`window-move` IPC，blur 兜底清理）；
2. 新增双击标题栏空白区 = 最大化/还原（对齐原生标题栏习惯）；
3. `hideTitleBarNow()` 增加 `:hover` 守卫，兜底计时绝不在真实悬停时收起。

#### C. 正确性修复（全量审查）

1. **播放列表均衡器残留**：`playPlaylistItem` 轻量高亮路径只切 class 不重建 DOM，
   与"均衡器/序号二选一"的单份 DOM 生成冲突 → 每条目预置双份 DOM
   （`.item-index` + `.eq-indicator`），CSS 按 active 切换（详见关键机制第 17 节）；
2. **均衡器暂停联动**：`updatePlayPauseUI` 同步 `.playlist-items.is-paused`，
   暂停时动画静止不空转；
3. 播放列表操作按钮（↗/✕）从文字字符统一为 SVG 图标。

#### D. 性能与清理

- GPU：blur 面积大幅削减 + 全部 glow/drop-shadow 移除；
- CPU：`transition: all` → 具体属性，消除意外属性动画；
- 删除 10 组闲置 CSS 变量与全部发光层叠。

---

### v1.5.2——关闭即退出 + 标题栏跟随鼠标即时显隐 + 全量审查修复与瘦身

#### A. 窗口行为策略改版（用户需求）

1. **关闭即退出**：主窗口 `win.on('close')` 取消拦截（托盘常驻整套机制删除：`Tray`/`isQuitting`/
   `before-quit`/hide-show 事件转发）；`window-all-closed` 无条件 `app.quit()`；close 时取消挂起
   防抖并强制落盘 `window-state.json`。多窗口语义不变：主窗口关闭而弹窗存活时应用不退出。
2. **标题栏跟随鼠标即时显隐**：删除 400ms 延迟隐藏（`scheduleHideTitleBar`/`titlebarHideTimer`
   移除），移出热区 → `hideTitleBarNow()` 本帧收起；CSS 过渡 0.3s → 0.12s。
3. **唤出不要求播放状态**（修复旧 BUG：暂停中隐藏的标题栏无法唤出）；收起条件为
   `hasMediaLoaded()`（播放或暂停），空状态（无媒体）常驻保证窗口按键可用；新增
   `videoContainer` `mouseleave` 离窗兜底（`e.buttons > 0` 拖拽豁免）。
4. **主题色对齐复核**：曾试验"玻璃浮岛"标题栏方案被用户否决，完整回退为全透明通栏 42px 原形状；
   顶栏颜色确认 100% 走主题变量（与底部功能栏同一色板），`TITLEBAR_HOTZONE_HEIGHT` 回归 56。

#### B. 发布前全量审查修复（8 项正确性）

1. **最小化恢复续播失效（高危）**：`onWindowRestored` 条件 `!video.paused` 在"最小化时主动暂停"
   场景下恒假，续播整体失效 → 改为 `video.paused && !video.ended`。
2. **播完 1s 内手动重播被强切下一集**：`ended` 的 `autoNextTimer` 未被手动重播作废 → `play`
   事件监听器统一 `clearAutoNextTimer()`（幂等，覆盖按钮/空格/画面点击全部路径）。
3. **音乐封面环境光静默失效**：file:// 页面对 file:// 图像 `getImageData` 必然跨域污染抛
   SecurityError → `file:findCover` 命中时优先返回 `data:` URL（≤8MB，`MAX_COVER_BYTES`），
   同源可采样；超大回退 file://（仅采样走兜底背景）。
4. **启动空字幕横条**：`restoreSettings` 抢置 `display:block` → 删除，显隐统一由
   `renderSubtitlesAt` 裁决。
5. **时长守卫口径统一**：新增 `hasSeekableDuration()`，timeupdate/hover 预览/seek 三处共用
   （Infinity/NaN 一律不可 seek）。
6. **字幕偏移提示矛盾文案**（"延后 -1.5s"）→ `showSubtitleOffsetToast()` 按最终偏移方向描述。
7. **死防御清理**：`document.fullscreenElement` 恒 null（原生全屏无元素全屏），全屏禁拖由主进程
   `window-move` 兜底，渲染端误设防删除并注释指明防线。
8. **字幕编码嗅探收敛为单一实现**：渲染端 `decodeSubtitleBuffer` 副本删除，拖入字幕经新增 IPC
   `file:decodeSubtitle`（ArrayBuffer 载荷，10MB 上限，受信校验）交主进程解码，消除双份"保持同步"隐患。

#### C. 冗余瘦身（10 项，净 -27 行）

`showControls` 闲置兜底复用 `hideControlsNow`；历史条目点击两处恒真守卫与不可达分支删除；
频谱画布 style 尺寸与 CSS 等价代码删除；音量钳制三份收敛为 `applyMasterVolume` 单一出口；
`transparent: false` 默认值噪声、`scanDirectorySafe` 冗余参数、死 CSS 过渡、`run-test.bat`
冗余 `enabledelayedexpansion` 等全量清零。

---

### v1.5.1——双主题外观 + 品牌图标 + 标题栏透明化 + 工程重构与正确性加固

#### A. 双主题外观（用户需求，新功能）

- `:root` 全面变量化（30+ 语义变量收敛散落硬编码），新增 `:root[data-theme='light']` 整套浅色覆盖；
- 循环播放键左侧新增 `#btn-appearance` 外观切换键（SUN/MOON 图标提示目标状态）；
- `applyAppearance()` / `isLightTheme()` 切换 `document.documentElement.dataset.theme`；
- `--accent-text` 强调文字色主题自适应（浅色下纯青不可读）；
- 音乐模式封面环境光按主题双衬底，主题切换时在线重算；
- 持久化 `appearance` 字段 + 启动恢复。

#### B. 品牌图标重制（用户需求）

- 彩色播放键（青→蓝→紫渐变 + 玻璃高光 + 深蓝描边 + 透明底）；
- 替换 `build/icon.png`（512px）与 `build/icon.ico`（8 尺寸 PNG 条目）；
- 出口全覆盖：窗口/任务栏、托盘、打包 EXE、文件关联。

#### C. 标题栏透明化（用户需求）

- 删除 `--titlebar-bg` 渐隐毛玻璃色带，`#titlebar` 全透明；
- `--titlebar-shadow` / `--titlebar-icon-shadow`（深黑/浅白两套）保障画面上的文字图标可读；
- `win-btn:hover` 边框变量化（`--win-hover-border`），浅色主题 hover 反馈完整。

#### D. 工程重构与一致性校验

- `shared-video-exts.js` 结构化 `{ video, audio, all }`；preload 内联列表移除，
  渲染进程经 IPC `app:getVideoExtensions` 获取同一份数据；
- 新增 `verify-exts.js` 对账脚本（shared ↔ package.json fileAssociations，`node verify-exts.js`）；
- 删除 `reasonix.toml` 与 `.reasonix/` 工具残留（82 文件）；`.gitignore` 清理平台无关死规则；
- 文档诚实化：移除"已有回归测试覆盖"等不实声明，标注历史一次性验证未入库。

#### E. 正确性与健壮性修复（全量审查，共 13 项）

1. **清空播放列表竞态**：`resetPlayerToEmpty()` 递增 `loadSequence` 作废挂起异步加载（防止清空后旧视频复活回填）；
2. **无时长媒体**：`formatTime` 改 `Number.isFinite` 兜底（Infinity 不再显示 `Infinity:NaN:NaN`）；
3. **播放结束图标**：`ended` 先 `updatePlayPauseUI(false)` 复位（空列表/切歌缓冲期不再残留暂停态图标）；
4. **恢复窗口不强制续播**：`onWindowRestored` 补 `!video.paused` 校验（已自然播完不再被播起）；
5. **音乐模式截图快捷键**：`KeyS` 追加 `!isMusicMode`，不再弹无意义错误 Toast；
6. **窗口拖拽监听器泄漏**：`pointerdown` 拖拽路径补 `blur` 兜底清理（与 seek 路径对称）；
7. **second-instance 崩溃风险**：建窗延迟到 `app.whenReady()`（开机自启双实例竞争不再抛"ready 前建窗"异常）；
8. **最大化状态持久化**：落盘 `getNormalBounds()` + `maximized` 标志，重启恢复最大化（修复"伪最大化"占满工作区）;
9. **命令行多文件**：`parseFilePathFromArgs` 返回数组，多文件逐个开独立窗口播放；
10. **程序化尺寸不覆写偏好**：`programmaticResizeWindows`（WeakSet）标记自动贴合 setSize，
    仅用户手势（will-resize）触发状态记忆；
11. **弹窗文件一次性消费**：`did-finish-load` 发送后置空 `initialFile`（页面重载不重复投喂）；
12. **冷启动双通道归一**：删除 `app:getInitialFile` IPC 死通道，统一走 `open-file` 事件；
13. **对话框过滤器去重**：'音频文件' 字面量 → `VIDEO_EXTS.audio`。

#### F. 冗余精简

- 四个弹出菜单孪生代码 → `bindMenuToggle(btn, menu)` 统一（净 -13 行）；
- 频谱画布每帧 `getContext('2d')` → `spectrumCtx` 缓存；
- `run-test.bat` 保留（小白入口）；构建产物/双打包目标为用户决策项未代改。

---

### v1.5.0

#### A. 主流音频格式支持（用户需求，核心功能）

- 六种音频格式 `mp3 / flac / wav / ogg / m4a / aac` 全部原生支持（Chromium 自带解码器，
  真实样本在 Electron 34 实测 `canplay` 通过，含最冷门的裸 ADTS `.aac`），运行时零新增依赖。
- 扩展名统一经单一来源 `shared-video-exts.js` 下发（IPC `app:getVideoExtensions`），
  打开对话框新增"音频文件"过滤器，双击关联、拖拽、命令行打开、文件夹扫描全部覆盖音频。
- 纯音频判定：`videoWidth === 0 && videoHeight === 0`（实测确认），进入音乐播放效果模式。

#### B. 音乐播放效果模式（用户需求，界面重设计）

- **频谱可视化**：Web Audio `AnalyserNode` 串入既有增益/防破音管线（只读分流不改音质），
  32 根圆角渐变柱沉底横贯，播放跳动、暂停清空（省电）。
- **封面自动查找**：主进程 `file:findCover` IPC 找同目录 cover.jpg/folder.jpg/同名图片；
  找不到显示音符占位图。
- **封面主色环境光（Ambient）**：24×24 canvas 采样封面主色 → 背景渐变与光晕随歌变化，
  try/catch 兜底 + 无封面时重置默认背景；换歌用 `musicCoverToken` 令牌防旧封面串台。
- **信息层级**：歌名（clamp 自适应字号）+ 元信息行（格式 · 时长，uppercase 小字）。
- 音频模式下隐藏截图/字幕按钮、跳过同名字幕自动查找（防同名 .srt 被误挂）。

#### C. 窗口行为策略（用户需求）

- **最小化/隐藏分流**：视频最小化/隐藏自动暂停（恢复续播），纯音频音乐模式**不暂停、后台继续**。
- **系统托盘常驻**：主窗口点"关闭"改为隐藏到托盘，音乐/视频继续后台播放；
  托盘左键单击弹菜单（打开界面/关闭软件）、左键双击直接打开、右键弹菜单；
  `before-quit`/`window-all-closed` 守卫保证只有显式退出才结束进程；
  `second-instance`（再次双击 exe/关联文件）唤起隐藏的主窗口。

#### D. 全量代码审查修复（安全 / 正确性 / 性能）

- **安全**：CSP `img-src` 补 `file:`（封面 file:// 图兼容）；`path-to-url` 加扩展名白名单 +
  存在性校验；截图保存文件名清洗路径分隔符；显式 `sandbox: true`。
- **正确性**：AudioContext 挂起时 `play` 事件兜底 resume（防无声）；进度条排除 0/Infinity 时长
  （防 NaN% 样式值）；单曲循环播放失败不再显示假"播放中"；手动加载字幕带令牌防切歌覆盖；
  目录名含点时字幕截断误判修复；坏字幕时间轴（`"abc:def"`）改整体丢弃而非静默当 0 秒；
  自动播放回调复核用户手动暂停。
- **性能**：窗口拖拽 IPC rAF 合帧（每帧最多同步一次位置）；播放列表去重 O(n²)→O(1) Set；
  历史视图 DocumentFragment 批量挂载。
- **维护**：倍速格式化冗余运算清理；比例按钮初始文案与默认模式一致；托盘右键补监听（修复
  右键无菜单 bug）。

### v1.4.4

#### A. 多窗口多视频同时播放（用户需求，核心功能）

将播放器从"单窗口单视频"重构为"多窗口多视频"架构，每个窗口都是完整播放器：

1. **窗口工厂 `createPlayerWindow({ isMain, initialFile })`**：主窗口与新窗口弹窗共用同一套
   无边框/沉浸/比例锁/最小化自动暂停逻辑；仅主窗口持久化窗口状态，弹窗每次级联展开；
2. **IPC 信任面泛化**：`playerWindows` 集合 + `windowOf()` 取代"仅主窗口"校验，
   所有窗口控制/对话框/截图/自适应缩放/移动类 IPC 均作用于**发起窗口自身**，多窗口互不干扰；
3. **新增 `window:openInNewWindow` IPC**：校验扩展名白名单与 `fs.existsSync` 后创建弹窗并自动播放；
4. **三条新窗口入口**：播放列表项悬停 ↗ 按钮、播放列表头部"新窗口播放当前视频"按钮、
   运行中再次双击视频文件（`second-instance`）直接新窗口播放；
5. **弹窗级联偏移钳制**：默认主窗口右下 40px，并钳制在显示器工作区内（防靠边/最大化时挤出屏幕）；
6. **多窗口语义**：主窗口关闭但弹窗仍在时不退出应用；弹窗可继续级联再开新窗口；
   每个窗口独立渲染进程与独立 AudioContext，播放/字幕/音量完全隔离；
   localStorage 同源共享，历史与设置跨窗口一致。

#### B. 全量代码审查修复（性能 / 正确性 / 体验）

覆盖 main.js / preload.js / renderer.js / index.html 的审查与优化（二次复查补修 1 项）：

1. **ENOENT 字幕噪音静默**：同名字幕不存在是自动加载的常规路径，`file:readText` 不再为 ENOENT 打印错误栈；
2. **进度条拖拽失焦兜底**：鼠标在窗口外松开时 `mouseup` 不触发，新增窗口 `blur` 清理监听，
   避免 `isSeeking` 卡死导致进度/时间停止刷新；
3. **播放状态令牌防护**：`loadAndPlayVideo` 中 `video.play()` 的异步回调增加 `loadSequence` 校验，
   快速连播时旧视频回调不再覆盖新视频的播放状态 UI；
4. **新窗口按钮兜底**：无本地绝对路径（拖拽 blob）的条目点"新窗口"时明确 Toast 提示，
   不再被主进程静默忽略；
5. **清空播放器图标复位**：`resetPlayerToEmpty()` 补调 `updatePlayPauseUI(false)`，
   修复清空播放列表时残留"暂停"图标的问题；
6. **安全加固**：新窗口入口、字幕读取路径等均保持扩展名白名单 + 存在性校验；
7. **验证**：`node --check` 语法门禁 0 错误；实测冷启动播放、双窗口同时播放两个视频、
   主进程日志全程零报错。

### v1.4.3

#### A. 顶部标题栏智能沉浸与交互重做（用户需求）

1. **顶部热区感应**：新增 `TITLEBAR_HOTZONE_HEIGHT = 56`（42px 标题栏 + 14px 宽容余量），鼠标移入顶部感应区即唤出，移开延迟 0.4 秒（400ms 去抖缓冲）优雅隐藏，终结全窗口随处动鼠标即弹标题栏的打扰；
2. **沉浸模式状态机 (`isImmersiveMode`)**：仅在视频处于播放（Playing）中才自动隐藏标题栏；暂停或未载入视频（空状态）时强制常驻，方便随时拖动窗口；
3. **拖拽安全保护 (`isPointerOverTitleBar`)**：`e.buttons !== 0`（按住鼠标）且光标在标题栏上时绝对不隐藏，防止无边框拖动（`-webkit-app-region: drag`）中途脱手；
4. **画面点击唤出**：保留视频画面点击唤出标题栏与 3 秒闲置兜底计时（`titlebarIdleTimer` / `titlebarHideTimer`），兼顾便携操作。

#### B. 高频事件性能优化（消除强制同步重排）

1. **合并布局查询**：`updateControlsOnMouseMove(e)` 内将顶部与底部热区判断原先各自调用的 `getBoundingClientRect()` 合并为单次调用，彻底消除鼠标高频滑动下的多次 Forced Reflow，降低渲染进程 CPU 占用。

#### C. 细节与边界 BUG 修复

1. **双击全屏边界修复**：`dblclick` 处理器排除列表新增 `#playlist-panel`、`#resume-toast`、`#empty-state`、`#global-toast`，严格限定仅视频纯画面区双击才触发全屏；
2. **空格键双重翻转修复**：`keydown` 入口对焦点在 `input, button, textarea, select` 原生控件时直接放行，避免点击播放按钮后按空格同时触发原生 click 与全局 toggle 导致播停翻转两次；
3. **播放列表点击联动隔离**：阻断在播放列表/历史抽屉内点选文件时的标题栏误唤出；
4. **DOM 容错加固**：补充 `subtitleMenu` 判空等防御代码，清理 4 个构建残留 `.bak` 备份文件，重构理顺显隐控制状态机注释。

---

### v1.4.2（2025-08）——200% 音量翻倍与防破音增益系统

- **🔊 200% 音量超级增益（Audio Boost）**：
  - 基于现代 Web Audio API 构建专属音频处理管线，彻底突破 HTML5 `<video>` 原生 100% 音量上限；
  - 音量滑块、鼠标滚轮、方向键（`↑`/`↓`）、设置记忆全面支持 `0% ~ 200%` 调节；
  - 针对微弱录音、老旧电影、网课录屏等过小音源，一键放大翻倍，人声清晰洪亮。
- **🛡️ 硬件级防破音保护（Dynamics Compressor）**：
  - 串联轻量级专业动态音频压缩器，充当防爆音"安全气囊"；
  - 正常音量无损穿透，超大声波峰值逼近失真极限时自动柔和削峰，告别刺耳杂音与爆破音。
- **🎨 视觉警示与体验打磨**：
  - 音量滑块在超过 100% 后自动切换为醒目的**霓虹橙色**发光样式，视觉反馈清晰明确；
  - 完美向下兼容旧版播放器存档配置。

### v1.4.1——全量代码审查修复

> 本版源于一次覆盖 main.js / preload.js / renderer.js / index.html 的全量审查，
> 21 项问题全部修复；修复过程中二次复查又抓出并解决了 1 个施工中引入的竞态。
> 验证手段：`tsc --noEmit --allowJs --skipLibCheck` 语法门禁 0 错误 +
> Node 运行时实证 GBK 解码回退 + git diff 逐行自审。

#### A. 功能性 BUG 修复（Critical）

1. **GBK 等非 UTF-8 字幕乱码**：主进程 `file:readText` 改为读 Buffer 后经
   `decodeSubtitleBuffer()` 编码嗅探解码（BOM → UTF-8 严格 → GBK 回退 → latin1 兜底）；
   渲染进程拖拽路径同步引入同一套逻辑（`FileReader.readAsText` 默认 UTF-8 是旧乱码根因）；
2. **文件夹剧集顺序错乱**：目录扫描结果的 `sort()` 字典序改为
   `localeCompare('zh-Hans-CN', { numeric: true })` 自然排序（EP2 不再排在 EP10 后面）；
3. **字幕开关菜单文案死板**：「隐藏/显示字幕」菜单项文字随状态实时同步
   （点击时 + 恢复设置时两处）。

#### B. 行为修正

4. **窗口比例锁可解除**：新增 `will-resize` 监听，用户手动拉伸窗口即解除宽高比锁定
   （程序化 `setSize` 不触发该事件，换片自动贴合不受影响）；极端竖屏视频在
   minWidth 补偿导致高度超限时优先不溢出屏幕并放弃锁比例；
5. **播放失败熔断重构**：连续错误计数器改为 `failedPlaylistKeys` 失败集合——
   自动跳转跳过已失败项、全部条目失败过才停止；列表中途增删不再造成误判；
6. **视频+字幕混拖生效**：旧版同时拖视频和字幕会静默丢弃字幕；现采用
   「登记表 + 双向检查」机制（见关键机制第 8 节），规避 URL 转换与字幕解码的完成顺序竞态；
7. **定时器与打卡基准清理**：`resetPlayerToEmpty()` 补清挂起的自动切集定时器
   （防清空列表后误播新加入的视频）；换片时重置 `lastSavedProgressSec`
   （防新旧视频打卡秒数撞车丢保存）。

#### C. 健壮性与安全加固

8. `restoreSettings()` 对倍速钳制 [0.25, 4]：localStorage 损坏存入 0/负数/超大值时，
   `playbackRate` 赋值抛异常会中断后续所有设置的恢复（音量/字号/模式等此前均无钳制盲区）；
9. 字幕读取增加 10MB 大小上限（`MAX_SUBTITLE_BYTES`），防误选超大文件撑爆内存；
10. SRT/VTT 内联标签剥离 `stripInlineTags()`，`<i>` `<font>` 等不再原样显示成文字
    （仅匹配字母开头标签，避免误删正文中的比较符号）；
11. 同名字幕自动加载序列补 `.ssa`，与主进程白名单对齐；
12. preload 三个事件订阅 API（onOpenFile / onWindowMinimized / onWindowRestored）
    经 `makeIdempotentSubscriber()` 幂等化：重复调用先解绑旧监听器，杜绝回调累积；
13. 拖拽高亮改嵌套计数器 `dragDepth`（替代 clientX/Y 归零判断，多屏/DPI 下更可靠）；
14. `loadAndPlayVideo()` 异步化 + `loadSequence` 序号令牌（详见关键机制第 8 节）；
15. 窗口 close 时清理挂起的防抖状态保存定时器（并加 `isDestroyed()` 防护）。

#### D. 性能与体验打磨

16. `renderPlaylist()` 改 DocumentFragment 批量挂载 + 容器级事件委托：
    大列表（上限 500 条）不再逐条插入 DOM、逐条绑监听器；
17. 目录扫描触顶提示：`dialog:openFolder` 协议从 `string[]` 改为 `{ files, truncated }`
    （preload/renderer 同步适配），截断时 UI 明确提示「超出上限的部分未载入」；
18. `formatSpeed()` 统一倍速显示格式：1.25x 不再被 `toFixed(1)` 显示成 1.3x；
19. 移除最小化瞬间弹出的 Toast（窗口已最小化，用户根本看不见）；
20. index.html 清理 `<path>` 上无效的 `rx` 属性。

#### 遗留事项

- 无自动化测试 / lint / CI（项目维持零依赖纪律，暂未引入测试框架，留待评估）。

### v1.4

#### A. 底部功能栏交互重做（用户需求）

1. 功能栏从"全窗口任意鼠标移动即唤出"收紧为"鼠标进入底部 120px 感应区才唤出"；
2. 新增移开即隐：离开感应区且不在功能栏/弹出菜单上时立即收起并关闭弹出菜单；
3. 悬停保持：停在功能栏本体（含子菜单）上永不消失；
4. 保留播放中 3 秒无操作自动隐藏作为兜底；
5. 标题栏维持原有行为不变；
6. 移除"单击视频画面唤出功能栏"旧联动，单击只负责播放/暂停；
7. `showControls()` 拆分为 `showTitleBar` / `showControls` / `hideControlsNow` /
   `updateControlsOnMouseMove` 四个职责单一的函数，新增常量 `CONTROLS_HOTZONE_HEIGHT`。

#### B. 冗余代码清理（仓库审计）

1. **删除** `_screenshot_check.ps1`：一次性调试脚本，含硬编码本机绝对路径；
2. **合并拖拽监听**：原先同一事件挂两套监听器（一个循环挂 preventDefault +
   三个独立处理器），合并为四个各司其职的监听器；
   ⚠️ 施工中修复隐患：合并后 `drop` 处理器需自带 `preventDefault()`，
   否则浏览器会抢开被拖入的文件（回归验证为一次性人工测试，未保留在仓库）；
3. **合并上一首/下一首**：两段孪生代码 → `skipPlaylist(step)`；
   新旧索引算法已在列表长度 1/2/3/5/200 × 全下标 × 双方向对账，严格等价。

#### C. 质量保障手段（自动化项以仓库现存文件为准）

- 语法门禁必须**逐个文件**跑：`node --check` 只会检查第一个文件参数，写成
  `node --check main.js preload.js …` 时后面几个文件其实是被忽略的"假通过"。
  Windows PowerShell 写法（新增 JS 文件时**必须同步加进这个清单**）：
  `Get-ChildItem main.js,preload.js,renderer.js,converter.js,updater.js,shared-video-exts.js,shared-subtitle-exts.js,verify-exts.js,verify-converter.js,verify-renderer.js,verify-wiring.js | ForEach-Object { node --check $_.FullName }`；
- `node verify-exts.js`：扩展名一致性对账（`shared-video-exts.js` ↔ `package.json` 的 `build.fileAssociations`）；
- `node verify-converter.js`：转换层自检（判定规则单测 + 可选真实样本对账与转换冒烟，见第 20 节）；
- `node verify-renderer.js`：渲染层无界面自检。用 Node `vm` + 一套 DOM/Electron 桩**真实执行
  `renderer.js` 顶层脚本**并驱动其事件回调，覆盖：顶层求值无异常（专盯暂时性死区 TDZ 这类
  静默失效）、设置恢复链路跑完整、字幕解析（真实世界的畸形写法）与加载、播放列表增删与索引维护、
  播放失败熔断与自动跳集、纯音频音乐模式判定与误判自愈、均衡器暂停指示的作用域、
  运行时兜底的令牌防竞态、进度条在时长不可用时不写入无效值。
  **凡是改 renderer.js 的行为，都应在这里补一条能抓住它的断言**；
- `node verify-wiring.js`：端到端接线对账。本项目是"零构建" Electron 应用，主进程 / preload /
  渲染进程 / 打包清单 / HTML 之间的契约全靠手写字符串对齐，没有类型系统或打包器帮忙检查，
  对不上的症状往往是运行时静默失效（调不存在的 API、监听永不发送的通道、打包漏文件）。
  这一条把五组契约机器化：打包必需文件齐全、主进程本地依赖可解析、renderer 调用的 API 全部
  已在 preload 暴露、IPC 通道发/收双向对账、HTML 引用的本地资源存在；
- `npm run verify` 串起上面四个脚本（顺序执行，任一失败即非零退出）。
- 曾用 `puppeteer-core` + 注入 stub `electronAPI` 的临时 HTML 页面做无头浏览器回归
  （真实鼠标/拖拽事件），临时页测后即删，**未保留入库**（历史尝试，勿当作现存能力）。

#### v1.3 及之前的历史变更见 git 历史。

---

## 四、构建与测试

```bat
:: 源码方式运行测试（自动装环境，支持把视频文件拖到 bat 图标上直接播）
run-test.bat

:: 扩展名一致性对账（shared-video-exts / shared-subtitle-exts ↔ package.json）
npm run verify

:: 打包 Windows 安装版 + 便携版（输出到 release-dist/）
npm install
npm run build
```

打包产物为两个 exe：NSIS 安装版 exe（`BBPlayer Setup <版本>.exe`）与 portable 便携版 exe
（`BBPlayer <版本>.exe`）。`publish` 为 `null`，不生成更新清单、不做自动更新。
`release-dist/` 已被 .gitignore 排除，勿将构建产物提交进仓库。

### v1.9.1 新增的打包注意事项

- **若打包卡在"下载 Electron"**：electron-builder 默认会联网下载 Electron 发行包，弱网/被墙
  环境会超时。本机已装 Electron 时可改用本机副本跳过下载：

  ```bat
  npx electron-builder --win --config.electronDist=node_modules/electron/dist
  ```

- **打包后会自动删文件**：`build/afterPack.js` 钩子（v1.9.1 新增）在 Windows 打包后删除
  用不到的 WebGPU 着色器编译器 `dxcompiler.dll` / `dxil.dll`（−26MB）。构建日志会打印
  `[afterPack] 已移除无用的 WebGPU 着色器编译器：...`。该钩子仅在打包期生效，不进软件本体。
- **打包后建议核对**：
  - `locales/` 恰为 2 个文件（`zh-CN.pak` / `en-US.pak`）；
  - 产物根目录**无** `dxcompiler.dll` / `dxil.dll`；
  - `resources/ffmpeg/` 为 1 个 `ffmpeg.exe`（约 14MB）+ `LICENSE.txt`；
  - 整包 `win-unpacked` 约 **308MB**（v1.9.0 为 521MB）。


