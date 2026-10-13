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
  // 获取媒体扩展名（单一来源：shared-video-exts.js → 主进程 IPC 下发）。
  // 返回结构由 main.js 的 app:getVideoExtensions 决定：{ video, convertibleVideo, audio, all, nativeAll, subtitle }
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

  // 解码拖入字幕文件的原始字节（ArrayBuffer；与 readTextFile 共用主进程同一套编码嗅探实现）
  decodeSubtitleBuffer: (data) => ipcRenderer.invoke('file:decodeSubtitle', data),

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

  // 让内核播不了的格式（avi/flv/wmv/ts/rmvb 等）先转成能播的 MP4，返回可直接播放的 file:// URL。
  // 原生可播的格式也会经这里返回原文件的 file:// URL（统一入口，渲染端不必自己转换路径）。
  // force 只在运行时兜底时用：'transcode'（画面解不出）或 'audiofix'（音轨解不出）。
  prepareMedia: (filePath, force) => ipcRenderer.invoke('media:prepare', filePath, force || null),

  // 查询文件的容器/编码信息（运行时兜底据此判断是否需要转换、该转哪一档）
  probeMedia: (filePath) => ipcRenderer.invoke('media:probe', filePath),

  // 转换进度（换容器/换音频/重编码）
  onConvertProgress: makeIdempotentSubscriber('media:convert-progress'),

  // 转换失败原因（用于给出明确提示，而不是"点了没反应"）
  onConvertFailed: makeIdempotentSubscriber('media:convert-failed'),

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
