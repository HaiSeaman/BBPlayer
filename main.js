const { app, BrowserWindow, ipcMain, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');   // 本地路径转 file:// URL（仅 file:findCover 使用）

// === 主进程兜底：未捕获异常不再让整个播放器直接崩溃退出 ===
// 播放器是长驻的单窗口应用，任何一处 IPC 回调意外抛错都不该带走用户正在看的视频；
// 记录后继续运行，比 Node 默认的"直接退出进程"更符合本地播放器的取舍。
process.on('uncaughtException', (err) => {
  console.error('[BBPlayer] 主进程未捕获异常（已拦截，进程继续）:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[BBPlayer] 主进程未处理的 Promise 拒绝（已拦截）:', reason);
});

// === 性能与内存优化标志设置（后台节流由 webPreferences.backgroundThrottling:false 统一控制） ===
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('disable-extensions');

// === 多窗口支持：主窗口 + 若干“新窗口”弹窗，每个视频可独立窗口并发播放 ===
let mainWindow = null; // 主窗口引用（second-instance 路由与窗口状态记忆使用）
const playerWindows = new Set(); // 全部受信任播放器窗口（主窗口 + 新窗口弹窗），IPC 信任面

// 显示/唤起主窗口（最小化时恢复）；已销毁则重建
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createPlayerWindow({ isMain: true });
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

const VIDEO_EXTS = require('./shared-video-exts');
const SUBTITLE_EXTS = require('./shared-subtitle-exts'); // 字幕扩展名单一来源（与渲染端共享）
const videoExtensions = new Set(VIDEO_EXTS.all.map(ext => '.' + ext));

// === 媒体兼容层：内置 FFmpeg，把内核打不开的格式（avi/flv/wmv/ts/rmvb/rm/mpg/mpeg/m2ts/vob/m2v）
// 三档处理后喂给同一个 <video>：能播就不动、只差容器就换壳（秒级）、编码不行才重编码。
// 决策规则与实测数据见 docs/FORMAT-EXPANSION-REPORT.md；缺 ffmpeg 时自动降级（这些文件仍会播失败并如实提示）。
const converter = require('./converter');
const updater = require('./updater'); // 启动时静默检查 GitHub 新版本（无更新不打扰）
converter.configure({
  ffmpegPath: app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')   // 打包后由 extraResources 放到 resources/ffmpeg
    : path.join(__dirname, 'vendor', 'ffmpeg', 'ffmpeg.exe'),
  cacheDir: path.join(app.getPath('temp'), 'BBPlayer-convert')
});

// 解析命令行/"打开方式"传入的媒体文件路径（支持一次多个文件，按序返回绝对路径数组）。
// Windows 下开发环境 Electron 命令行参数通常为：[electron.exe, ., path/to/file]
// 打包后的生产环境为：[app.exe, path/to/file] 或包含各种开关参数
function parseFilePathFromArgs(argv) {
  if (!argv || !Array.isArray(argv)) return [];
  const results = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg && !arg.startsWith('--')) {
      const ext = path.extname(arg).toLowerCase();
      if (videoExtensions.has(ext) && fs.existsSync(arg)) {
        results.push(path.resolve(arg));
      }
    }
  }
  return results;
}

let initialFilePaths = parseFilePathFromArgs(process.argv); // 冷启动传入的媒体文件（数组，可为空）

