# BBPlayer 开发者文档

> 本文档面向后续维护者，记录项目架构、关键机制与版本变更明细。
> 面向用户的功能介绍见 [README.md](./README.md)。

---

## 一、项目结构与文件职责

```
BBPlayer/
├── main.js               # Electron 主进程：多窗口工厂/状态记忆、IPC 信任面、文件对话框、目录扫描
├── preload.js            # 预加载脚本：contextBridge 暴露 electronAPI（渲染进程唯一系统入口）
├── renderer.js           # 渲染层全部业务逻辑（约 2000 行，单文件策略，每窗口一份独立实例）
├── index.html            # 界面结构 + 全部内联 CSS（毛玻璃视觉，单文件免额外请求）
├── shared-video-exts.js  # 视频扩展名单一来源（主进程用）
├── run-test.bat          # 源码方式启动测试（自动检测 Node/Electron 环境）
├── build/                # 打包图标
└── package.json          # 元数据 + electron-builder 配置
```

**依赖纪律**：运行时零 npm 依赖；仅 `electron` 与 `electron-builder` 两个 devDependencies。
视频扩展名清单存在三处人工同步点：`shared-video-exts.js`、`preload.js`（沙箱内无法 require）、
`package.json` 的 `build.fileAssociations`——修改时三处必须一起改。

---

## 二、关键机制说明

### 1. 顶部标题栏与底部功能栏显隐状态机（v1.4.3 全面重做）

标题栏与功能栏均采用"智能热区感应 + 沉浸自适应"双轨机制：

| 元素 | 唤出条件 | 隐藏条件 |
|---|---|---|
| 顶部标题栏 `#titlebar` | 鼠标进入顶部感应区（`TITLEBAR_HOTZONE_HEIGHT`=56px）、或点击视频画面 | 离开顶部感应区且未按住鼠标拖动 → **延迟 0.4 秒隐藏**；或播放中 3 秒无操作（兜底）；**空状态与暂停时常驻** |
| 底部功能栏 `#controls-overlay` | 鼠标进入底部感应区（离底边 ≤ `CONTROLS_HOTZONE_HEIGHT`=120px）或悬停其上 | 移开感应区且不在功能栏上 → **立即隐藏**；或播放中 3 秒无操作（兜底） |

核心设计与状态控制函数（renderer.js 尾部）：

- `updateControlsOnMouseMove(e)` — 每次 mousemove 统一裁决；
  - **性能关键**：单次 mousemove 仅执行 1 次 `getBoundingClientRect()`，顶部与底部感应区共用 Rect，杜绝多次 Forced Reflow；
- `isPointerOverControlBar(e)` — 用 `e.target.closest('#controls-overlay')` 判断功能栏悬停（包含其弹出子菜单）；
- `isPointerOverTitleBar(e)` — 用 `e.target.closest('#titlebar')` 判断鼠标悬停或拖拽按住标题栏；
- `isImmersiveMode()` — 判断是否处于沉浸模式（有视频且处于播放中状态）；非沉浸模式下标题栏强制常驻；
- `scheduleHideTitleBar()` — 400ms 去抖延时隐藏，防止鼠标划过顶部边缘时剧烈闪烁；
- 拖拽安全防护：`e.buttons !== 0` 且在标题栏上时不隐藏，确保无边框拖拽（`-webkit-app-region: drag`）不脱手。

### 2. 视频画面拖拽窗口 + 单击播放手势

`video` 元素 `pointerdown` 起手记录屏幕坐标，`pointermove` 位移 >4px 判定为拖窗口
（经 IPC `window-move` 让主进程移动），否则在 `pointerup` 后延时 250ms 触发播放/暂停
（延时用于给双击全屏让路，双击会取消该计时器）。

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

**编码嗅探管线**（v1.4.1 新增）：主进程 `file:readText` 与渲染进程拖拽路径共用同一套
`decodeSubtitleBuffer()` 逻辑（两份实现，注意保持同步）：
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

## 三、版本变更明细

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

### v1.4.1（当前工作区，未提交）——全量代码审查修复

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
   否则浏览器会抢开被拖入的文件（已有回归测试覆盖）；
3. **合并上一首/下一首**：两段孪生代码 → `skipPlaylist(step)`；
   新旧索引算法已在列表长度 1/2/3/5/200 × 全下标 × 双方向对账，严格等价。

#### C. 质量保障手段（可复用）

- `node --check renderer.js` 语法门禁；
- 算法等价性对账脚本（Node 直接跑，无需框架）；
- 无头浏览器回归：`puppeteer-core` + 系统 Edge 驱动真实鼠标/拖拽事件，
  通过注入 stub `electronAPI` 的临时 HTML 页面在纯浏览器环境加载 UI 层验证
  （临时页测后即删，不入库）。

#### v1.3 及之前的历史变更见 README.md 更新日志章节与 git 历史。

---

## 四、构建与测试

```bat
:: 源码方式运行测试（自动装环境，支持把视频文件拖到 bat 图标上直接播）
run-test.bat

:: 打包 Windows 安装版 + 便携版（输出到 release-dist/）
npm install
npm run build
```

打包产物三件套：NSIS 安装版 exe、portable 便携版 exe、latest.yml（供更新检查）。
`release-dist/` 已被 .gitignore 排除，勿将构建产物提交进仓库。
