# 视频画面拖拽与透明工具栏实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现播放器画面按住左键拖动窗口功能，并将工具栏视觉风格修改为透明背景、带亮色边框及微亮高对比度按钮。

**架构：** 在 `index.html` 的 CSS 样式中为视频容器与空状态区配置 `-webkit-app-region: drag;`，为其内部的控制元素与按钮组配置 `-webkit-app-region: no-drag;`。同时调整 `.ctrl-btn` 和 `#controls-overlay` 的面板背景与渐变样式。

**技术栈：** Electron, HTML5 CSS3 App Region, Vanilla JavaScript

---

### 任务 1：更新全屏与画面区域拖拽 CSS 属性及透明工具栏面板样式

**文件：**
- 修改：`index.html`

- [ ] **步骤 1：修改工具栏与画面的 CSS 样式**

```html
    /* 播放器主体容器 - 设为全屏拖拽区域 */
    #player-container {
      flex: 1;
      position: relative;
      background-color: #000;
      overflow: hidden;
      display: flex;
      justify-content: center;
      align-items: center;
      -webkit-app-region: drag;
    }

    /* 空状态区设为拖拽区域 */
    #empty-state {
      -webkit-app-region: drag;
    }

    /* 浮动工具栏面板 - 设置透明背景与禁止窗口拖拽 */
    #controls-overlay {
      position: absolute;
      bottom: 16px;
      left: 50%;
      transform: translateX(-50%);
      width: calc(100% - 32px);
      max-width: 860px;
      background: transparent;
      backdrop-filter: blur(20px) saturate(180%);
      border: 1px solid var(--panel-border);
      border-radius: 16px;
      padding: 12px 20px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      z-index: 30;
      transition: opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1), transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6);
      -webkit-app-region: no-drag;
    }

    /* 控制按钮高显眼度视觉 */
    .ctrl-btn {
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: #ffffff;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      border-radius: 8px;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      padding: 0;
      -webkit-app-region: no-drag;
    }

    .ctrl-btn:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.22);
      border-color: rgba(255, 255, 255, 0.35);
      transform: scale(1.05);
    }
```

- [ ] **步骤 2：验证应用启动并尝试拖动窗口**

运行：`npm start`
预期：左键按住画面任何区域均可流畅拖动播放器，控制栏背景透明、保留边框，按键视觉显眼。

- [ ] **步骤 3：Commit 代码**

```bash
git add index.html
git commit -m "feat: enable video drag-window and transparent overlay UI"
```
