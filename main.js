const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// === 性能与内存优化标志设置（后台节流由 webPreferences.backgroundThrottling:false 统一控制） ===
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('disable-extensions');

// === 多窗口支持：主窗口 + 若干“新窗口”弹窗，每个视频可独立窗口并发播放 ===
let mainWindow = null; // 主窗口引用（second-instance 路由与窗口状态记忆使用）
const playerWindows = new Set(); // 全部受信任播放器窗口（主窗口 + 新窗口弹窗），IPC 信任面

const VIDEO_EXTS = require('./shared-video-exts');
const videoExtensions = new Set(VIDEO_EXTS.map(ext => '.' + ext));

function parseFilePathFromArgs(argv) {
  if (!argv || !Array.isArray(argv)) return null;
  // Windows下开发环境 Electron 命令行参数通常为：[electron.exe, ., path/to/file]
  // 打包后的生产环境为：[app.exe, path/to/file] 或包含各种开关参数
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg && !arg.startsWith('--')) {
      const ext = path.extname(arg).toLowerCase();
      if (videoExtensions.has(ext) && fs.existsSync(arg)) {
        return path.resolve(arg);
      }
    }
  }
  return null;
}

let initialFilePath = parseFilePathFromArgs(process.argv);

// 防止多开应用（保证极轻开销）
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    // 运行中再次打开视频文件：直接在独立新窗口播放，实现多视频同时播放；
    // 无文件参数（如重复双击 exe）则聚焦现有主窗口
    const filePath = parseFilePathFromArgs(commandLine);
    if (filePath) {
      createPlayerWindow({ isMain: false, initialFile: filePath });
      return;
    }
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
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

// 播放器窗口工厂：主窗口与“新窗口”弹窗共用同一套无边框窗口/事件逻辑。
// isMain 决定是否记忆窗口状态；initialFile 为弹窗指定立即播放的文件。
function createPlayerWindow(options = {}) {
  const { isMain = false, initialFile = null } = options;
  const savedState = isMain ? loadWindowState() : null;

  const win = new BrowserWindow({
    width: (savedState && savedState.width) || 1000,
    height: (savedState && savedState.height) || 650,
    x: savedState ? savedState.x : undefined,
    y: savedState ? savedState.y : undefined,
    minWidth: 480,
    minHeight: 320,
    frame: false, // 默认无边框
    transparent: false,
    backgroundColor: '#08090C',
    title: 'BBPlayer',
    icon: path.join(__dirname, 'build/icon.png'),
    show: false, // 准备好之后再显示，避免闪烁
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false // 后台播放不卡顿
    }
  });

  // 新窗口默认在主窗口右下 40px 级联偏移，避免与主窗口完全重叠；
  // 钳制在所在显示器工作区内，防止主窗口靠边/最大化时把新窗口挤出屏幕
  if (!isMain) {
    const ref = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow.getBounds() : null;
    if (ref) {
      const [w, h] = win.getSize();
      const wa = screen.getDisplayMatching(ref).workArea;
      const x = Math.max(wa.x, Math.min(ref.x + 40, wa.x + wa.width - Math.min(w, wa.width)));
      const y = Math.max(wa.y, Math.min(ref.y + 40, wa.y + wa.height - Math.min(h, wa.height)));
      win.setPosition(Math.round(x), Math.round(y));
    }
  }

  // 纳入 IPC 信任面，窗口关闭时移除
  playerWindows.add(win);
  win.on('closed', () => {
    playerWindows.delete(win);
    if (isMain) mainWindow = null;
  });

  win.loadFile('index.html');

  // 渲染进程加载完成后推送初始文件（弹窗直接播该文件；主窗口取冷启动/运行中传入的文件）
  win.webContents.on('did-finish-load', () => {
    if (initialFile) {
      win.webContents.send('open-file', initialFile);
    } else if (isMain && initialFilePath) {
      win.webContents.send('open-file', initialFilePath);
      initialFilePath = null;
    }
  });

  // 安全防护：禁止页面打开新窗口与跳转外部导航
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // 优雅加载
  win.once('ready-to-show', () => {
    win.show();
  });

  // 监听窗口最小化与恢复事件（渲染进程据此自动暂停/续播）
  win.on('minimize', () => {
    if (win && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('window-minimized');
    }
  });

  win.on('restore', () => {
    if (win && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('window-restored');
    }
  });

  // 用户手动拖拽窗口边缘时解除视频宽高比锁定（程序化 setSize 不触发 will-resize，
  // 因此换片自动贴合不受影响）；下次加载新视频时会重新锁定
  win.on('will-resize', () => {
    if (win && !win.isDestroyed()) {
      win.setAspectRatio(0);
    }
  });

  // 仅主窗口记忆窗口大小/位置（弹窗每次级联展开，不做持久化）
  if (isMain) {
    // 窗口大小/位置变化时保存状态（防抖，全屏时不记录）
    let stateSaveTimer = null;
    const scheduleStateSave = () => {
      if (!win || win.isDestroyed() || win.isFullScreen()) return;
      if (stateSaveTimer) clearTimeout(stateSaveTimer);
      stateSaveTimer = setTimeout(() => {
        try {
          fs.writeFileSync(windowStateFile, JSON.stringify(win.getBounds()), 'utf8');
        } catch (e) {
          // 忽略写入失败
        }
      }, 400);
    };
    win.on('resize', scheduleStateSave);
    win.on('move', scheduleStateSave);

    // 关闭前取消挂起的防抖保存并强制落盘一次（避免最后一次移动/缩放丢失）
    win.on('close', () => {
      if (stateSaveTimer) {
        clearTimeout(stateSaveTimer);
        stateSaveTimer = null;
      }
      if (win && !win.isDestroyed() && !win.isFullScreen()) {
        try {
          fs.writeFileSync(windowStateFile, JSON.stringify(win.getBounds()), 'utf8');
        } catch (e) {
          // 忽略写入失败
        }
      }
    });
  }

  return win;
}