// 防止多开应用（保证极轻开销）
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    // 运行中再次打开视频文件：多文件逐个开独立窗口播放（复用现有新窗口机制，天然处理加载时序）；
    // 无文件参数（如重复双击 exe）则唤起/显示主窗口（最小化时也恢复前置）。
    // 延迟到 ready 后再建窗：开机自启期双实例竞争时 app 可能尚未就绪，直接 new BrowserWindow 会抛异常崩溃。
    app.whenReady().then(() => {
      const filePaths = parseFilePathFromArgs(commandLine);
      if (filePaths.length > 0) {
        // 同样受窗口上限约束：一次"打开方式"选中大量文件时，不能绕开 MAX_PLAYER_WINDOWS 开满窗口
        for (const p of filePaths) {
          if (playerWindows.size >= MAX_PLAYER_WINDOWS) break;
          createPlayerWindow({ isMain: false, initialFile: p });
        }
        return;
      }
      showMainWindow();
    });
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
      // 尺寸也必须钳进当前工作区：本软件是 frame:false 的无边框窗口，最小化/最大化/关闭
      // 三个按钮都画在窗口右上角（DOM 自绘，不是系统标题栏）。若存档来自更大的显示器
      // （例如 4K 屏存了 3000×1600，之后用 1080p 笔记本启动），窗口会比屏幕宽出一大截，
      // 右上角按钮整体落在屏幕外 —— 用户就**关不掉也拖不动**这个窗口。
      // ⚠️ 尺寸钳制必须**无条件**执行：上面的"可见区过小"分支会删掉 x/y，若把尺寸钳制
      //   挂在"x/y 存在"的前置条件上，那么最需要钳制的场景（存档来自已拔掉的显示器、
      //   位置被判无效）反而被跳过，窗口照样宽出屏幕。位置信息还在时按其所在显示器钳，
      //   已被删时按主显示器钳——尺寸与位置在此分开处理。
      const hasPos = typeof state.x === 'number' && typeof state.y === 'number';
      const wa = hasPos
        ? screen.getDisplayMatching({ x: state.x, y: state.y, width: state.width, height: state.height }).workArea
        : screen.getPrimaryDisplay().workArea;
      state.width = Math.max(480, Math.min(state.width, wa.width));
      state.height = Math.max(320, Math.min(state.height, wa.height));
      if (hasPos) {
        state.x = Math.min(Math.max(state.x, wa.x), wa.x + wa.width - state.width);
        state.y = Math.min(Math.max(state.y, wa.y), wa.y + wa.height - state.height);
      }
      return state;
    }
  } catch (e) {
    // 首次运行或文件损坏，使用默认尺寸
  }
  return null;
}

// 记录"程序化自动贴合尺寸"的窗口：resize-window-to-video 的自动 setSize 引发的 resize 不写进
// 窗口状态记忆（避免覆盖用户手动调整的偏好尺寸）。用户手势拉伸（will-resize）时移出该集合。
const programmaticResizeWindows = new WeakSet();

// 记录"程序化挪窗"的目标坐标（win → {x, y}）：换片自动贴合时若窗口贴边会 setPosition 把它挪回屏内，
// 这次挪动同样不该写进窗口状态记忆 —— 否则 writeWindowState 会把"程序化贴合出的尺寸+位置"整体落盘，
// 绕过上面 resize 那条保护。move 事件到达时按目标坐标核对：一致就是这次程序化挪动，跳过保存；
// 不一致（用户已改过）则照常记录。只消费一次，避免影响后续用户手动移动。
const programmaticMoveTargets = new WeakMap();

