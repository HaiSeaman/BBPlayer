const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// === 性能与内存优化标志设置 ===
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('disable-client-side-phishing-detection');
app.commandLine.appendSwitch('disable-default-apps');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.commandLine.appendSwitch('disable-extensions');
app.commandLine.appendSwitch('disable-sync');
app.commandLine.appendSwitch('disable-translate');
app.commandLine.appendSwitch('metrics-recording-only');

// GPU 硬件加速解码与省 CPU 设置
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

let mainWindow = null;

const videoExtensions = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.webm', '.m4v', '.ts',
  '.rmvb', '.rm', '.3gp', '.mpg', '.mpeg', '.m2ts', '.vob', '.ogv', '.f4v', '.m2v'
]);

function parseFilePathFromArgs(argv) {
  if (!argv || !Array.isArray(argv)) return null;
  // Windows下开发环境 Electron 命令行参数通常为：[electron.exe, ., path/to/file]
  // 打包后的生产环境为：[app.exe, path/to/file] 或包含各种开关参数
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg && !arg.startsWith('--')) {
      const ext = path.extname(arg).toLowerCase();
      if (videoExtensions.has(ext)) {
        try {
          if (fs.existsSync(arg)) {
            return path.resolve(arg);
          }
        } catch (e) {
          // ignore
        }
      }
    }
  }
  return null;
}

let initialFilePath = parseFilePathFromArgs(process.argv);

// 监听 macOS open-file 事件（在顶级运行环境暴露，确保启动早期接收）
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('open-file', filePath);
  } else {
    initialFilePath = filePath;
  }
});

// 防止多开应用（保证极轻开销）
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    const filePath = parseFilePathFromArgs(commandLine);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (filePath) {
        mainWindow.webContents.send('open-file', filePath);
      }
    } else if (filePath) {
      initialFilePath = filePath;
    }
  });
}

// === 窗口状态记忆（大小/位置，下次启动恢复） ===
const windowStateFile = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(windowStateFile, 'utf8'));
    if (typeof state.width === 'number' && typeof state.height === 'number') {
      // 校验窗口至少有一部分落在屏幕内，避免显示器变化后窗口恢复到屏幕外
      if (typeof state.x === 'number' && typeof state.y === 'number') {
        const wa = screen.getDisplayMatching({ x: state.x, y: state.y, width: state.width, height: state.height }).workArea;
        const visibleW = Math.min(state.x + state.width, wa.x + wa.width) - Math.max(state.x, wa.x);
        const visibleH = Math.min(state.y + state.height, wa.y + wa.height) - Math.max(state.y, wa.y);
        if (visibleW < 50 || visibleH < 50) {
          delete state.x;
          delete state.y;
        }
      }
      return state;
    }
  } catch (e) {
    // 首次运行或文件损坏，使用默认尺寸
  }
  return null;
}

function createWindow() {
  const savedState = loadWindowState();
  mainWindow = new BrowserWindow({
    width: (savedState && savedState.width) || 1000,
    height: (savedState && savedState.height) || 650,
    x: savedState ? savedState.x : undefined,
    y: savedState ? savedState.y : undefined,
    minWidth: 480,
    minHeight: 320,
    frame: false, // 默认无边框
    transparent: false,
    backgroundColor: '#08090C',
    title: 'BB Player',
    icon: path.join(__dirname, 'build/icon.png'),
    show: false, // 准备好之后再显示，避免闪烁
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false // 后台播放不卡顿
    }
  });

  mainWindow.loadFile('index.html');

  // 优雅加载
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 监听窗口最小化与恢复事件
  mainWindow.on('minimize', () => {
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('window-minimized');
    }
  });

  mainWindow.on('restore', () => {
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('window-restored');
    }
  });

  // 窗口大小/位置变化时保存状态（防抖，全屏时不记录）
  let stateSaveTimer = null;
  const scheduleStateSave = () => {
    if (!mainWindow || mainWindow.isFullScreen()) return;
    if (stateSaveTimer) clearTimeout(stateSaveTimer);
    stateSaveTimer = setTimeout(() => {
      try {
        fs.writeFileSync(windowStateFile, JSON.stringify(mainWindow.getBounds()), 'utf8');
      } catch (e) {
        // 忽略写入失败
      }
    }, 400);
  };
  mainWindow.on('resize', scheduleStateSave);
  mainWindow.on('move', scheduleStateSave);

  // 主窗口关闭事件处理
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 软件准备就绪
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// === IPC 原生窗口交互处理 ===
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

// 真正的全屏切换（区别于窗口最大化）
ipcMain.on('window-fullscreen', () => {
  if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
});

// 查询当前是否处于全屏状态（供 Esc 退出全屏）
ipcMain.handle('window:isFullScreen', () => {
  return mainWindow ? mainWindow.isFullScreen() : false;
});

// 获取应用冷启动时传入的文件路径
ipcMain.handle('app:getInitialFile', () => {
  const filePath = initialFilePath;
  initialFilePath = null;
  return filePath;
});