// 由 IPC 事件定位发起该调用的窗口（各播放器窗口相互独立）
function windowOf(event) {
  if (!event || !event.sender) return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  return (win && !win.isDestroyed()) ? win : null;
}

// === IPC 安全防护：仅接受受信任播放器窗口的顶层渲染进程调用 ===
function isTrustedSender(event) {
  if (!event || !event.sender || !event.senderFrame) return false;
  if (event.senderFrame !== event.sender.mainFrame) return false; // 仅接受顶层 frame
  const win = windowOf(event);
  return !!(win && playerWindows.has(win));
}

// 软件准备就绪
app.whenReady().then(() => {
  mainWindow = createPlayerWindow({ isMain: true });
});

app.on('window-all-closed', () => {
  app.quit();
});

// === IPC 原生窗口交互处理（作用于发起窗口自身，多窗口各自独立） ===
ipcMain.on('window-minimize', (event) => {
  if (!isTrustedSender(event)) return;
  const win = windowOf(event);
  if (win) win.minimize();
});

ipcMain.on('window-maximize', (event) => {
  if (!isTrustedSender(event)) return;
  const win = windowOf(event);
  if (win) {
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  }
});

ipcMain.on('window-close', (event) => {
  if (!isTrustedSender(event)) return;
  const win = windowOf(event);
  if (win) win.close();
});

// 真正的全屏切换（区别于窗口最大化）
ipcMain.on('window-fullscreen', (event) => {
  if (!isTrustedSender(event)) return;
  const win = windowOf(event);
  if (win) win.setFullScreen(!win.isFullScreen());
});

// 查询当前是否处于全屏状态（供 Esc 退出全屏）
ipcMain.handle('window:isFullScreen', (event) => {
  if (!isTrustedSender(event)) return false;
  const win = windowOf(event);
  return win ? win.isFullScreen() : false;
});

// 在独立新窗口播放指定视频（多视频同时播放的核心入口）
ipcMain.on('window:openInNewWindow', (event, filePath) => {
  if (!isTrustedSender(event)) return;
  if (typeof filePath !== 'string' || !filePath) return;
  const abs = path.resolve(filePath);
  const ext = path.extname(abs).toLowerCase();
  if (!videoExtensions.has(ext) || !fs.existsSync(abs)) return;
  createPlayerWindow({ isMain: false, initialFile: abs });
});

// 本地路径转 file:// URL（沙箱 preload 的 url 模块无 pathToFileURL，由主进程用完整标准库转换）
const { pathToFileURL } = require('url');

ipcMain.handle('path-to-url', (event, filePath) => {
  let url = '';
  if (isTrustedSender(event) && typeof filePath === 'string' && filePath) {
    try {
      url = pathToFileURL(filePath).href;
    } catch (err) {
      console.warn('pathToFileURL 转换失败:', filePath, err);
    }
  }
  return url;
});

