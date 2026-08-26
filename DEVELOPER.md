# BBPlayer 开发者文档

> 本文档面向后续维护者，记录项目架构、关键机制与版本变更明细。
> 面向用户的功能介绍见 [README.md](./README.md)。

---

## 一、项目结构与文件职责

```
BBPlayer/
├── main.js               # Electron 主进程：窗口创建/状态记忆、IPC、文件对话框、目录扫描
├── preload.js            # 预加载脚本：contextBridge 暴露 electronAPI（渲染进程唯一系统入口）
├── renderer.js           # 渲染层全部业务逻辑（约 1700 行，单文件策略）
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

### 1. 底部功能栏显隐状态机（v1.4 重做）

标题栏与功能栏的显隐已拆分为两条独立线路：

| 元素 | 唤出条件 | 隐藏条件 |
|---|---|---|
| 顶部标题栏 `#titlebar` | 全窗口任意 `mousemove` / `click` | 播放中 3 秒无操作 |
| 底部功能栏 `#controls-overlay` | 鼠标进入底部感应区（离底边 ≤ `CONTROLS_HOTZONE_HEIGHT`=120px）或悬停其上 | 移开感应区且不在功能栏上 → **立即隐藏**；或播放中 3 秒无操作（兜底） |

核心函数（renderer.js 尾部）：

- `updateControlsOnMouseMove(e)` — 每次 mousemove 统一裁决；
- `isPointerOverControlBar(e)` — 用 `e.target.closest('#controls-overlay')` 判断悬停。
  弹出菜单（倍速/比例/字幕/播放模式）在 DOM 上都是功能栏的后代，
  因此鼠标挪进菜单不会被误判为"移开"——这是选择 closest 判断而非 mouseenter/leave 的原因；
- 双计时器：`controlsTimeout`（标题栏）与 `controlsIdleTimer`（功能栏）互不干扰。

设计取舍：感应区用**坐标判断**而非透明热区 div，避免热区拦截底部区域的单击暂停/双击全屏手势。
单击视频画面只负责播放/暂停，不再唤出功能栏。

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

### 5. IPC 安全面

所有主进程 IPC 处理器经 `isTrustedSender()` 校验发送方为顶层主窗口 frame；
字幕读取有扩展名白名单；`will-navigate` 与 `window-open` 已封死。

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

---

## 三、版本变更明细

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