// 打开本地视频文件对话框
ipcMain.handle('dialog:openFile', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择本地视频文件',
    properties: ['openFile'],
    filters: [
      { name: '视频文件', extensions: ['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'webm', 'm4v', 'ts', 'rmvb', 'rm', '3gp', 'mpg', 'mpeg', 'm2ts', 'vob', 'ogv', 'f4v', 'm2v'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// 打开本地字幕文件对话框
ipcMain.handle('dialog:openSubtitle', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择外挂字幕文件',
    properties: ['openFile'],
    filters: [
      { name: '字幕文件', extensions: ['srt', 'vtt', 'ass'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// 打开整个文件夹，返回其中所有视频文件的绝对路径列表（支持安全深度递归）
async function scanDirectorySafe(dirPath, currentDepth = 0, maxDepth = 3, maxFiles = 500, collected = []) {
  if (currentDepth > maxDepth || collected.length >= maxFiles) return collected;
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (collected.length >= maxFiles) break;
      const fullPath = path.join(dirPath, entry.name);

      // 忽略隐藏文件夹、系统保护及常见的非媒体大目录
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '$RECYCLE.BIN' || entry.name === 'System Volume Information') {
        continue;
      }

      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink()) {
          await scanDirectorySafe(fullPath, currentDepth + 1, maxDepth, maxFiles, collected);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (videoExtensions.has(ext)) {
          collected.push(fullPath);
        }
      }
    }
  } catch (err) {
    console.warn(`扫描目录受限或跳过: ${dirPath}`, err);
  }
  return collected;
}

ipcMain.handle('dialog:openFolder', async () => {
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择视频文件夹',
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return [];
  const dir = result.filePaths[0];
  try {
    const files = await scanDirectorySafe(dir);
    return files.sort();
  } catch (err) {
    console.error('读取文件夹失败:', err);
    return [];
  }
});

// 读取本地文本文件（字幕），限制扩展名避免任意文件读取
const ALLOWED_SUBTITLE_EXTS = new Set(['.srt', '.vtt', '.ass', '.ssa', '.sub', '.lrc', '.txt']);

ipcMain.handle('file:readText', async (event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return null;
  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_SUBTITLE_EXTS.has(ext)) {
    console.warn(`阻止读取非字幕文本文件: ${filePath}`);
    return null;
  }
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (err) {
    console.error('读取字幕文件失败:', err);
    return null;
  }
});

// 导出保存高清截图到本地文件
ipcMain.handle('dialog:saveScreenshot', async (event, payload) => {
  if (!mainWindow) return false;
  // 兼容直接传 dataUrl 参数或传对象参数
  const dataUrl = typeof payload === 'string' ? payload : (payload ? payload.dataUrl : '');
  const defaultName = (typeof payload === 'object' && payload) ? payload.defaultName : '';
  if (!dataUrl) return false;
  
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存视频画面截图',
    defaultPath: defaultName || 'BBPlayer_Screenshot.png',
    filters: [{ name: 'PNG 图片', extensions: ['png'] }]
  });

  if (!result.canceled && result.filePath) {
    try {
      const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
      await fs.promises.writeFile(result.filePath, base64Data, 'base64');
      return true;
    } catch (err) {
      console.error('保存截图失败:', err);
      return false;
    }
  }
  return false;
});

// 监听渲染进程发来的视频分辨率，动态调整窗口大小与锁定宽高比（消除黑边）
ipcMain.handle('resize-window-to-video', (event, payload) => {
  if (!payload || typeof payload !== 'object') return false;
  const { width, height } = payload;
  if (!mainWindow || !width || !height) return false;

  // 0, 0 表示重置取消宽高比锁定
  if (width === 0 || height === 0) {
    mainWindow.setAspectRatio(0);
    return true;
  }

  const aspectRatio = width / height;
  mainWindow.setAspectRatio(aspectRatio);

  // 如果窗口处于全屏或最大化状态，不改变尺寸
  if (mainWindow.isFullScreen() || mainWindow.isMaximized()) {
    return true;
  }

  // 支持多显示器环境：获取窗口当前所在的显示器
  const currentBounds = mainWindow.getBounds();
  const currentDisplay = screen.getDisplayMatching(currentBounds);
  const { workArea } = currentDisplay;

  let targetWidth = Math.min(width, Math.round(workArea.width * 0.85));
  let targetHeight = Math.round(targetWidth / aspectRatio);

  if (targetHeight > workArea.height * 0.85) {
    targetHeight = Math.round(workArea.height * 0.85);
    targetWidth = Math.round(targetHeight * aspectRatio);
  }

  // 保持窗口比例的前提下确保不小于最小宽 480 像素
  const minWidth = 480;
  if (targetWidth < minWidth) {
    targetWidth = minWidth;
    targetHeight = Math.round(targetWidth / aspectRatio);
  }

  mainWindow.setSize(targetWidth, targetHeight);
  return true;
});

// 处理渲染进程发送的动态移动窗口请求
ipcMain.on('window-move', (event, payload) => {
  if (!payload || typeof payload !== 'object') return;
  const { x, y } = payload;
  if (!mainWindow || typeof x !== 'number' || typeof y !== 'number') return;
  mainWindow.setPosition(Math.round(x), Math.round(y));
});
