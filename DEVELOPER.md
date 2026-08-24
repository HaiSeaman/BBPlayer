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
而不是交给播放器。`dragleave` 仅在坐标归零（真正离开窗口）时清除高亮，掠过子元素不清除。

### 4. 字幕引擎

自研 SRT/VTT/ASS 解析（浏览器原生 `<track>` 无法处理 file:// 路径与 ASS 格式）：
解析后按开始时间排序，播放时二分定位 + 向前回扫最多 200 条以兼容重叠时间轴；
`lastRenderedSubText` 缓存避免每帧无效 DOM 写入。

### 5. IPC 安全面

所有主进程 IPC 处理器经 `isTrustedSender()` 校验发送方为顶层主窗口 frame；
字幕读取有扩展名白名单；`will-navigate` 与 `window-open` 已封死。

### 6. 持久化键（localStorage）

- `bb_player_history`：播放进度（上限 `HISTORY_MAX`=200 条，写入时裁剪）；
- `bb_player_settings`：音量/倍速/字幕样式偏移/播放模式。

### 7. 内存管理要点

- Blob 播放的 URL 由 `revokeCurrentBlobUrl()` 统一回收；
- 截图走 `ArrayBuffer` 过 IPC（避免 base64 膨胀 33%）;
- 文件夹扫描上限 500 个文件、深度 3 层。

---

## 三、版本变更明细

### v1.4（当前工作区，未提交）

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
