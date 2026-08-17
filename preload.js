const { contextBridge, ipcRenderer, webUtils } = require('electron');
// 视频扩展名列表：沙箱渲染进程无法 require 本地模块，故在此内联。
// 修改时务必同步 shared-video-exts.js（主进程用）与 package.json 的 fileAssociations。
const VIDEO_EXTS = [
  'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'ts',
  'rmvb', 'rm', '3gp', 'mpg', 'mpeg', 'm2ts', 'vob', 'ogv', 'f4v', 'm2v'
];

contextBridge.exposeInMainWorld('electronAPI', {
  // 支持的视频扩展名（不带点，供渲染进程拖拽/过滤判断）
  videoExtensions: VIDEO_EXTS,

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

  // 保存图片截图到本地（ArrayBuffer 载荷，避免大图 base64 膨胀）
  saveScreenshot: (data, defaultName) => ipcRenderer.invoke('dialog:saveScreenshot', { data, defaultName }),

  // 获取启动时双击/命令行传入的视频文件路径
  getInitialFile: () => ipcRenderer.invoke('app:getInitialFile'),

  // 监听软件运行中打开视频文件的事件（双击关联文件或 second-instance）
  onOpenFile: (callback) => {
    ipcRenderer.on('open-file', (event, filePath) => callback(filePath));
  },

  // 安全获取拖拽文件的物理路径（Electron 32+ 唯一官方方式）
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (err) {
      console.warn('webUtils.getPathForFile 提取路径失败:', err);
      return '';
    }
  },

  // 本地路径转 file:// URL（主进程用完整 Node 标准库转换；沙箱 preload 的 url 模块无 pathToFileURL）
  toFileUrl: (p) => {
    try {
      if (typeof p !== 'string' || !p) return '';
      return ipcRenderer.sendSync('path-to-url', p) || '';
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
