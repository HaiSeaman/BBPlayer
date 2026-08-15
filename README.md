# BBPlayer - 极简极速本地多媒体播放器

<div align="center">

![Electron](https://img.shields.io/badge/Electron-34.x-47848F?style=for-the-badge&logo=electron&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Cross--Platform-0078D6?style=for-the-badge&logo=windows&logoColor=white)
![License](https://img.shields.io/badge/License-ISC-blue.svg?style=for-the-badge)

**纯粹、轻量、高颜值的无边框现代桌面视频播放器**

[更新日志](#-最新更新日志) • [功能特性](#-功能特性) • [技术架构](#-技术架构) • [核心算法与方案](#-核心算法与方案) • [快速上手](#-快速上手) • [构建打包](#-构建打包)

</div>

---

## 📖 项目简介

**BBPlayer** 是一款专为桌面端打造的极简、轻量、高性能本地多媒体播放器。基于 **Electron + 原生 HTML5/CSS3/JavaScript (ES6+)** 纯手工精雕细琢，完全摒弃沉重庞大的前端第三方框架与冗余依赖。

软件融合了现代 **毛玻璃微晶拟物设计 (Frosted Glassmorphism)**、**发光霓虹交互 (Neon Glow)** 与 **无边界纯粹视觉**，在带来极致顺滑帧率表现的同时，提供如同原生系统组件般的优雅沉浸观影体验。

---

## 🆕 最新更新日志

### 📌 最新版本功能升级与体验改进

- **🎬 画面无缝贴合与零黑边**：
  - 播放视频时，窗口自动按视频原生分辨率与宽高比（Aspect Ratio）锁定，配合自适应渲染模式，彻底消除上下/左右黑边。
- **⏸️ 最小化智能自动暂停**：
  - 监听系统级窗口状态，视频播放中最小化到任务栏时自动暂停播放，恢复窗口时自动恢复播放，省心省电。
- **🖱️ 全局左键拖拽 + 单击播放/暂停双向兼容**：
  - 引入指针位移阀值算法（`> 4px`），在视频画面区域按住鼠标左键即可平滑拖动整个播放器窗口，单击则精准响应视频播放与暂停。
- **💎 沉浸式透明微晶工具栏**：
  - 悬浮胶囊控制面板升级为 `transparent` 透明毛玻璃质感，保留 1px 精致半透明白框；按键图标高亮发光并增强悬浮 Hover 动画。
- **🔀 播放模式语义化重构**：
  - 控制菜单与系统提示语统一重构为符合用户习惯的 **「循环播放」**、**「随机播放」**、**「单个循环」**，并保持模式状态记忆。
- **🛡️ 全量代码审查与底层健壮性提升**：
  - 修复 IPC 消息解构空防护、完善手势 `pointercancel` 事件泄漏保护、优化多屏环境坐标计算与时间字重可读性。

---

## ✨ 功能特性

### 1. 极致纯粹的视觉与交互
- **无边框沉浸视窗 (Frameless Glassmorphism)**：告别传统软件死板的标题栏，采用晶体通透设计；支持全域平滑拖拽移动与边缘缩放。
- **无黑边自适应比例**：窗口按视频比例锁定，画面完美贴合无残留边框。
- **沉浸透明悬浮 Dock 栏**：控制中心在鼠标移入时优雅淡入、移出自动隐匿；透明背景与高亮按键兼顾视觉美感与易用性。
- **多功能侧边抽屉**：精致毛玻璃抽屉式设计，收纳播放列表与观看历史（支持单条删除与一键清空）。
- **多选文件快速载入**：打开文件对话框支持一次选择多个视频加入播放列表。

### 2. 强大的媒体格式与播放控制
- **全格式视频广泛支持**：原生解码播放 MP4、MKV、WebM、MOV、AVI、FLV、TS、RMVB、3GP、M2TS、VOB、OGV 等格式。
- **多维度画面调节**：
  - **90° / 180° / 270° 画面自由旋转**，手机录制视频轻松矫正。
  - **画面多比例切换**：支持「自适应铺满 (Fit)」、「原始比例 (Original)」、「强制 16:9」、「强制 4:3」、「填充拉伸 (Stretch)」。
- **精准倍速调控**：预置 0.5x、0.75x、1.0x、1.25x、1.5x、2.0x、3.0x 极速切换，支持高帧率声调智能补偿（Preserves Pitch）。
- **智能记忆续播**：毫秒级本地存储记录播放断点，下次打开自动弹出续播 Toast。
- **多播放模式支持**：
  - 🔁 **循环播放**（全部视频循环播放，默认）：播放完当前视频自动按序切换下一集。
  - 🔀 **随机播放**（全部视频随机播放）：自动随机抽取下一曲目（排除当前曲目）。
  - 🔂 **单个循环**（单个视频循环播放）：适合单曲 MV、背景视频及特定片段单循环。

### 3. 专业字幕渲染引擎
- **多格式外挂字幕解析**：深度支持 **SRT、VTT、ASS、SSA** 等字幕格式。
- **全自动同名字幕关联**：拖入或打开视频时，自动检索同目录下同名外挂字幕文件。
- **字幕自由定制**：支持字幕字体大小（12px~48px 按键微调）、时间轴整体偏移（±60s 提前/延后）、背景遮罩与阴影发光，以及显示/隐藏全局切换。

### 4. 生产力与便捷工具
- **4K 原画无损截图**：基于底层 Canvas 矩阵变换与原生视频帧渲染，自动纠正旋转角度，一键导出 PNG 格式无损高清截图。
- **智能手势与滚轮调控**：在播放器视口内直接滑动鼠标滚轮即可平滑调节音量，展现发光 HUD。
- **快捷键系统**：
  - `Space`：播放 / 暂停
  - `←` / `→`：快退 5 秒 / 快进 5 秒
  - `↑` / `↓`：音量增减 5%
  - `F11` / `双击视口`：全屏 / 退出全屏
  - `M`：全局静音 / 恢复
  - `S`：瞬时无损截图

---

## 🛠️ 技术架构

```
BBPlayer/
├── main.js             # Electron 主进程 (窗口管理、IPC 路由、原生 AspectRatio 锁定)
├── preload.js          # 上下文隔离桥接 (ContextIsolation, 暴露安全受限的 window.electronAPI)
├── index.html          # 视图模板 (极简语义化结构、CSP 安全策略、毛玻璃 CSS 架构)
├── renderer.js         # 渲染进程核心控制器 (手势拖拽位移算法、字幕匹配引擎、播放状态机)
├── build/              # 应用图标与静态构建资源
└── package.json        # 项目元数据与 electron-builder 打包配置
```

---

## 🔬 核心算法与方案

### 1. 手势指针判别算法 (Pointer Drag-Click Classifier)
在视频画面上兼顾左键拖拽窗口与左键点击播放/暂停，Avoid 了 Electron 原生 `-webkit-app-region: drag` 对 DOM 点击事件的阻断：
```javascript
// 基于移动距离与阈值 (4px) 判别拖动与点击
const deltaX = Math.abs(currentX - startX);
const deltaY = Math.abs(currentY - startY);
if (deltaX > 4 || deltaY > 4) {
  isDraggingWindow = true;
  window.electronAPI.moveWindow({ x: newWindowX, y: newWindowY });
}
```

### 2. 窗口比例锁定算法 (Window Aspect Ratio Locking)
播放视频时，通过获取 `videoWidth` 与 `videoHeight` 动态计算比例，并向主进程发送句柄：
```javascript
const aspectRatio = width / height;
mainWindow.setAspectRatio(aspectRatio);
```

---

## 💎 核心优势

| 维度 | BBPlayer | 传统播放器 (如 PotPlayer/VLC) | 普通 Web 封装播放器 |
|---|---|---|---|
| **视觉颜值** | 现代极简、毛玻璃晶体、透明 Dock、Neon 呼吸发光 | 传统 Windows 面板，UI 繁琐陈旧 | 扁平粗糙，缺乏深度视觉 |
| **内存占用** | 纯原生 JS 驱动，无大型框架损耗 (~60MB 常驻) | 依赖大量传统动态库 | 携带大型框架 runtime，开销大 |
| **开箱即用** | 提供单文件绿色免安装版 (Portable)，即点即播 | 安装步骤冗长，需手动关联插件 | 依赖外部网络与复杂配置 |
| **交互质感** | 画面按拽移动窗口、最小化自动暂停、自动消除黑边 | 选项菜单层级过深，配置繁琐 | 交互响应存在微小卡顿 |

---

## 🚀 快速上手

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

本项目已集成 `electron-builder`，支持一键打包：

```bash
# 构建 Windows x64 平台安装包与便携单文件 EXE
npm run build
```

打包产物位于 `release-dist/` 目录下：
- **`BBPlayer 1.0.0.exe`**：单文件绿色免安装便携版（即开即用）。
- **`BBPlayer Setup 1.0.0.exe`**：标准 Windows 安装程序。

---

## 📄 开源许可证

本项目基于 [ISC License](./package.json) 开放源代码。
