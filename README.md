# BBPlayer - 极简极速本地多媒体播放器

<div align="center">

![Electron](https://img.shields.io/badge/Electron-34.x-47848F?style=for-the-badge&logo=electron&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Cross--Platform-0078D6?style=for-the-badge&logo=windows&logoColor=white)
![License](https://img.shields.io/badge/License-ISC-blue.svg?style=for-the-badge)

**纯粹、轻量、高颜值的无边框现代桌面视频播放器**

[功能特性](#-功能特性) • [技术架构](#-技术架构) • [实现方案与核心算法](#-实现方案与核心算法) • [核心优势](#-核心优势) • [快速上手](#-快速上手) • [构建打包](#-构建打包)

</div>

---

## 📖 项目简介

**BBPlayer** 是一款专为桌面端打造的极简、轻量、高性能本地多媒体播放器。基于 **Electron + 原生 HTML5/CSS3/JavaScript (ES6+)** 纯手工精雕细琢，完全摒弃沉重庞大的前端第三方框架与冗余依赖。

软件融合了现代 **毛玻璃微晶拟物设计 (Frosted Glassmorphism)**、**发光霓虹交互 (Neon Glow)** 与 **无边界纯粹视觉**，在带来极致顺滑帧率表现的同时，提供如同原生系统组件般的优雅沉浸观影体验。

---

## ✨ 功能特性

### 1. 极致纯粹的视觉与交互
- **无边框沉浸视窗 (Frameless Glassmorphism)**：告别传统软件死板的标题栏，采用晶体通透设计；支持全域平滑拖拽移动与边缘缩放。
- **动态悬浮 Dock 栏**：控制中心在鼠标移入时优雅淡入、移出自动隐匿；底部进度条智能压缩为纤细发光状态，实现 100% 画面无遮挡。
- **自定义置顶与窗体模式**：一键置顶小窗播放（Picture-in-Picture 体验），边工作边看剧。
- **多功能侧边抽屉**：精致毛玻璃抽屉式设计，收纳播放列表、播放历史与核心设置，支持全屏下右侧边缘手势滑出。

### 2. 强大的媒体格式与播放控制
- **全格式视频广泛支持**：原生解码播放 MP4、MKV、WebM、MOV、AVI、FLV、TS、RMVB、3GP、M2TS、VOB、OGV 等格式。
- **多维度画面调节**：
  - **90° / 180° / 270° 画面自由旋转**，配合自适应画布比例重构，手机录制视频、竖屏视频轻松矫正。
  - **画面多比例切换**：支持「自适应铺满 (Fit)」、「原始比例 (Original)」、「强制 16:9」、「强制 4:3」、「填充拉伸 (Stretch)」。
  - **硬件加速图形滤镜**：实时可调节视频亮度（Brightness 50%~150%）与对比度（Contrast 50%~150%）。
- **精准倍速调控**：预置 0.5x、0.75x、1.0x、1.25x、1.5x、2.0x、3.0x 极速切换，支持高帧率声调智能补偿（Preserves Pitch）。
- **智能记忆续播**：毫秒级本地存储记录播放断点，下次打开自动弹出续播 Toast（智能规避片尾区间）。
- **多播放模式支持**：
  - 🔁 **列表循环**（全部视频循环播放，默认）：播放完当前视频自动按序切换下一集，末尾回到第一集。
  - 🔀 **随机播放**（全部视频随机播放）：自动在播放列表中不重复抽取下一曲目，享受随心体验。
  - 🔂 **单片循环**（单个视频循环播放）：适合单曲 MV、背景视频及特定片段单循环。
  - 支持快捷菜单一键切换与记忆保存，重启软件自动恢复上次的播放模式。

### 3. 专业字幕渲染引擎
- **多格式外挂字幕解析**：深度支持 **SRT、VTT、ASS、SSA、SUB、LRC** 等字幕格式。
- **全自动同名字幕关联**：拖入或打开视频时，底层自动检索同目录下同名外挂字幕文件并无缝装载。
- **字幕自由定制**：支持字幕字体大小（16px~64px 动态滑块调节）、文字描边、阴影发光及显示/隐藏全局切换。
- **高级 ASS 标签智能过滤**：内置正规化解析器，自动清洗 ASS 样式元标签与特效控制码，保证正文清晰呈现。

### 4. 生产力与便捷工具
- **4K 原画无损截图**：基于底层 Canvas 矩阵变换与原生视频帧渲染，自动纠正旋转角度，一键导出 PNG 格式无损高清截图。
- **智能手势与滚轮调控**：在播放器视口内直接滑动鼠标滚轮即可平滑调节音量，界面实时展示百分比发光 HUD。
- **全套工业级快捷键**：
  - `Space` / `K`：播放 / 暂停
  - `←` / `→`：快退 5 秒 / 快进 5 秒（带边界平滑保护）
  - `↑` / `↓`：音量递增 / 递减 5%
  - `F` / `双击视口`：全屏 / 退出全屏
  - `M`：全局静音 / 恢复
  - `T`：窗口置顶 / 取消置顶
  - `S`：瞬时无损截图
  - `C`：字幕显示 / 隐藏切换
  - `[` / `]`：上一集 / 下一集切换
  - `Esc`：退出全屏 / 关闭弹层

---

## 🛠️ 技术架构

```
BBPlayer/
├── main.js             # Electron 主进程 (生命周期、无边框窗体、安全 IPC 通信、文件系统递归扫描)
├── preload.js          # 上下文隔离桥接 (ContextIsolation, 暴露安全受限的 window.electronAPI)
├── index.html          # 视图模板 (极简语义化结构、CSP 安全策略、毛玻璃 CSS 样式架构)
├── renderer.js         # 渲染进程核心控制器 (零依赖 原生 JS 状态机、字幕引擎、播放管道、Canvas)
├── generate_icon.py    # 矢量图标生成器 (自动化构建高清 ICO 资源)
├── build/              # 应用图标与静态构建资源
└── package.json        # 项目元数据与 electron-builder 多平台打包配置
```

### 进程模型与安全隔离
- **Context Isolation (上下文隔离)**：严格开启 `contextIsolation: true` 与 `nodeIntegration: false`。
- **安全白名单 IPC 通信**：渲染进程无法直接调用 Node.js 底层系统 API，仅能通过预定义的 IPC 通道（如 `window:minimize`、`file:readText`、`dialog:openFiles`）进行通信。
- **CSP 策略防御**：全页面注入 `Content-Security-Policy`，杜绝一切外部恶意脚本注入。

---

## 🔬 实现方案与核心算法

### 1. 二分查找 + 局部回溯字幕检索算法 ($O(\log N)$)
针对数万行超长电影/剧集字幕的高频触发场景（`timeupdate` 事件每秒触发 4~5 次），BBPlayer 自研了轻量级时间轴匹配引擎：
- 采用 **二分搜索 (Binary Search)** 在已排序的时间轴区间快速锁定当前播放时间点。
- 结合 **向前局部回溯扫描** 机制，完美兼容同时间段内多行字幕同时出现（重叠字幕）的复杂场景。
- 引入 **差量脏检查 (Dirty Checking)**：当前后两帧字幕内容一致时直接跳过 DOM 操作，将字幕重绘开销降至极限。

### 2. 多重容错视频源加载管道 (Dual-Pipeline Media Loader)
- **优先通道**：通过 Electron 主进程原生句柄获取真实物理路径，支持同名外挂字幕的即时关联与断点记录。
- **兜底通道**：在浏览器或降级沙箱环境中，自动创建 `URL.createObjectURL(blob)`；在视频切换或销毁时主动执行 `revokeObjectURL`，彻底根除桌面应用长时间播放的内存泄漏隐患。

### 3. 无损截图矩阵变换算法 (Lossless Screenshot Engine)
当视频处于 **90° 或 270° 旋转状态** 时，直接截取视频元素会导致画面拉伸变形与分辨率不符。BBPlayer 通过 Canvas 2D 进行底层仿射变换：
```javascript
// 针对 90/270 度旋转，动态互换画布宽高并应用旋转平移变换
if (currentRotation === 90) {
  ctx.translate(canvas.width, 0);
  ctx.rotate((90 * Math.PI) / 180);
} else if (currentRotation === 270) {
  ctx.translate(0, canvas.height);
  ctx.rotate((270 * Math.PI) / 180);
}
ctx.drawImage(video, 0, 0, naturalWidth, naturalHeight);
```

### 4. 深度保护的异步文件遍历器 (Safe Directory Scanner)
在拖入或选择包含庞大文件的目录时，采用限制最大遍历深度（Depth $\le 4$）与最大收集文件数（Max $\le 1000$）的防御机制，自动忽略隐藏目录与 `node_modules`，防止符号链接环路与系统 I/O 阻塞主事件循环。

---

## 💎 核心优势

| 维度 | BBPlayer | 传统播放器 (如 PotPlayer/VLC) | 普通 Web 封装播放器 |
|---|---|---|---|
| **视觉颜值** | 现代极简、毛玻璃晶体、悬浮 Dock、Neon 呼吸发光 | 传统 Windows 98/XP 风格面板，UI 繁琐陈旧 | 扁平粗糙，缺乏深度视觉 |
| **内存占用** | 纯原生 JS 驱动，无大型框架损耗 (~60MB 常驻) | 依赖大量传统动态库 | 携带 React/Vue 运行时，内存开销大 |
| **开箱即用** | 提供单文件绿色免安装版 (Portable)，即点即播 | 安装步骤冗长，需手动关联插件 | 依赖外部网络与复杂配置 |
| **交互质感** | 全域无缝拖拽、单击防抖、智能滚轮调音、片尾智能识别 | 选项菜单层级过深，配置繁琐 | 交互响应存在微小卡顿 |
| **扩展性与安全** | 完备的 CSP 头防护与 IPC 扩展名白名单 | 插件机制存在安全隐患 | 安全隔离不彻底 |

---

## 🚀 快速上手

### 环境准备
- [Node.js](https://nodejs.org/) (建议 `v18.0.0` 或更高版本)
- [npm](https://www.npmjs.com/) 或 `yarn` / `pnpm`

### 本地运行

```bash
# 1. 克隆代码仓库
git clone https://github.com/your-username/bb-player.git
cd bb-player

# 2. 安装项目依赖
npm install

# 3. 启动开发环境
npm start
```

---

## 📦 构建打包

本项目已集成 `electron-builder`，支持一键构建绿色免安装版与安装包：

```bash
# 构建 Windows x64 平台安装包与便携单文件 EXE
npm run build
```

打包完成后，产物将生成在 `release-dist/` 目录下：
- **`BBPlayer 1.0.0.exe`**：单文件绿色免安装便携版（推荐，即开即用）。
- **`BBPlayer Setup 1.0.0.exe`**：标准 Windows 安装程序（包含快捷方式与文件关联）。

---

## 📄 开源许可证

本项目基于 [ISC License](./package.json) 开放源代码。
