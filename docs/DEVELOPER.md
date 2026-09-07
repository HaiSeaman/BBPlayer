# BBPlayer 开发者文档

> 本文档面向后续维护者，记录项目架构、关键机制与版本变更明细。
> 面向用户的功能介绍见 [README.md](./README.md)。

---

## 一、项目结构与文件职责

```
BBPlayer/
├── main.js                 # Electron 主进程：多窗口工厂/状态记忆、IPC 信任面、文件对话框、目录扫描
├── preload.js              # 预加载脚本：contextBridge 暴露 electronAPI（渲染进程唯一系统入口）
├── renderer.js             # 渲染层全部业务逻辑（约 2300 行，单文件策略，每窗口一份独立实例）
├── index.html              # 界面结构 + 全部内联 CSS（"安静玻璃"低占用视觉 + 彩虹品牌体系 + 音乐播放效果层）
├── shared-video-exts.js    # 视频/音频扩展名单一事实来源：结构化 { video, audio, all }
├── shared-subtitle-exts.js # 字幕扩展名单一事实来源：['srt','vtt','ass','ssa']（v1.6.1 新增）
├── verify-exts.js          # 扩展名一致性对账脚本（shared-video-exts ↔ package.json fileAssociations）
├── run-test.bat            # 源码方式启动测试（自动检测 Node/Electron 环境）
├── build/                  # 打包图标（彩虹渐变播放三角 ico/png，v1.6.1 重制）
└── package.json            # 元数据 + electron-builder 配置
```

**依赖纪律**：运行时零 npm 依赖；仅 `electron` 与 `electron-builder` 两个 devDependencies。
扩展名单一事实来源有两份（v1.6.1 起）：`shared-video-exts.js`（结构化 `video/audio/all`）与
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

### 5. IPC 安全面（v1.4.4 起为多窗口信任面）

所有主进程 IPC 处理器经 `isTrustedSender()` 校验发送方：
- v1.4.4 前：仅接受顶层主窗口 frame；
- **v1.4.4 起**：接受 `playerWindows` 集合内任意播放器窗口的顶层 frame。
  集合在 `createPlayerWindow()` 创建时加入、`closed` 时移除；发送窗口由 `windowOf(event)`
  （`BrowserWindow.fromWebContents(event.sender)`）定位。
- 字幕读取有扩展名白名单 + 10MB 上限；`will-navigate` 与 `window-open` 已封死；
- 新窗口播放入口 `window:openInNewWindow` 校验扩展名白名单 + `fs.existsSync`。

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

### 11. 多窗口架构（v1.4.4 新增）

**目标**：多个视频在各自独立窗口同时播放（类似 PotPlayer/VLC 多开），每个窗口都是完整播放器。

**核心设计**：

1. **窗口工厂 `createPlayerWindow({ isMain, initialFile })`**：主窗口与新窗口弹窗共用同一套
   无边框/沉浸/比例锁/最小化自动暂停逻辑。`isMain` 决定是否记忆窗口状态（仅主窗口持久化
   bounds 到 `window-state.json`）；`initialFile` 让弹窗在 `did-finish-load` 后自动播放指定文件。
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

## 三、版本变更明细

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

- `node --check main.js preload.js renderer.js shared-video-exts.js verify-exts.js` 语法门禁；
- `node verify-exts.js`：扩展名一致性对账（`shared-video-exts.js` ↔ `package.json` 的 `build.fileAssociations`）；
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

打包产物三件套：NSIS 安装版 exe、portable 便携版 exe、latest.yml（供更新检查）。
`release-dist/` 已被 .gitignore 排除，勿将构建产物提交进仓库。