// 播放器窗口工厂：主窗口与"新窗口"弹窗共用同一套无边框窗口/事件逻辑。
// isMain 决定是否记忆窗口状态；initialFile 为弹窗指定立即播放的文件。
function createPlayerWindow(options = {}) {
  let { isMain = false, initialFile = null } = options;
  const savedState = isMain ? loadWindowState() : null;

  const win = new BrowserWindow({
    width: (savedState && savedState.width) || 1000,
    height: (savedState && savedState.height) || 650,
    x: savedState ? savedState.x : undefined,
    y: savedState ? savedState.y : undefined,
    minWidth: 480,
    minHeight: 320,
    frame: false, // 默认无边框
    backgroundColor: '#08090C',
    title: 'BBPlayer',
    icon: path.join(__dirname, 'build/icon.png'),
    // 立即显示窗口：先把窗口"壳"亮出来（底色是与页面背景一致的 #08090C，不会闪白），内容随后绘制。
    // 若像旧版那样等 ready-to-show 才显示，用户在 Electron 整个启动期间看不到任何东西，
    // 体感就是"点了没反应、卡很久"；Electron 官方文档对复杂应用正是推荐此做法。
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true, // 显式开启沙箱（preload 仅用 electron 受限子集：contextBridge/ipcRenderer/webUtils，均可用）
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

  // 恢复最大化状态（旧存档无 maximized 字段则为 undefined，自动跳过，向前兼容）
  if (isMain && savedState && savedState.maximized) {
    win.maximize();
  }

  // 纳入 IPC 信任面，窗口关闭时移除
  playerWindows.add(win);
  win.on('closed', () => {
    playerWindows.delete(win);
    if (isMain) mainWindow = null;
    converter.invalidate(String(win.id)); // 窗口关了，它正在跑的转换立刻停掉
  });

  win.loadFile('index.html');

  // 渲染进程加载完成后推送初始文件（弹窗直接播该文件；主窗口取冷启动/运行中传入的文件）
  win.webContents.on('did-finish-load', () => {
    if (initialFile) {
      win.webContents.send('open-file', initialFile);
      initialFile = null; // 一次性消费：页面重载（如崩溃恢复）不重复投喂
    } else if (isMain && initialFilePaths && initialFilePaths.length > 0) {
      win.webContents.send('open-file', initialFilePaths[0]);
      // 冷启动多文件：首个给主窗口播放，其余开独立弹窗（同样受窗口上限约束）
      for (let i = 1; i < initialFilePaths.length; i++) {
        if (playerWindows.size >= MAX_PLAYER_WINDOWS) break;
        createPlayerWindow({ isMain: false, initialFile: initialFilePaths[i] });
      }
      initialFilePaths = null;
    }
  });

  // 安全防护：禁止页面打开新窗口与跳转外部导航
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // 优雅加载（窗口本身以 show:true 立即显示，这里不再重复 show）

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
  // 因此换片自动贴合不受影响）；下次加载新视频时会重新锁定。
  // 同时标记：此 resize 来自用户手势，可写入窗口状态记忆（程序化 setSize 不可写）
  win.on('will-resize', () => {
    if (win && !win.isDestroyed()) {
      programmaticResizeWindows.delete(win);
      win.setAspectRatio(0);
    }
  });

  // 仅主窗口记忆窗口大小/位置（弹窗每次级联展开，不做持久化）
  if (isMain) {
    // 窗口大小/位置变化时保存状态（防抖，全屏时不记录）。
    // 最大化时落盘 getNormalBounds()（恢复后的正常边界）而非工作区整块，
    // 并附带 maximized 标志供下次启动恢复，避免"伪最大化"占满屏幕。
    let stateSaveTimer = null;
    const writeWindowState = () => {
      if (!win || win.isDestroyed() || win.isFullScreen()) return;
      try {
        const bounds = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
        fs.writeFileSync(windowStateFile, JSON.stringify({ ...bounds, maximized: win.isMaximized() }), 'utf8');
      } catch (e) {
        // 忽略写入失败
      }
    };
    const scheduleStateSave = () => {
      if (!win || win.isDestroyed() || win.isFullScreen()) return;
      if (stateSaveTimer) clearTimeout(stateSaveTimer);
      stateSaveTimer = setTimeout(writeWindowState, 400);
    };
    // resize 仅用户手势（will-resize 移出 programmaticResizeWindows）时落盘；
    // 换片自动贴合尺寸（程序化 setSize）不写进记忆，避免覆盖用户偏好尺寸。
    // move 同理：程序化挪窗（贴合时把窗口拉回屏内）也不写进记忆 —— 按登记的目标坐标核对，
    // 匹配则跳过并消费该登记；不匹配说明是用户手动移动，照常保存。
    win.on('resize', () => { if (!programmaticResizeWindows.has(win)) scheduleStateSave(); });
    win.on('move', () => {
      const target = programmaticMoveTargets.get(win);
      if (target) {
        programmaticMoveTargets.delete(win);   // 只消费一次，不长期残留
        const b = win.getBounds();
        if (b.x === target.x && b.y === target.y) return; // 正是这次程序化挪动 → 不写记忆
      }
      scheduleStateSave();
    });

    // 主窗口关闭时把窗口状态强制落盘（取消挂起的防抖保存，避免最后一次移动/缩放丢失）。
    // 退出软件由 window-all-closed 统一负责（可能还有别的播放器窗口开着）。
    win.on('close', () => {
      if (stateSaveTimer) {
        clearTimeout(stateSaveTimer);
        stateSaveTimer = null;
      }
      writeWindowState();
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
  // 没抢到单实例锁的进程已经在上面退出中：这里必须直接返回，
  // 否则第二个实例仍可能抢先建出窗口、跑一遍缓存清理和更新检查（表现为"闪一下黑窗"）。
  if (!gotTheLock) return;
  mainWindow = createPlayerWindow({ isMain: true });
  // 启动时清一次缓存（残留的 .part.mp4 碎片 + 超过上限的旧产物），失败不影响使用
  converter.cleanup(true);
  converter.isAvailable().then((ok) => {
    if (!ok) {
      console.warn('[BBPlayer] 未找到内置转换器，avi/flv/wmv/ts/rmvb 等格式将无法播放：', converter.ffmpegPath());
    }
  });
  // 延后 3 秒再查更新：避免和启动期的 ffmpeg 探测/首帧渲染抢网络与主线程；
  // 只有发现新版本才会弹窗，没有更新或检查失败都保持安静。
  setTimeout(() => updater.checkForUpdates(mainWindow), 3000);
});

// 退出前杀掉正在跑的 ffmpeg，避免留下孤儿进程一直占 CPU
app.on('before-quit', () => converter.killActive());
process.on('exit', () => converter.killActive());

app.on('window-all-closed', () => {
  // 所有窗口关闭即退出软件（主窗口点"关闭"或最后一个窗口关掉都走这里）
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

// 同时在世的播放器窗口上限：防止渲染进程被注入后循环开窗耗尽系统资源
const MAX_PLAYER_WINDOWS = 16;

// 在独立新窗口播放指定视频（多视频同时播放的核心入口）
ipcMain.on('window:openInNewWindow', async (event, filePath) => {
  if (!isTrustedSender(event)) return;
  if (playerWindows.size >= MAX_PLAYER_WINDOWS) return;
  // 异步校验：同步 existsSync 会阻塞主进程（多窗口下等于卡住所有窗口）
  const abs = await resolveMediaPath(filePath);
  if (!abs) return;
  if (playerWindows.size >= MAX_PLAYER_WINDOWS) return; // 等待校验期间可能已开满
  createPlayerWindow({ isMain: false, initialFile: abs });
});

// === 媒体兼容层 IPC ===
// 给一个本地媒体路径，返回"可以直接喂给 <video> 的 URL"：
//   · 原生可播的扩展名 → 原样返回（不探测、不转换，常用格式零额外开销）
//   · 需要转换的扩展名 → 先探测再按档位转换（换容器/换音频/重编码），进度经 media:convert-progress 回传
//   · 失败/取消 → 返回空串，由渲染进程走既有的"无法解析媒体源"提示
//
// 入参校验一律异步（fs.promises）：同步 existsSync 会阻塞主进程事件循环，
// 多窗口并存时等于把所有窗口的按钮与 IPC 一起卡住（与 file:findCover 同一纪律）。
async function resolveMediaPath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return '';
  const abs = path.resolve(filePath);
  if (!videoExtensions.has(path.extname(abs).toLowerCase())) return '';
  try {
    const st = await fs.promises.stat(abs);
    if (!st.isFile()) return '';
  } catch (e) {
    return ''; // 不存在或不可读
  }
  return abs;
}

ipcMain.handle('media:prepare', async (event, filePath, force) => {
  if (!isTrustedSender(event)) return '';
  const win = windowOf(event);
  if (!win) return '';
  const abs = await resolveMediaPath(filePath);
  if (!abs) return '';

  const tier = (force === 'transcode' || force === 'audiofix') ? force : null;
  const key = String(win.id);
  // 同一窗口切换到别的文件 → 作废它上一次的转换（运行时兜底的强制请求不走这里，避免打断自己）
  if (!tier) converter.invalidate(key);
  // 先给界面一个即时反馈：转换可能要排队（全局并发 1），没有这条提示用户会以为"点了没反应"
  if (!win.isDestroyed()) {
    win.webContents.send('media:convert-progress', { percent: 0, tier: tier || 'auto', stage: 'prepare' });
  }

  try {
    const result = await converter.prepare(abs, {
      key,
      force: tier,
      onProgress: (p) => {
        if (win.isDestroyed()) return;
        win.webContents.send('media:convert-progress', {
          percent: p.percent,
          speed: p.speed,
          // converter 探测出真实档位后会回传一次（含 'decided' 阶段），优先用它：
          // 这样界面能显示"正在换容器"而不是笼统的"正在转换格式"
          tier: p.tier || tier || 'auto',
          stage: p.stage
        });
      }
    });
    return result.url;
  } catch (err) {
    if (err && err.name === 'CancelledError') return '';  // 用户换片/关窗：静默
    console.warn('[BBPlayer] 媒体转换失败:', abs, err && err.message);
    if (!win.isDestroyed()) {
      win.webContents.send('media:convert-failed', { path: abs, message: (err && err.message) || '转换失败' });
    }
    return '';
  }
});

// 查询文件的容器/编码信息（运行时兜底用它判断"该重编码还是只换音频"）
ipcMain.handle('media:probe', async (event, filePath) => {
  if (!isTrustedSender(event)) return null;
  const abs = await resolveMediaPath(filePath);
  if (!abs) return null;
  const p = await converter.probeFile(abs);
  if (!p) return null;
  return { container: p.container, video: p.video, audio: p.audio, duration: p.duration, hasAudio: !!p.audio };
});

// 查找音频文件同目录的封面图：cover/folder 惯例命名 + 同名图片，命中返回可用的图片 URL，未命中返回 null。
// 渲染进程（沙箱）无法直接读目录，故由主进程完成；文件名取自固定惯例与自身 basename，无路径注入风险。
// 命中时优先返回 data: URL：data: 图像与页面同源，渲染端 canvas 采样主色（环境光功能）不被跨域污染；
// file:// 图像在 file:// 页面必然污染画布，getImageData 必抛 SecurityError。超大封面回退 file://（显示不受影响，仅采样走兜底背景）。
const COVER_FILENAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp', 'folder.jpg', 'folder.png', 'front.jpg', 'front.png'];
const MAX_COVER_BYTES = 8 * 1024 * 1024; // 8MB：超过则不走 base64（防止特大图撑爆 IPC 载荷）
const COVER_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
ipcMain.handle('file:findCover', async (event, filePath) => {
  if (!isTrustedSender(event)) return null;
  if (typeof filePath !== 'string' || !filePath) return null;
  // 入参必须是受支持的媒体文件（与其它文件类 IPC 同一套白名单）：
  // 否则本接口会退化成"传任意图片路径即可读回其 base64"，成为越权读图通道
  if (!videoExtensions.has(path.extname(filePath).toLowerCase())) return null;
  try {
    const abs = path.resolve(filePath);
    const dir = path.dirname(abs);
    const base = path.basename(abs, path.extname(abs));
    const candidates = COVER_FILENAMES.concat([base + '.jpg', base + '.jpeg', base + '.png', base + '.webp']);
    for (const name of candidates) {
      const p = path.join(dir, name);
      let stat;
      try {
        // 全部改异步：同步 stat/read 会阻塞主进程，多窗口下等于卡住所有窗口
        stat = await fs.promises.stat(p);
      } catch (err) {
        continue; // 不存在或不可读，继续尝试下一个候选名
      }
      // 0 字节的坏图（下载失败/占位文件）必须跳过，否则它会把后面真正有效的候选封面顶掉
      if (!stat.isFile() || stat.size === 0) continue;
      // 候选名只来自 COVER_FILENAMES 与 jpg/jpeg/png/webp，mime 正常情况下必存在（保留判断以防清单以后扩容漏配）
      const mime = COVER_MIME[path.extname(p).toLowerCase()];
      if (mime && stat.size <= MAX_COVER_BYTES) {
        try {
          const buf = await fs.promises.readFile(p);
          return `data:${mime};base64,${buf.toString('base64')}`;
        } catch (err) {
          console.warn('封面转 data URL 失败，回退 file://:', p, err);
        }
      }
      // 超大图 / 未知图片类型：直接给 file:// URL，显示不受影响（仅主色采样走兜底背景）
      return pathToFileURL(p).href;
    }
  } catch (err) {
    console.warn('查找封面失败:', filePath, err);
  }
  return null;
});

// 媒体扩展名下发（单一事实来源 shared-video-exts.js / shared-subtitle-exts.js）：
// preload 处于沙箱无法 require 本地模块，渲染进程经此一次性获取与主进程完全一致的数据。
// 冷启动/运行的传入文件统一走 did-finish-load 的 'open-file' 事件，无第二通道。
ipcMain.handle('app:getVideoExtensions', (event) => {
  if (!isTrustedSender(event)) return null;
  return { ...VIDEO_EXTS, subtitle: SUBTITLE_EXTS };
});

// 打开本地视频文件对话框（支持多选）
ipcMain.handle('dialog:openFile', async (event) => {
  const win = windowOf(event);
  if (!win || !isTrustedSender(event)) return null;
  const result = await dialog.showOpenDialog(win, {
    title: '选择本地媒体文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '媒体文件', extensions: VIDEO_EXTS.all },
      { name: '音频文件', extensions: VIDEO_EXTS.audio },
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
      { name: '字幕文件', extensions: [...SUBTITLE_EXTS] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// 打开整个文件夹，返回其中所有视频文件的绝对路径列表（支持安全深度递归）
// 返回 { files, truncated }：truncated 表示结果不完整（数量触顶 或 目录嵌套超深），由渲染进程提示用户
async function scanDirectorySafe(dirPath, maxDepth = 3, maxFiles = 500) {
  const collected = [];
  let truncated = false;

  async function walk(dir, depth) {
    // 深度超限：这里**必须**标记 truncated。此前直接 return 什么都不说，
    // 嵌套超过 4 层的目录里那些视频会静默消失，用户以为"这个文件夹就这些片子"，
    // 而数量触顶（下面那段）却会如实提示 —— 两种"没扫全"应当一个待遇。
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
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

  await walk(dirPath, 0);
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

// 读取本地文本文件（字幕），限制扩展名避免任意文件读取（白名单单一来源 shared-subtitle-exts.js）
const ALLOWED_SUBTITLE_EXTS = new Set(SUBTITLE_EXTS.map(ext => '.' + ext));
const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024; // 10MB，防止误选超大文件撑爆内存

// 字幕编码嗅探：BOM 识别 → UTF-8 严格解码 → GBK 回退。
// 覆盖中文环境最常见的 ANSI(GBK) 老字幕；readText 与拖入字幕（file:decodeSubtitle）两条路径共用本实现。
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
      // 终极兜底，至少不抛异常。必须先转 Buffer：Uint8Array#toString 会忽略编码参数、
      // 返回 "228,189,160,…" 这种数字串（拖入字幕走的就是 Uint8Array 这条路径）
      return Buffer.from(buf).toString('latin1');
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

// 解码拖入字幕的原始字节（渲染端 FileReader 读出 ArrayBuffer 后经此解码）。
// 统一走主进程的 decodeSubtitleBuffer，避免同一套编码嗅探在主进程与渲染端各维护一份、改一处漏一处
ipcMain.handle('file:decodeSubtitle', (event, payload) => {
  if (!isTrustedSender(event)) return null;
  if (!(payload instanceof ArrayBuffer)) return null;
  if (payload.byteLength === 0 || payload.byteLength > MAX_SUBTITLE_BYTES) return null;
  return decodeSubtitleBuffer(new Uint8Array(payload));
});

// 截图载荷上限：4K 原图 PNG 通常远小于此，超出即视为异常/恶意载荷，拒绝写盘
const MAX_SCREENSHOT_BYTES = 64 * 1024 * 1024;
// 导出保存高清截图到本地文件（渲染进程固定以 ArrayBuffer 载荷传输，避免大图 base64 膨胀）
ipcMain.handle('dialog:saveScreenshot', async (event, payload) => {
  const win = windowOf(event);
  if (!win || !isTrustedSender(event)) return false;
  if (!payload || typeof payload !== 'object' || !(payload.data instanceof ArrayBuffer)) return false;
  if (payload.data.byteLength === 0 || payload.data.byteLength > MAX_SCREENSHOT_BYTES) return false;
  const { data, defaultName } = payload;
  // 默认文件名校验：仅接受纯文件名（去路径分隔符与 Windows 非法字符），防止恶意名字带目录穿越进默认保存路径
  let safeName = 'BBPlayer_Screenshot.png';
  if (typeof defaultName === 'string' && defaultName) {
    const base = defaultName
      .replace(/[\\/:*?"<>|]/g, '_') // 路径分隔符、盘符冒号、Windows 文件名禁用字符
      .replace(/[. ]+$/, '')          // Windows 会静默丢掉结尾的点和空格
      .trim();
    if (base && base !== '.' && base !== '..') safeName = base;
  }

  const result = await dialog.showSaveDialog(win, {
    title: '保存视频画面截图',
    defaultPath: safeName,
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
  return null; // 用户取消：与"写盘失败(false)"区分开，否则渲染端把取消误报成保存失败
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
  // 上界：正常路径只发真实分辨率（最大 8K≈7680），超过此值必是异常/注入输入 ——
  // 极端宽高比会让下面 targetHeight 算出 0 这类无效尺寸。
  if (width > 16384 || height > 16384) return false;

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

  programmaticResizeWindows.add(win); // 程序化贴合尺寸：引发的 resize 不写进窗口状态记忆
  win.setAspectRatio(lockAspect ? aspectRatio : 0); // setAspectRatio(0) 取消锁定
  win.setSize(targetWidth, targetHeight);

  // 贴合后必须仍完整落在工作区内：窗口原本贴着屏幕右/下边缘时，放大后会被推出屏幕、画面被裁掉。
  // 这次挪动同样是程序化的，必须登记目标坐标，让 move 事件跳过保存（否则会把贴合尺寸写进记忆）。
  const newX = Math.max(workArea.x, Math.min(currentBounds.x, workArea.x + workArea.width - targetWidth));
  const newY = Math.max(workArea.y, Math.min(currentBounds.y, workArea.y + workArea.height - targetHeight));
  if (newX !== currentBounds.x || newY !== currentBounds.y) {
    const tx = Math.round(newX);
    const ty = Math.round(newY);
    programmaticMoveTargets.set(win, { x: tx, y: ty });
    win.setPosition(tx, ty);
  }
  return true;
});

// 处理渲染进程发送的动态移动窗口请求（约束在全部显示器并集内，避免拖出屏幕无法找回）
ipcMain.on('window-move', (event, payload) => {
  if (!isTrustedSender(event)) return;
  const win = windowOf(event);
  if (!win) return;
  if (!payload || typeof payload !== 'object') return;
  const { x, y } = payload;
  // isFinite 校验不可省：NaN 的 typeof 同样是 'number'，漏掉会把 NaN 喂给 setPosition
  if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return;
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