// 获取应用冷启动时传入的文件路径
ipcMain.handle('app:getInitialFile', (event) => {
  if (!isTrustedSender(event)) return null;
  const filePath = initialFilePath;
  initialFilePath = null;
  return filePath;
});

// 打开本地视频文件对话框（支持多选）
ipcMain.handle('dialog:openFile', async (event) => {
  const win = windowOf(event);
  if (!win || !isTrustedSender(event)) return null;
  const result = await dialog.showOpenDialog(win, {
    title: '选择本地视频文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '视频文件', extensions: VIDEO_EXTS },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths;
  }
  return null;
});

// 打开本地字幕文件对话框
ipcMain.handle('dialog:openSubtitle', async (event) => {
  const win = windowOf(event);
  if (!win || !isTrustedSender(event)) return null;
  const result = await dialog.showOpenDialog(win, {
    title: '选择外挂字幕文件',
    properties: ['openFile'],
    filters: [
      { name: '字幕文件', extensions: ['srt', 'vtt', 'ass', 'ssa'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// 打开整个文件夹，返回其中所有视频文件的绝对路径列表（支持安全深度递归）
// 返回 { files, truncated }：truncated 表示达到 maxFiles 上限被截断，由渲染进程提示用户
async function scanDirectorySafe(dirPath, currentDepth = 0, maxDepth = 3, maxFiles = 500) {
  const collected = [];
  let truncated = false;

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (collected.length >= maxFiles) {
          truncated = true; // 还有条目没收完即触顶，标记截断
          break;
        }
        const fullPath = path.join(dir, entry.name);

        // 忽略隐藏文件夹、系统保护及常见的非媒体大目录
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '$RECYCLE.BIN' || entry.name === 'System Volume Information') {
          continue;
        }

        if (entry.isDirectory()) {
          if (!entry.isSymbolicLink()) {
            await walk(fullPath, depth + 1);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (videoExtensions.has(ext)) {
            collected.push(fullPath);
          }
        }
      }
    } catch (err) {
      console.warn(`扫描目录受限或跳过: ${dir}`, err);
    }
  }

  await walk(dirPath, currentDepth);
  return { files: collected, truncated };
}

ipcMain.handle('dialog:openFolder', async (event) => {
  const win = windowOf(event);
  if (!win || !isTrustedSender(event)) return null;
  const result = await dialog.showOpenDialog(win, {
    title: '选择视频文件夹',
    properties: ['openDirectory']
  });
  // 用户取消返回 null（区别于空结果），由渲染进程分别提示
  if (result.canceled || result.filePaths.length === 0) return null;
  const dir = result.filePaths[0];
  try {
    const { files, truncated } = await scanDirectorySafe(dir);
    // 自然排序：EP2 排在 EP10 之前（普通字典序会导致两位数集数乱序）
    files.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
    return { files, truncated };
  } catch (err) {
    console.error('读取文件夹失败:', err);
    return { files: [], truncated: false };
  }
});

// 读取本地文本文件（字幕），限制扩展名避免任意文件读取
const ALLOWED_SUBTITLE_EXTS = new Set(['.srt', '.vtt', '.ass', '.ssa']);
const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024; // 10MB，防止误选超大文件撑爆内存

// 字幕编码嗅探：BOM 识别 → UTF-8 严格解码 → GBK 回退。
// 覆盖中文环境最常见的 ANSI(GBK) 老字幕；与 renderer.js 中拖拽路径的 decodeSubtitleBuffer 保持同步。
function decodeSubtitleBuffer(buf) {
  if (!buf || buf.length === 0) return '';
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  }
  // UTF-16 LE / BE BOM（Windows 记事本"Unicode"导出常见）
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    return new TextDecoder('utf-16be').decode(buf.subarray(2));
  }
  // 无 BOM：先按 UTF-8 严格模式解码（非法字节序列即抛错），失败回退 GBK
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch (e2) {
      return buf.toString('latin1'); // 终极兜底，至少不抛异常
    }
  }
}

ipcMain.handle('file:readText', async (event, filePath) => {
  if (!isTrustedSender(event)) return null;
  if (typeof filePath !== 'string' || !filePath) return null;
  const ext = path.extname(filePath).toLowerCase();
  if (!ALLOWED_SUBTITLE_EXTS.has(ext)) {
    console.warn(`阻止读取非字幕文本文件: ${filePath}`);
    return null;
  }
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_SUBTITLE_BYTES) {
      console.warn(`字幕文件过大(${stat.size}字节)，拒绝读取: ${filePath}`);
      return null;
    }
    const buf = await fs.promises.readFile(filePath); // Buffer，交由解码器处理编码
    return decodeSubtitleBuffer(buf);
  } catch (err) {
    // ENOENT 是"同名字幕不存在"的常规情况（自动加载字幕必经路径），无需告警
    if (!err || err.code !== 'ENOENT') {
      console.error('读取字幕文件失败:', err);
    }
    return null;
  }
});

