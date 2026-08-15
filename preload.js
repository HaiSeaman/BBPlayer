const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { pathToFileURL } = require('url');

contextBridge.exposeInMainWorld('electronAPI', {
  // 窗口控制
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  // 真正全屏切换（区别于最大化）
  fullscreenWindow: () => ipcRenderer.send('window-fullscreen'),

  // 查询当前是否全屏
  isFullScreen: () => ipcRenderer.invoke('window:isFullScreen'),

  // 打开本地文件选择框
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),

  // 打开本地字幕文件选择框
  openSubtitleDialog: () => ipcRenderer.invoke('dialog:openSubtitle'),

  // 打开文件夹，返回其中所有视频文件路径数组
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),

  // 读取本地文本文件（字幕，主进程已做扩展名白名单）
  readTextFile: (filePath) => ipcRenderer.invoke('file:readText', filePath),

  // 保存图片截图到本地（支持 ArrayBuffer / dataURL 两种载荷）
  saveScreenshot: (data, defaultName) => ipcRenderer.invoke('dialog:saveScreenshot', { data, defaultName }),

  // 获取启动时双击/命令行传入的视频文件路径
  getInitialFile: () => ipcRenderer.invoke('app:getInitialFile'),

  // 监听软件运行中打开视频文件的事件（双击关联文件或 second-instance）
  onOpenFile: (callback) => {
    ipcRenderer.on('open-file', (event, filePath) => callback(filePath));
  },

  // 安全获取拖拽文件的物理路径
  getFilePath: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch (err) {
      console.warn('webUtils.getPathForFile 提取路径失败:', err);
    }
    return file ? (file.path || '') : '';
  },

  // 本地路径转 file:// URL（标准 percent 编码，正确处理空格/中文/#/?/%/UNC 等特殊路径）
  toFileUrl: (p) => {
    try {
      if (typeof p !== 'string' || !p) return '';
      return pathToFileURL(p).href;
    } catch (err) {
      console.warn('toFileUrl 转换失败:', err);
      return '';
    }
  },

  // 动态调整窗口适应视频尺寸比例
  resizeToVideo: (videoSize) => ipcRenderer.invoke('resize-window-to-video', videoSize),

  // 发送动态窗口拖拽请求
  moveWindow: (pos) => ipcRenderer.send('window-move', pos),

  // 监听窗口最小化与恢复
  onWindowMinimized: (callback) => {
    ipcRenderer.on('window-minimized', () => callback());
  },
  onWindowRestored: (callback) => {
    ipcRenderer.on('window-restored', () => callback());
  }
});
