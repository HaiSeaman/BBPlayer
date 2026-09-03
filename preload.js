const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 幂等事件订阅：重复调用同一 API 时先解绑旧监听器，避免回调累积重复触发
function makeIdempotentSubscriber(channel) {
  let bound = null;
  return (callback) => {
    if (typeof callback !== 'function') return;
    if (bound) ipcRenderer.removeListener(channel, bound);
    bound = (event, ...args) => callback(...args);
    ipcRenderer.on(channel, bound);
  };
}

contextBridge.exposeInMainWorld('electronAPI', {
  // 获取媒体扩展名（单一来源：shared-video-exts.js → 主进程 IPC 下发），结构 { video, audio, all }
  getVideoExtensions: () => ipcRenderer.invoke('app:getVideoExtensions'),

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

  // 打开文件夹，返回 { files, truncated } 或 null（取消）
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),

  // 读取本地文本文件（字幕，主进程已做扩展名白名单 + 编码检测）
  readTextFile: (filePath) => ipcRenderer.invoke('file:readText', filePath),

  // 保存图片截图到本地（ArrayBuffer 载荷，避免大图 base64 膨胀）
  saveScreenshot: (data, defaultName) => ipcRenderer.invoke('dialog:saveScreenshot', { data, defaultName }),

  // 监听软件运行中打开视频文件的事件（双击关联文件或 second-instance；冷启动文件亦经此事件下发）
  onOpenFile: makeIdempotentSubscriber('open-file'),

  // 安全获取拖拽文件的物理路径（Electron 32+ 唯一官方方式）
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (err) {
      console.warn('webUtils.getPathForFile 提取路径失败:', err);
      return '';
    }
  },

  // 本地路径转 file:// URL（异步；主进程用完整 Node 标准库转换，避免 sendSync 阻塞渲染进程）
  toFileUrl: (p) => {
    if (typeof p !== 'string' || !p) return Promise.resolve('');
    return ipcRenderer.invoke('path-to-url', p).then((url) => url || '').catch(() => '');
  },

  // 查找音频文件同目录的封面图（cover.jpg/folder.jpg/同名图片），返回 file:// URL 或 null
  findCover: (filePath) => ipcRenderer.invoke('file:findCover', filePath),

  // 在独立新窗口播放指定视频（多视频同时播放）
  openInNewWindow: (filePath) => ipcRenderer.send('window:openInNewWindow', filePath),

  // 动态调整窗口适应视频尺寸比例
  resizeToVideo: (videoSize) => ipcRenderer.invoke('resize-window-to-video', videoSize),

  // 发送动态窗口拖拽请求
  moveWindow: (pos) => ipcRenderer.send('window-move', pos),

  // 监听窗口最小化与恢复
  onWindowMinimized: makeIdempotentSubscriber('window-minimized'),
  onWindowRestored: makeIdempotentSubscriber('window-restored')
});