// 导出保存高清截图到本地文件（渲染进程固定以 ArrayBuffer 载荷传输，避免大图 base64 膨胀）
ipcMain.handle('dialog:saveScreenshot', async (event, payload) => {
  const win = windowOf(event);
  if (!win || !isTrustedSender(event)) return false;
  if (!payload || typeof payload !== 'object' || !(payload.data instanceof ArrayBuffer)) return false;
  const { data, defaultName } = payload;

  const result = await dialog.showSaveDialog(win, {
    title: '保存视频画面截图',
    defaultPath: defaultName || 'BBPlayer_Screenshot.png',
    filters: [{ name: 'PNG 图片', extensions: ['png'] }]
  });

  if (!result.canceled && result.filePath) {
    try {
      await fs.promises.writeFile(result.filePath, Buffer.from(data));
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
  if (!isTrustedSender(event)) return false;
  const win = windowOf(event);
  if (!win) return false;
  if (!payload || typeof payload !== 'object') return false;
  const { width, height } = payload;
  if (typeof width !== 'number' || typeof height !== 'number' || !isFinite(width) || !isFinite(height)) return false;
  if (width <= 0 || height <= 0) return false;

  const aspectRatio = width / height;

  // 如果窗口处于全屏或最大化状态，不改变尺寸（比例锁保留，退出后仍贴合视频）
  if (win.isFullScreen() || win.isMaximized()) {
    win.setAspectRatio(aspectRatio);
    return true;
  }

  // 支持多显示器环境：获取窗口当前所在的显示器
  const currentBounds = win.getBounds();
  const currentDisplay = screen.getDisplayMatching(currentBounds);
  const { workArea } = currentDisplay;
  const maxWidth = Math.round(workArea.width * 0.85);
  const maxHeight = Math.round(workArea.height * 0.85);

  // 先按视频原始尺寸适配 85% 工作区（宽高双向收敛）
  let targetWidth = Math.min(width, maxWidth);
  let targetHeight = Math.round(targetWidth / aspectRatio);
  if (targetHeight > maxHeight) {
    targetHeight = maxHeight;
    targetWidth = Math.round(targetHeight * aspectRatio);
  }

  let lockAspect = true;
  // 过窄时以最小宽度补偿；若补偿导致高度超限（极端竖屏视频），优先保证不溢出屏幕并解除比例锁
  const minWidth = 480;
  if (targetWidth < minWidth) {
    targetWidth = minWidth;
    targetHeight = Math.round(targetWidth / aspectRatio);
    if (targetHeight > maxHeight) {
      targetHeight = maxHeight;
      lockAspect = false;
    }
  }

  win.setAspectRatio(lockAspect ? aspectRatio : 0); // setAspectRatio(0) 取消锁定
  win.setSize(targetWidth, targetHeight);
  return true;
});

// 处理渲染进程发送的动态移动窗口请求（约束在全部显示器并集内，避免拖出屏幕无法找回）
ipcMain.on('window-move', (event, payload) => {
  if (!isTrustedSender(event)) return;
  const win = windowOf(event);
  if (!win) return;
  if (!payload || typeof payload !== 'object') return;
  const { x, y } = payload;
  if (typeof x !== 'number' || typeof y !== 'number') return;
  if (win.isFullScreen()) return; // 全屏状态下禁止拖动窗口

  const bounds = win.getBounds();
  const displays = screen.getAllDisplays().map(d => d.workArea);
  const left = Math.min(...displays.map(d => d.x));
  const top = Math.min(...displays.map(d => d.y));
  const right = Math.max(...displays.map(d => d.x + d.width));
  const bottom = Math.max(...displays.map(d => d.y + d.height));
  // 允许跨屏自由拖动，但窗口至少保留 40px 可抓取区域在所有屏幕并集内
  const nx = Math.min(Math.max(x, left - bounds.width + 40), right - 40);
  const ny = Math.min(Math.max(y, top), bottom - 40);
  win.setPosition(Math.round(nx), Math.round(ny));
});
