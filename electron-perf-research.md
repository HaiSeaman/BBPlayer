# Electron 启动速度与内存优化调研（BBPlayer / Electron 34.5.8 / Win10-11 x64）

> **状态（2026-10-12 追加）**：本报告的结论已在 **v1.9.0** 落地——内核升级到 Electron 44.7.0
> （吃 §1 的三个官方启动优化 PR），打包工具升到 electron-builder 26.17.0。
> 其余项（命令行开关、V8 快照、Windows 特有成本、安装包体积、测量方法）的评估结论见下文，
> 落地情况与理由见 `docs/DEVELOPER.md` 的 v1.9.0 章节。

> 标注约定：`[官方]` = Electron/Node/Microsoft 官方文档或官方 PR 实测数据；`[社区]` = 论坛/博客数据；`[推算]` = 由你给出的数字推导；`[存疑]` = 无来源，不要采信。

---

## 0. 你已排除的三条：为什么无效 / 为什么测不出来

| 项 | 判定 | 原因 |
|---|---|---|
| `Menu.setApplicationMenu(null)` | 你的 A/B 正确，**保留菜单** | `[官方]` 性能文档确实推荐，但**从未给出任何数字**（原文仅 "it will benefit startup performance"，[docs](https://electronjs.org/docs/latest/tutorial/performance)）。无边框窗口根本不显示菜单，默认菜单只是一次 Win32 `CreateMenu`，量级 0.1ms。文档收益主要针对 macOS 原生菜单 / 自建大型菜单 |
| 滚轮防抖、5s 定时器 | 0.014ms / 0.16ms **可信，永久排除** | 主线程纯 JS，非磁盘 I/O。哪怕每秒 1000 次也只有 14ms/s ≈ 单核 1.4% |
| `backdrop-filter` | **测不出 ≠ 免费，是测量设计错误** | Chromium render pass 有 damage tracking：静态层纹理被整体跳过、零 GPU 工作。只有 blur **背后**内容变化时才重绘。详见 §6 |

---

## 1. 头号发现：Electron 34 已 EOL，且官方启动优化全部在 42+

- **34.x 已宣告 EOL** —— Electron 37.0.0 发布说明："End of Support for 34.x.y"（[releases v37.0.0](https://releases.electronjs.org/release/v37.0.0)）。
- 三个官方启动优化 PR **全部合并于 2026-05/06**，落在 main(42) 并回移植 42/43/44 分支。**Electron 35–41 一个都没有。**

| PR | 内容 | 官方数字（Release / x64 **Linux** / 24 冷样本） |
|---|---|---|
| [#51703](https://github.com/electron/electron/pull/51703) 主进程 Node 启动快照 | Node bootstrap 由源码解析改为反序列化 | spawn→`ready` **197.8→148.7ms（−25%）**；spawn→首行主进程 JS 123.2→73.8ms（−40%）。代价 **+4.6MB** 二进制 |
| [#51697](https://github.com/electron/electron/pull/51697) js2c 构建期代码缓存 | 框架 bundle 免解析免编译 | 沙箱渲染进程 `DidClearWindowObject` **9.8→6.4ms（−35%）** |
| [#51602](https://github.com/electron/electron/pull/51602) preload 字节码缓存 + mojo 预推 | 移除 `BROWSER_SANDBOX_LOAD` 同步 IPC | 两个 ~150KB preload：**FCP 244→140ms**；后续启动再省 4.0–4.8ms |

- 首个包含它们的稳定版：**43.0.0**（[回移植 #51792，自 v43.0.0-beta.1 起](https://github.com/electron/electron/pull/51792)；42.x 亦有回移植 [#51831](https://github.com/electron/electron/pull/51831)）。
- **风险**：以上是 **Linux/x64 的 Electron 内部基准，Windows 数字未验证**。但 −49ms 的收益几乎全在 Node bootstrap 上——BBPlayer 主进程 672 行、零 npm 依赖，正是最大受益形态。Chromium 跨度 M132→M150，需完整回归。
- **结论：升级到最新稳定版是本报告第一优先级**，收益量级远超其余所有手段之和。

---

## 2. Chromium 命令行开关

| 开关 | 对 BBPlayer 的判断 | 依据 |
|---|---|---|
| `disable-gpu` / `app.disableHardwareAcceleration()` | 🔴 **绝对不要** | 视频播放退化为软件解码。`[官方]` 文档明确不推荐 |
| `--renderer-process-limit=1` | ⚠️ **值得 A/B**。单窗口省一个渲染进程的固定开销 | 机制清楚；**省多少 MB 无任何官方数字 → 自测** |
| `--in-process-gpu` | `[存疑]` 不建议：省一进程但抬高主进程、GPU 崩溃拖垮主进程 | 无 Electron 量化数据 |
| `--js-flags=--max-old-space-size=N` | ❌ **对你无收益且有风险**，见下 | — |
| `--disable-background-timer-throttling` 等 | 无必要，`backgroundThrottling:false` 已覆盖 | — |

**`--max-old-space-size` 的真相**：
1. 它**只作用于带 Node 的进程**（主进程）。`sandbox:true` 的渲染进程无 Node，拿不到该 flag。主进程 672 行零依赖，堆本就小。
2. `[官方]` 只说"`--js-flags` 必须启动时传入才作用于主进程"，**从未推荐任何数值**（[command-line-switches](https://electronjs.org/docs/latest/api/command-line-switches)）。打包应用可靠设置走 `NODE_OPTIONS`（[environment-variables](https://electronjs.org/docs/latest/api/environment-variables)），受 `nodeOptions` fuse 控制。
3. 调小 → 视频解码缓冲抖动时 OOM 崩溃；调大 → 不省内存。**净收益为负。** 回读是否生效：`process.getHeapStatistics().heapSizeLimit`。

---

## 3. V8 代码缓存 / Node 快照：Electron 34 里没有，且无法手动开启

| 能力 | Electron 34 (Node 20.18) | 说明 |
|---|---|---|
| V8 启动快照 `v8_context_snapshot.bin` | ✅ 内置 | [fuses 文档](https://electronjs.org/docs/latest/tutorial/fuses) |
| 主进程 Node 启动快照 | ❌ | 需 ≥42/43，见 §1。34 内无法配置 |
| js2c 构建期代码缓存 | ❌ | ≥42/43 |
| preload 字节码缓存 | ❌ | ≥42/43 |
| `module.enableCompileCache()` | ❌ | Node 22.1 才引入，34 是 Node 20.18 |

🔴 **反直觉警告**：`loadBrowserProcessSpecificV8Snapshot` fuse 的 `[官方]` 文档明说它**会拖慢启动**（主进程改从源码 bootstrap Node）。不要相信"开 fuse 提速"类建议。

**`module.enableCompileCache()` 对你无用**：官方实测收益全部来自**巨大模块图**——`[官方]` [nodejs PR #52535](https://github.com/nodejs/node/pull/52535) `typescript.js` 124.3→72.3ms；[corepack PR #574](https://github.com/nodejs/corepack/pull/574) yarn 187→131.8ms、pnpm 325.8→233.7ms。BBPlayer **零 npm 依赖**，无可缓存的图。

**第三方方案核查**：`electron-json-storage`（存储库，无性能意义）；"lambda 化 CLI 启动器"（**未找到任何真实存在的方案**）；`v8-compile-cache` / `bytenode`（已被 `module.enableCompileCache()` 取代）。唯一值得一提的是 `@electron/fuses`，但它是**安全**工具（关 `RunAsNode` / `nodeOptions` / `nodeCliInspect`），**提速效果未验证**。

---

## 4. Windows 特有启动成本

- `[社区]` **Defender 对 Electron 的实测**：极简应用开启 Defender 时 170ms 出窗口 / **2800ms** 出内容；关闭则 150ms / **500ms**（[SO 67982430](https://stackoverflow.com/questions/67982430)）。非官方，但效应量级大。[Gemini CLI #19169](https://github.com/google-gemini/gemini-cli/issues/19169) 佐证机制：44,835 文件 → 冷启 60–120s，单文件二进制 → ~3s。**BBPlayer 仅约 57 个文件，问题不是文件数，是 181MB exe 的内容扫描。**
- `[官方]` **代码签名**：SmartScreen 看两个信号——发布者证书信誉 + 文件哈希信誉。**未签名文件每次更新都要重建信誉**，需数周 / 数百次安装；**EV 证书可立即获得信誉**（[Microsoft SmartScreen reputation](https://github.com/MicrosoftDocs/windows-dev-docs/blob/docs/hub/apps/package-and-deploy/smartscreen-reputation.md)）→ 签 EV 是唯一可分发的解。
- `[存疑]` **反向风险**：有用户报告 5MB 已签名 exe 双击打开要 30s，原因是 Explorer 验证整个文件的签名、文件越大越明显（[SO 15475751](https://stackoverflow.com/questions/15475751/)），未在 Electron 上复现。181MB 可能触发同类问题，**需你自测**。
- **本机量化 Defender 的正确做法**（仅测量，不随包分发；需管理员权限，测完立即恢复）：
```powershell
Add-MpPreference -ExclusionPath "D:\AI\Github\BBPlayer\BBPlayer\win-unpacked"
# ...A/B 各跑 N 轮...
Remove-MpPreference -ExclusionPath "D:\AI\Github\BBPlayer\BBPlayer\win-unpacked"
```
- ⚠️ **测量陷阱**：Defender 按 `(路径, 哈希)` 缓存、TTL 数小时。**不换二进制就测不出冷启差异**；测真冷启必须替换 exe（换哈希）。

---

## 5. 安装包体积

| 手段 | 预期收益 | 风险 |
|---|---|---|
| `electronLanguages: ["zh-CN","en-US"]` | `[推算]` 41.26MB / 55 ≈ 0.75MB/个，删 53 个 ≈ **省 40MB** | 🔴 **高危**，见下 |
| 检查 `compression` 不是 `"store"` | **可能是最大的免费收益** | `[社区]` 有人误设 `"store"`，安装包 200MB→61MB（[electron-builder #2390](https://github.com/electron-userland/electron-builder/issues/2390)） |
| `asar` 压缩 | **0**（你的 asar 仅 0.22MB） | 无 |
| `removePackageScripts` / `removePackageKeywords` | **≈0**（同上） | 无 |
| `nsis-web` | 只改下载方式，不减安装体积 | 无 |

🔴 **`electronLanguages` 致命坑（务必读）**：electron-builder 曾把 `electronLanguages: ["en"]` 的匹配方向写反，**在 Windows/Linux 上删光全部 locale、打包出空 `locales/` 目录、应用启动即崩且无任何报错**——[electron-builder #10007](https://github.com/electron-userland/electron-builder/pull/10007) → [electron #52307](https://github.com/electron/electron/issues/52307)。
**正确做法**：① 用区域限定码 `["zh-CN","en-US"]`，**不要用裸 `"en"`**；② 打包后**断言 `locales/` 非空**；③ 配 `app.commandLine.appendSwitch('lang','zh-CN')`。
`[社区]` 删除 `en-US.pak` 会导致字体家族变化（[electron-builder #7506](https://github.com/electron-userland/electron-builder/issues/7506)）。
**是否影响启动**：`.pak` 按需加载，删除不使用 locale 对启动**应无影响**，但 `[存疑]` 无官方数据，需 A/B 确认。

---

## 6. 如何正确测量（无 GUI、纯命令行）

**分段打点**：外部 PowerShell `Stopwatch` 记 T0，配主进程内部打点配对看：
```
main.js 首行        console.log('[boot] entry', performance.now())
app.whenReady      console.log('[boot] ready', performance.now())
did-finish-load / ready-to-show  分别打点
```
- ⚠️ 不要用 `process.uptime()` 当 exec 起点（其原点在 Node 初始化之后）；`--cpu-prof` 在 Electron 里无效，改用 `inspector.Session`。

**内存**：`app.getAppMetrics()` 按 `type` 拿到每个进程（Browser / Tab / **GPU** / Utility）的 `workingSetSize` / `peakWorkingSetSize` / `privateBytes` / `sharedBytes`。
- 判读用 **`privateBytes`（私有提交量），不要用 workingSet/RSS** —— Chromium 大量共享 DLL 页，RSS 虚高（`[社区]` [debugging-electron-memory-usage](https://seenaburns.com/debugging-electron-memory-usage/)）。
- V8 侧：`process.getHeapStatistics()`（含 `heapSizeLimit`）、`process.getBlinkMemoryInfo()`（DOM 层）、`webContents.getProcessMemoryInfo()`（单位 KB）。
- ⚠️ **不要定时轮询 `app.getGpuInfo()`** —— 已知会导致 GPU 进程内存泄漏（[electron #49115](https://github.com/electron/electron/issues/49115)，Vulkan 驱动侧，官方已判定为 upstream 并关闭）。

### 🔓 如何突破 vsync 对帧率测量的限制

rAF 间隔被刷新率锁死是**设计如此**，任何帧率测法都测不出 GPU 成本。三条可行路径：

1. **别测帧率，测 raster 工作量。** `contentTracing.startRecording({ included_categories: ['viz','cc','gpu','skia'] })`，分析 `DrawRenderPassQuad` / raster 事件每帧耗时——raster 不受 vsync 约束（[contentTracing API](https://github.com/electron/electron/blob/main/docs/api/content-tracing.md)）。
2. **强制制造 damage（这是你之前 6 种测法全灭的根因）。** 在 blur 层**背后**放一个每帧变化的元素，render pass 才必须重绘；再对比有无 blur 的 raster 耗时。Chromium 的 damage tracking 会**跳过无损伤的 render pass、复用上一帧纹理、零 GPU 工作**；且 pixel-moving backdrop filter 会把整个子 surface 的 rect 扩展进 damage，触发全量重算（`[第三方分析，非 Chromium 官方]` [damage tracking](https://nothing.graphics/docs/wg/research/chromium/damage-tracking)）。
3. **`--disable-gpu-vsync` + `--disable-frame-rate-limit`** 解锁帧率天花板（Chromium 开关，Electron 继承）。注意解锁后测的是**光栅吞吐**，不是用户感知帧率。

### Chromium 对 backdrop-filter 的实际优化

`[提案文档，非现状文档]` [mfedelea 提案 README](https://github.com/mfreed7/backdrop-filter-feature/blob/master/README.md)：实现路径是「读回目标纹理 → 施加滤镜 → 按圆角裁剪 → 合成」；因 **Backdrop Root 规范**，只需读最近的祖先 render surface。
`[官方]` 已知现状：`backdrop_filter_quality` 支持降采样输入（大 blur 下取 0.5 即省 4 倍像素）；`--disable-gpu` 下 backdrop-filter **实现不完整**（[Chromium commit](https://chromium.googlesource.com/chromium/src/+/5ff2d1bef3dd93aaf97ee01aff46719d3bb7114a)）。

**结论**：静态时几乎免费；**播放时背后有画面在动 → 每帧全量重算**。你的播放器长期处于「背后静止」状态，所以测出 0 是合理的。是否需要在播放时降级，取决于你的 CPU/GPU 余量——**本次未找到官方量化数据**。

---

## 7. 内存诊断决策树

1. `app.getAppMetrics()` 按 `type` 分组看 `privateBytes` → 谁大一目了然（Tab=渲染、GPU=GPU 进程、Browser=主进程）。
2. **渲染进程大** → `process.getBlinkMemoryInfo()`（DOM/JS 归属）+ `getHeapStatistics()`（V8 堆）。`sandbox:true` 下渲染器无 Node 对象，堆高基本来自 DOM / 图片 / 视频 buffer。
3. **GPU 进程大** → 先分清是显存还是系统内存：`privateBytes` 是系统侧；显存需 `app.getGPUInfo()` **一次性**读取。
4. **主进程大** → `getHeapStatistics()`；主进程不该持有大量对象。
5. 辅助：Windows 任务管理器「GPU」列、`Get-Counter`、CDP `Performance.getMetrics` / `Memory.getBrowserSamplingProfile`。

---

## 8. 存疑 / 不要采信清单

- `--renderer-process-limit=1`、`--in-process-gpu` 的**具体收益数字**：无任何来源，需自测。
- `electronLanguages` 对**启动速度**的影响：无来源。
- 签名 181MB exe 是否引入 Explorer 验证延迟：单一论坛案例，未在 Electron 复现。
- Windows 上 #51703 / #51697 / #51602 的实际收益：官方仅有 Linux/x64 基准。
- 「lambda 化 CLI 启动器」：未找到真实存在的方案。

---

## 附：来源清单

- Electron 性能文档 https://electronjs.org/docs/latest/tutorial/performance
- Electron 命令行开关 https://electronjs.org/docs/latest/api/command-line-switches
- Electron 环境变量 https://electronjs.org/docs/latest/api/environment-variables
- Electron Fuses https://electronjs.org/docs/latest/tutorial/fuses
- Electron 发布计划 https://releases.electronjs.org/schedule
- Electron v37.0.0（宣告 34 EOL）https://releases.electronjs.org/release/v37.0.0
- PR #51602 / #51697 / #51703 / #51792 / #51831（见 §1 链接）
- contentTracing API https://github.com/electron/electron/blob/main/docs/api/content-tracing.md
- process API https://electronjs.org/docs/latest/api/process
- ProcessMemoryInfo https://github.com/electron/electron/blob/main/docs/api/structures/process-memory-info.md
- GPU 进程泄漏 #49115 https://github.com/electron/electron/issues/49115
- electronLanguages 空 locales #52307 https://github.com/electron/electron/issues/52307
- electron-builder #10007 https://github.com/electron-userland/electron-builder/pull/10007
- electron-builder 配置 https://www.electron.build/docs/configuration/
- compression store #2390 https://github.com/electron-userland/electron-builder/issues/2390
- locale 删除实测 #7506 https://github.com/electron-userland/electron-builder/issues/7506
- Microsoft SmartScreen reputation https://github.com/MicrosoftDocs/windows-dev-docs/blob/docs/hub/apps/package-and-deploy/smartscreen-reputation.md
- Node module.compile cache https://nodejs.org/docs/latest-v22.x/api/module.html
- nodejs PR #52535 https://github.com/nodejs/node/pull/52535
- corepack PR #574 https://github.com/nodejs/corepack/pull/574
- Chromium --disable-gpu 与 backdrop-filter https://chromium.googlesource.com/chromium/src/+/5ff2d1bef3dd93aaf97ee01aff46719d3bb7114a
- backdrop-filter 提案 README https://github.com/mfreed7/backdrop-filter-feature/blob/master/README.md
- Chromium damage tracking 分析 https://nothing.graphics/docs/wg/research/chromium/damage-tracking
- SO Electron + Defender https://stackoverflow.com/questions/67982430
- SO 签名大 exe 打开慢 https://stackoverflow.com/questions/15475751/
- Gemini CLI Defender 冷启 https://github.com/google-gemini/gemini-cli/issues/19169