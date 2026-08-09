# 画面拖拽与工具栏 UI 透明化设计规格

## 1. 概述
针对 BBPlayer 进行 UX/UI 细节增强：
1. **画面左键拖动窗口**：在视频播放中或暂停/未加载视频时，按住播放器画面区域的鼠标左键均可流畅拖动整个应用程序窗口。
2. **工具栏透明化与按键高显眼度视觉重构**：
   - 将悬浮工具栏背景设为透明，同时保留现有的边框（`border: 1px solid var(--panel-border)`）与毛玻璃模糊滤镜。
   - 提高工具栏按钮的视觉对比度，使其显眼但不过分刺眼。

## 2. 画面左键拖拽设计 (Window Dragging Layer)

### 2.1 CSS 区域划分
- `#player-container` 以及 `#empty-state` 声明 `-webkit-app-region: drag;`。
- 所有需要响应鼠标交互的控件区域声明 `-webkit-app-region: no-drag;`，包括：
  - `#controls-overlay` 及其内部所有子元素（按钮、进度条、音量滑块、下拉菜单）。
  - `#titlebar` 中的窗口控制按钮 `.window-controls`。

### 2.2 单击/双击与拖拽交互解耦
- 在 Electron 中，当容器配置 `-webkit-app-region: drag` 时，底层系统会优先截获鼠标 `mousedown` 事件进行窗口拖拽。
- 为保证画面双击切换全屏与单击播放/暂停功能不受干扰，渲染进程将同时监听 JS 的拖拽感知与交互点击。

## 3. 透明工具栏与显眼按钮设计 (Transparent Overlay & Eye-Catching Controls)

### 3.1 悬浮胶囊工具栏面板 (`#controls-overlay`)
- `background: transparent;` 或包含极微弱微暗透明度（如 `rgba(0, 0, 0, 0.15)`），彻底消除厚的背景板块感。
- `border: 1px solid var(--panel-border);` （保留原精致微亮边框线）。
- `backdrop-filter: blur(20px) saturate(180%);`（保持视频画面的毛玻璃折射质感）。

### 3.2 工具按钮样式重构 (`.ctrl-btn`)
- **初始状态 (Default)**：
  - `background: rgba(255, 255, 255, 0.12);`
  - `border: 1px solid rgba(255, 255, 255, 0.18);`
  - `color: var(--text-primary);` （提升至纯白高对比度，增加显眼程度）。
- **悬停状态 (Hover)**：
  - `background: rgba(255, 255, 255, 0.25);`
  - `border-color: rgba(255, 255, 255, 0.35);`
  - `box-shadow: 0 0 10px rgba(255, 255, 255, 0.2);`
- **激活/选中状态 (Active)**：
  - `background: rgba(0, 242, 254, 0.2);`
  - `border-color: var(--accent-neon);`
  - `color: var(--accent-neon);`
  - `box-shadow: 0 0 12px rgba(0, 242, 254, 0.4);`
