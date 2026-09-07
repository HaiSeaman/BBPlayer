# BBPlayer

<div align="center">

![Electron](https://img.shields.io/badge/Electron-34.x-47848F?style=for-the-badge&logo=electron&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)
![Version](https://img.shields.io/badge/Version-1.6.1-ff3b4e?style=for-the-badge)

**纯粹、轻量、高颜值的 Windows 无边框本地多媒体播放器**

[English](./README.md) | [简体中文](./README_CN.md)

[功能特性](#-功能特性) · [支持格式](#-支持格式) · [快捷键](#-快捷键) · [快速上手](#-快速上手) · [构建打包](#-构建打包) · [技术架构](#-技术架构) · [开源许可](#-开源许可)

</div>

---

## 📖 项目简介

**BBPlayer** 是一款基于 **Electron + 原生 HTML5/CSS3/JavaScript (ES6+)** 打造的极简、轻量本地多媒体播放器——无前端框架、运行时零 npm 依赖。

软件遵循 **"安静玻璃"** 设计哲学：让界面随时消失，画面本身才是主角。幽灵图标控制栏、全透明标题栏、唯一的彩虹品牌强调，加上极致的 GPU/CPU 预算控制（整个界面仅一处 `backdrop-filter`），带来沉浸式、原生般的影音体验。

> **一眼亮点** —— 多窗口同时播放、200% 音量增益（带防破音）、完整音乐模式（频谱可视化 + 封面环境光）、自研 SRT/VTT/ASS/SSA 字幕引擎（含 GBK 编码识别）、25 种关联媒体格式全彩虹文件图标。

---

## ✨ 功能特性

### 🖥️ 播放体验
- **无边框窗口 + 全透明标题栏**：文字与按键叠加自适应字影，在任意视频画面上清晰可读。
- **智能隐藏式 UI**：标题栏与功能栏从感应区滑入、鼠标移开立即收起；播放中 3 秒无操作自动隐藏兜底；空状态下窗口按键常驻可用。
- **按住拖动窗口**：视频画面与标题栏均可拖拽（单击 = 播放/暂停，双击画面 = 全屏；双击标题栏 = 最大化/还原）。
- **比例自动贴合**：窗口按视频分辨率锁定，消除黑边；手动拉伸即解除锁定。
- **彩虹品牌视觉**：渐变播放三角应用图标（任务栏 / EXE / 全部文件关联）、恒定色带彩虹进度条、透明底彩虹渐变播放键。

### 🎬 播放控制
- **多窗口播放**：任意视频可弹到独立窗口播放——播放列表悬停按钮、面板头部按钮、或运行中再次双击视频文件三种入口。
- **播放列表与观看历史**：拖拽/多选载入、剧集自然排序（`EP2` 排在 `EP10` 前）、断点续播记忆、三种播放模式（列表循环 / 随机 / 单个循环）。
- **精准倍速**：0.5x – 3.0x 预设，高帧率下声调智能补偿。
- **旋转与画面比例**：90°/180°/270° 旋转；自动 / 16:9 / 4:3 / 拉伸铺满。
- **4K 原画截图**：基于 Canvas 矩阵变换，自动纠正旋转角度，导出 PNG 无损高清截图。
- **智能续播**：自动记忆播放断点，重新打开时弹出续播提示。

### 🎵 音乐模式（纯音频文件）
载入音频文件时，播放器自动切换为音乐播放界面：
- **32 柱频谱可视化**：`AnalyserNode` 驱动（暂停即停，不空转耗电）。
- **封面自动查找**（`cover.jpg`、`folder.jpg` 或同名图片）。
- **环境光氛围**：背景渐变按封面主色采样生成，每首歌都有专属色调。

### 🔊 200% 音量增益
- Web Audio 管线（`MediaElementSource → GainNode → DynamicsCompressor → 输出`）突破浏览器 100% 音量上限——滑块、滚轮、方向键全支持 0–200%。
- 内置动态压缩器充当防破音"安全气囊"：逼近 −3dB 时自动柔和削峰，高增益下不破音；超过 100% 时滑块变橙色警示。

### 💬 字幕引擎
- **自研 SRT / VTT / ASS / SSA 解析器**（浏览器原生 `<track>` 无法处理 `file://` 路径与 ASS 格式）。
- **同名外挂字幕自动加载**：打开或拖入视频时自动检索同目录同名字幕；字幕也可与视频一起拖入。
- **编码识别**：BOM 嗅探 → UTF-8 严格解码 → GBK 回退——老式 ANSI 中文字幕不再乱码。
- **自由定制**：字号（12–48px）、时间轴整体偏移（±60s）、显示/隐藏切换。

### 🎨 外观
- **浅色 / 深色双主题**一键切换；语义化 CSS 变量保证两套主题下文字与控件始终清晰；主题选择自动记忆。
- 25 种媒体格式文件关联、单实例锁、窗口大小/位置记忆（含最大化状态）。

---

## 📂 支持格式

| 类型 | 格式 |
|---|---|
| **视频** | MP4 · MKV · AVI · MOV · WebM · FLV · WMV · M4V · TS · RMVB · RM · 3GP · MPG · MPEG · M2TS · VOB · OGV · F4V · M2V |
| **音频** | MP3 · FLAC · WAV · OGG · M4A · AAC |

全部解码由 Chromium 原生完成——零第三方解码器、零额外依赖。文件关联由安装包生成，双击任一关联文件即可直接用 BBPlayer 打开。

---

## ⌨️ 快捷键

| 按键 | 功能 |
|---|---|
| `Space` | 播放 / 暂停 |
| `←` / `→` | 快退 / 快进 5 秒 |
| `↑` / `↓` | 音量 ±5% |
| `F11` / 双击画面 | 全屏切换（`Esc` 退出） |
| `M` | 静音 / 恢复 |
| `S` | 截图 |

---

## 🚀 快速上手

### 下载使用（普通用户）
前往 [Releases](../../releases) 页面获取最新版本：
- **`BBPlayer Setup x.x.x.exe`** —— Windows 标准安装版。
- **`BBPlayer x.x.x.exe`** —— 单文件绿色免安装便携版。

### 源码运行（开发者）
```bash
git clone https://github.com/your-username/bb-player.git
cd bb-player
npm install
npm start
```

> 💡 小技巧：把视频文件直接拖到 `run-test.bat` 图标上，可立即启动开发版并播放。

---

## 🛠️ 构建打包

```bash
npm install        # 安装开发依赖（仅 electron + electron-builder）
npm run verify     # 一致性对账：共享扩展名列表 ↔ package.json 文件关联配置
npm run build      # 产出安装版 + 便携版到 release-dist/
```

构建产物（位于 `release-dist/`）：
- `BBPlayer Setup <版本号>.exe` —— NSIS 标准安装程序
- `BBPlayer <版本号>.exe` —— 便携版可执行文件

---

## 🏗️ 技术架构

```
BBPlayer/
├── main.js                 # 主进程：多窗口工厂、IPC 信任面、文件对话框、目录扫描
├── preload.js              # 上下文隔离桥接（contextBridge → window.electronAPI）
├── renderer.js             # 渲染层全部业务：播放状态机、字幕引擎、手势、频谱、主题
├── index.html              # 单文件视图：DOM + 全部 CSS（语义变量、双主题、彩虹色标）
├── shared-video-exts.js    # 单一事实来源：视频/音频扩展名列表
├── shared-subtitle-exts.js # 单一事实来源：字幕扩展名列表
├── verify-exts.js          # 一致性对账：共享列表 ↔ package.json 文件关联
├── build/                  # 应用图标（彩虹渐变播放三角，ico/png）
└── package.json            # 元数据 + electron-builder 配置
```

**设计原则**
- **运行时零依赖**——仅 `electron` 与 `electron-builder` 两个 devDependencies。
- **单文件渲染层**——每个窗口一份 `renderer.js`（约 2300 行），状态完全隔离。
- **加固的 IPC**——所有处理器经受信窗口集合校验发送方（`isTrustedSender`）；页面导航、`window.open` 与非顶层 frame 一律封死。
- **扩展名单一来源**——媒体/字幕扩展名列表收敛于共享模块，两进程经 IPC 共享，由 `npm run verify` 自动对账。

深入文档（显隐状态机、音频管线、令牌化竞态防护、版本变更明细）见 **[docs/DEVELOPER.md](./docs/DEVELOPER.md)**。

---

## 🤝 参与贡献

欢迎提交 Issue 与 Pull Request。提交前请：
1. 运行 `npm run verify` 并确保通过；
2. 通过 `run-test.bat`（或 `npm start`）运行软件，冒烟测试你的改动；
3. 遵守运行时零依赖纪律。

---

## 📄 开源许可

本项目基于 [MIT License](./LICENSE) 开放源代码。
