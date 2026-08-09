// === 监听外部/命令行双击打开的文件 ===
if (window.electronAPI) {
  // 检查冷启动传入的文件路径
  if (typeof window.electronAPI.getInitialFile === 'function') {
    window.electronAPI.getInitialFile().then(filePath => {
      if (filePath) {
        addFilesToPlaylist([filePath]);
      }
    }).catch(err => {
      console.error('获取冷启动文件失败:', err);
    });
  }

  // 监听运行中双击打开文件事件
  if (typeof window.electronAPI.onOpenFile === 'function') {
    window.electronAPI.onOpenFile((filePath) => {
      if (filePath) {
        addFilesToPlaylist([filePath]);
      }
    });
  }

  // 窗口最小化自动暂停与恢复
  let wasPlayingBeforeMinimize = false;
  if (typeof window.electronAPI.onWindowMinimized === 'function') {
    window.electronAPI.onWindowMinimized(() => {
      if (video && !video.paused && isVideoLoaded) {
        wasPlayingBeforeMinimize = true;
        video.pause();
        updatePlayPauseUI(false);
        showToast('窗口已最小化，自动暂停播放');
      }
    });
  }
  if (typeof window.electronAPI.onWindowRestored === 'function') {
    window.electronAPI.onWindowRestored(() => {
      if (wasPlayingBeforeMinimize) {
        if (video && isVideoLoaded) {
          video.play().then(() => {
            updatePlayPauseUI(true);
          }).catch(console.error);
        }
        wasPlayingBeforeMinimize = false;
      }
    });
  }
}
const titleBar = document.getElementById('titlebar');
const video = document.getElementById('main-video');
const videoContainer = document.getElementById('player-container');
const emptyState = document.getElementById('empty-state');
const openFileBtn = document.getElementById('btn-open-file');
const openFolderBtn = document.getElementById('btn-open-folder');
const controlBar = document.getElementById('controls-overlay');
const resumeToast = document.getElementById('resume-toast');
const resumeTimeText = document.getElementById('resume-time-str');
const resumeBtn = document.getElementById('btn-do-resume');
const closeToastBtn = document.getElementById('btn-dismiss-resume');
const toastNotice = document.getElementById('global-toast');

// 控件按钮
const playPauseBtn = document.getElementById('btn-play');
const prevBtn = document.getElementById('btn-prev');
const nextBtn = document.getElementById('btn-next');
const volumeBtn = document.getElementById('btn-volume');
const volumeSlider = document.getElementById('volume-range');
const speedBtn = document.getElementById('btn-speed');
const speedMenu = document.getElementById('speed-menu');
const aspectRatioBtn = document.getElementById('btn-aspect');
const aspectMenu = document.getElementById('aspect-menu');
const subtitleBtn = document.getElementById('btn-subtitle');
const subtitleMenu = document.getElementById('subtitle-menu');
const loadSubBtn = document.getElementById('btn-load-sub');
const toggleSubBtn = document.getElementById('btn-toggle-sub');
const subSizeUpBtn = document.getElementById('btn-sub-size-up');
const subSizeDownBtn = document.getElementById('btn-sub-size-down');
const subOffsetUpBtn = document.getElementById('btn-sub-offset-up');
const subOffsetDownBtn = document.getElementById('btn-sub-offset-down');
const screenshotBtn = document.getElementById('btn-screenshot');
const playModeBtn = document.getElementById('btn-play-mode');
const playModeMenu = document.getElementById('play-mode-menu');
const rotateBtn = document.getElementById('btn-rotate');
const fullscreenBtn = document.getElementById('btn-fullscreen');

// 进度条与时间
const progressContainer = document.getElementById('progress-container');
const progressFill = document.getElementById('progress-fill');
const hoverTimeBubble = document.getElementById('progress-tooltip');
const currentTimeEl = document.getElementById('current-time');
const durationEl = document.getElementById('duration-time');

// 外挂字幕容器
const customSubtitle = document.getElementById('custom-subtitle-text');

// === 软件标题栏及控件名称显示 ===
const videoTitleEl = document.getElementById('video-title');
let currentSubtitleFontSize = 22;
let isSubtitleVisible = true;

// 播放列表 DOM
const playlistBtn = document.getElementById('btn-playlist');
const playlistPanel = document.getElementById('playlist-panel');
const playlistItemsContainer = document.getElementById('playlist-items');
const playlistCountEl = document.getElementById('playlist-count');
const playlistClearBtn = document.getElementById('btn-playlist-clear');
const historyViewBtn = document.getElementById('btn-history-view');
const addFolderBtn = document.getElementById('btn-add-folder');

// === 全局播放列表状态 ===
let playlist = []; // 存储 { file, name, path, key }
let currentPlaylistIndex = -1;
let playlistView = 'list'; // 'list' | 'history'

// === 全局状态 ===
let currentFilePath = '';
let hasRealPath = false; // 是否具有物理路径（决定是否记播放历史）
let isSeeking = false;
let controlsTimeout = null;
let toastTimer = null;
let clickTimer = null; // 单击/双击区分计时器
let lastVolume = 1.0;
let currentSubtitleData = [];
let subtitleOffset = 0; // 字幕时间偏移（秒），>0 表示字幕延后出现
let pendingResumeTime = 0;
let isVideoLoaded = false;
let currentSpeed = 1.0;
let currentRotation = 0; // 顺时针旋转角度：0 / 90 / 180 / 270
let playMode = 'list-loop'; // 'list-loop' (全部视频循环) | 'random' (全部视频随机) | 'single-loop' (单个视频循环)

const HISTORY_KEY = 'bb_player_history';
const SETTINGS_KEY = 'bb_player_settings';
const HISTORY_MAX = 200;

function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const pad = (num) => String(num).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// 轻提示 Toast 弹窗（连续调用时重置计时器，避免提前消失）
function showToast(message) {
  if (!toastNotice) return;
  toastNotice.textContent = message;
  toastNotice.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastNotice.classList.remove('show');
    toastTimer = null;
  }, 2500);
}

// === 播放历史存取（兼容旧版纯数字格式，限制条数） ===
function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
    const out = {};
    for (const [key, val] of Object.entries(raw)) {
      if (val && typeof val === 'object' && typeof val.t === 'number') {
        out[key] = val;
      } else if (typeof val === 'number') {
        out[key] = { t: val, ts: 0 }; // 兼容旧格式 { path: seconds }
      }
    }
    return out;
  } catch (e) {
    console.error('读取播放历史失败:', e);
    return {};
  }
}

function saveHistoryEntry(pathKey, time) {
  try {
    const history = loadHistory();
    history[pathKey] = { t: Math.floor(time), ts: Date.now() };
    const entries = Object.entries(history).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    const trimmed = entries.length > HISTORY_MAX ? Object.fromEntries(entries.slice(0, HISTORY_MAX)) : history;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.error('保存播放历史失败:', e);
  }
}

// === 用户设置持久化（音量/倍速/字幕样式/播放模式） ===
function persistSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      volume: video.volume,
      speed: currentSpeed,
      subtitleOffset,
      subtitleFontSize: currentSubtitleFontSize,
      subtitleVisible: isSubtitleVisible,
      playMode
    }));
  } catch (e) {
    // 忽略写入失败
  }
}

(function restoreSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (typeof s.volume === 'number') video.volume = Math.max(0, Math.min(1, s.volume));
    if (typeof s.speed === 'number') currentSpeed = s.speed;
    if (typeof s.subtitleOffset === 'number') subtitleOffset = Math.max(-60, Math.min(60, s.subtitleOffset));
    if (typeof s.subtitleFontSize === 'number') currentSubtitleFontSize = s.subtitleFontSize;
    if (typeof s.subtitleVisible === 'boolean') isSubtitleVisible = s.subtitleVisible;
    if (s.playMode && ['list-loop', 'random', 'single-loop'].includes(s.playMode)) {
      playMode = s.playMode;
    }
    updatePlayModeUI(playMode, false);
    if (customSubtitle) {
      customSubtitle.style.fontSize = `${currentSubtitleFontSize}px`;
      customSubtitle.style.display = isSubtitleVisible ? 'block' : 'none';
    }
    if (volumeSlider) volumeSlider.value = video.volume;
    setVolumeIcon(video.volume);
    if (speedBtn) speedBtn.textContent = `${currentSpeed.toFixed(1)}x`;
    if (speedMenu) {
      speedMenu.querySelectorAll('.menu-item').forEach(i => {
        i.classList.toggle('active', parseFloat(i.getAttribute('data-speed')) === currentSpeed);
      });
    }
  } catch (e) {
    console.error('恢复设置失败:', e);
  }
})();

// 本地文件路径转 file:// URL（转义 # 与 ?）
function toFileUrl(p) {
  return `file://${p.replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

// 全局保存创出的 Blob URL，方便垃圾回收释放
let currentBlobUrl = null;

function revokeCurrentBlobUrl() {
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
}

let autoNextTimer = null;

function clearAutoNextTimer() {
  if (autoNextTimer) {
    clearTimeout(autoNextTimer);
    autoNextTimer = null;
  }
}

// === 核心：通用视频加载与播放函数 (双重保险机制) ===
function loadAndPlayVideo(filePathOrFile) {
  if (!filePathOrFile) return;

  let targetSrc = '';
  let fileName = '';
  let fullPath = '';
  hasRealPath = false;

  if (typeof filePathOrFile === 'string') {
    fullPath = filePathOrFile;
    fileName = filePathOrFile.split(/[\\/]/).pop();
    hasRealPath = true;
    targetSrc = toFileUrl(fullPath);
  } else if (filePathOrFile instanceof File) {
    fileName = filePathOrFile.name;
    // 优先尝试从原生 API 提取物理路径
    let extractedPath = '';
    if (window.electronAPI && typeof window.electronAPI.getFilePath === 'function') {
      extractedPath = window.electronAPI.getFilePath(filePathOrFile);
    }
    if (!extractedPath) {
      extractedPath = filePathOrFile.path || '';
    }

    if (extractedPath) {
      fullPath = extractedPath;
      hasRealPath = true;
      targetSrc = toFileUrl(extractedPath);
    } else {
      // 降级双保险：URL.createObjectURL(file) 内存直接播放（无物理路径，不记历史）
      revokeCurrentBlobUrl();
      currentBlobUrl = URL.createObjectURL(filePathOrFile);
      targetSrc = currentBlobUrl;
      fullPath = filePathOrFile.name;
    }
  }

  if (!targetSrc) {
    showToast('无法解析视频源');
    return;
  }

  // 若目标不是新创建的 Blob，释放旧的 Blob 资源
  if (targetSrc !== currentBlobUrl) {
    revokeCurrentBlobUrl();
  }

  currentFilePath = fullPath;
  if (videoTitleEl) videoTitleEl.textContent = fileName;

  // 重置字幕状态（新视频不沿用上一部的字幕）
  currentSubtitleData = [];
  if (customSubtitle) customSubtitle.style.display = 'none';

  video.src = targetSrc;
  video.load();

  // 保留并应用当前的倍速设置
  video.playbackRate = currentSpeed;

  // 隐藏无视频空状态
  if (emptyState) emptyState.style.display = 'none';
  isVideoLoaded = true;

  // 尝试自动播放
  video.play().then(() => {
    updatePlayPauseUI(true);
  }).catch((err) => {
    console.warn('自动播放被阻断，等待手动触发:', err);
    updatePlayPauseUI(false);
  });

  showToast(`已加载: ${fileName}`);

  // 检查并自动加载同目录下的同名字幕 (仅当有物理路径时)
  if (hasRealPath && fullPath.includes('.')) {
    const basePath = fullPath.substring(0, fullPath.lastIndexOf('.'));
    checkAndAutoLoadSubtitles(basePath);
  }

  // 检查播放历史记忆（仅真实路径）
  if (hasRealPath) checkHistoryResume(fullPath);
}

// 通过主进程读取字幕文件（避免 fetch file:// 的路径编码与 CORS 问题）
async function loadSubtitleFromPath(filePath, expectedVideoPath) {
  if (!filePath) return false;
  if (!window.electronAPI || typeof window.electronAPI.readTextFile !== 'function') return false;
  try {
    const text = await window.electronAPI.readTextFile(filePath);
    if (text) {
      // 自动加载场景下校验视频未切换，避免旧视频的字幕覆盖新视频
      if (expectedVideoPath && currentFilePath !== expectedVideoPath) return false;
      parseAndApplySubtitle(text);
      return true;
    }
  } catch (err) {
    console.warn('读取字幕失败:', err);
  }
  return false;
}

// 检查同名本地字幕（依次尝试 .srt / .vtt / .ass）
async function checkAndAutoLoadSubtitles(basePath) {
  const videoKey = currentFilePath; // 发起时的视频路径（令牌）
  for (const ext of ['.srt', '.vtt', '.ass']) {
    try {
      const ok = await loadSubtitleFromPath(basePath + ext, videoKey);
      if (ok) {
        if (currentFilePath === videoKey) showToast('已自动载入同名外挂字幕');
        return;
      }
    } catch (e) {
      // 继续尝试下一个扩展名
    }
  }
}

// 检查播放历史与续播弹窗
function checkHistoryResume(pathKey) {
  if (!pathKey) return;
  const history = loadHistory();
  const saved = history[pathKey];
  if (saved && saved.t > 5) {
    // 过滤播放已接近完结 (剩余 < 8s 或进度 > 95%) 的记录，避免进入即结束
    if (video.duration && (video.duration - saved.t < 8 || saved.t / video.duration > 0.95)) {
      if (resumeToast) resumeToast.style.display = 'none';
      return;
    }
    pendingResumeTime = saved.t;
    if (resumeTimeText) resumeTimeText.textContent = formatTime(saved.t);
    if (resumeToast) resumeToast.style.display = 'flex';
  } else {
    if (resumeToast) resumeToast.style.display = 'none';
  }
}

// 自动打卡记录播放进度
function saveCurrentProgress() {
  if (!currentFilePath || !hasRealPath) return;
  if (!video.duration || video.currentTime < 3) return;
  saveHistoryEntry(currentFilePath, video.currentTime);
}

// 定时保存进度 (每 5 秒打卡)
setInterval(saveCurrentProgress, 5000);

// === 点击“打开本地视频文件”按键交互 ===
if (openFileBtn) {
  openFileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.electronAPI && window.electronAPI.openFileDialog) {
      window.electronAPI.openFileDialog().then(filePath => {
        if (filePath) {
          addFilesToPlaylist([filePath]);
        }
      }).catch(err => {
        console.error('打开文件对话框失败:', err);
      });
    }
  });
}

// === 打开整个文件夹，把其中视频全部加入播放列表 ===
async function openFolderAndAdd() {
  if (!window.electronAPI || typeof window.electronAPI.openFolderDialog !== 'function') return;
  try {
    const files = await window.electronAPI.openFolderDialog();
    if (files && files.length > 0) {
      const added = addFilesToPlaylist(files);
      if (added > 0) showToast(`已添加文件夹中的 ${added} 个视频`);
    }
  } catch (err) {
    console.error('打开文件夹失败:', err);
  }
}

if (openFolderBtn) {
  openFolderBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openFolderAndAdd();
  });
}

if (addFolderBtn) {
  addFolderBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openFolderAndAdd();
  });
}

// === 强力全域拖拽播放支持 (丢入软件任意区域均能识别播放) ===
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
  window.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, false);
});

window.addEventListener('dragover', (e) => {
  if (videoContainer) videoContainer.classList.add('drag-over');
});

window.addEventListener('dragleave', (e) => {
  if (e.clientX === 0 && e.clientY === 0) {
    if (videoContainer) videoContainer.classList.remove('drag-over');
  }
});

window.addEventListener('drop', (e) => {
  if (videoContainer) videoContainer.classList.remove('drag-over');

  const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
  if (files.length === 0) return;

  const videoExtensions = [
    'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'ts',
    'rmvb', 'rm', '3gp', 'mpg', 'mpeg', 'm2ts', 'vob', 'ogv', 'f4v', 'm2v'
  ];
  const videoFiles = files.filter(f => {
    // 过滤掉非视频扩展名以及大小为0或类似文件夹的非法条目
    if (!f.name || f.size === 0 || (f.type === '' && !f.name.includes('.'))) return false;
    const ext = f.name.split('.').pop().toLowerCase();
    return videoExtensions.includes(ext);
  });

  const subtitleFiles = files.filter(f => {
    const ext = f.name.split('.').pop().toLowerCase();
    return ['srt', 'vtt', 'ass'].includes(ext);
  });

  // 处理拖入的字幕
  if (subtitleFiles.length > 0 && videoFiles.length === 0) {
    const reader = new FileReader();
    reader.onload = (evt) => {
      parseAndApplySubtitle(evt.target.result);
      showToast('已加载拖入的字幕');
    };
    reader.readAsText(subtitleFiles[0]);
    return;
  }

  // 处理拖入的视频
  if (videoFiles.length > 0) {
    addFilesToPlaylist(videoFiles);
  }
});

// === 播放列表管理功能 ===
function addFilesToPlaylist(fileList) {
  const newItems = [];
  fileList.forEach(fileOrPath => {
    let name = '';
    let key = '';
    let target = fileOrPath;
    if (typeof fileOrPath === 'string') {
      name = fileOrPath.split(/[\\/]/).pop();
      key = fileOrPath; // 用完整路径去重，同名不同路径不再误判
    } else if (fileOrPath instanceof File) {
      name = fileOrPath.name;
      const p = (window.electronAPI && typeof window.electronAPI.getFilePath === 'function')
        ? window.electronAPI.getFilePath(fileOrPath)
        : (fileOrPath.path || '');
      key = p || name;
    }
    if (!key) return;
    // 防止重复添加（按唯一 key）
    const exists = playlist.some(item => item.key === key);
    if (!exists) {
      newItems.push({ target, name, key });
    }
  });

  if (newItems.length > 0) {
    const startIndex = playlist.length;
    playlist = playlist.concat(newItems);
    renderPlaylist();
    // 如果当前没有播放视频，自动播放加入的第一条
    if (!isVideoLoaded || (video.paused && !video.src)) {
      playPlaylistItem(startIndex);
    } else {
      showToast(`已向列表添加 ${newItems.length} 个视频`);
    }
  }
  return newItems.length;
}

function renderPlaylist() {
  if (!playlistItemsContainer || !playlistCountEl) return;
  if (playlistView !== 'list') return; // 历史视图由 renderHistoryView 负责

  playlistCountEl.textContent = `${playlist.length} 个视频`;

  if (playlist.length === 0) {
    playlistItemsContainer.innerHTML = `<div class="playlist-empty">暂无播放视频<br>拖拽多个视频到此处添加</div>`;
    return;
  }

  playlistItemsContainer.innerHTML = '';
  playlist.forEach((item, index) => {
    const div = document.createElement('div');
    div.className = `playlist-item ${index === currentPlaylistIndex ? 'active' : ''}`;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name';
    nameSpan.textContent = `${index + 1}. ${item.name}`;
    nameSpan.title = item.name;

    const removeBtn = document.createElement('span');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '✕';
    removeBtn.title = '从列表移除';

    div.appendChild(nameSpan);
    div.appendChild(removeBtn);

    div.addEventListener('click', (e) => {
      if (e.target.classList.contains('remove-btn')) {
        e.stopPropagation();
        removePlaylistItem(index);
      } else {
        playPlaylistItem(index);
      }
    });

    playlistItemsContainer.appendChild(div);
  });
}

// 历史记录视图（最近看过的视频，点击即可继续播放）
function renderHistoryView() {
  if (!playlistItemsContainer || !playlistCountEl) return;
  const history = loadHistory();
  const entries = Object.entries(history).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0)).slice(0, 100);
  playlistCountEl.textContent = `${entries.length} 条历史`;

  playlistItemsContainer.innerHTML = '';
  if (entries.length === 0) {
    playlistItemsContainer.innerHTML = `<div class="playlist-empty">暂无观看历史</div>`;
    return;
  }

  entries.forEach(([filePath, data]) => {
    const div = document.createElement('div');
    div.className = 'playlist-item';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name';
    nameSpan.textContent = filePath.split(/[\\/]/).pop();
    nameSpan.title = filePath;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'item-time';
    timeSpan.textContent = formatTime(data.t);

    div.appendChild(nameSpan);
    div.appendChild(timeSpan);

    div.addEventListener('click', () => {
      // 加入列表（若不存在）并直接播放；自动切回列表视图以便看到高亮
      if (playlistView !== 'list') togglePlaylistView();
      if (!playlist.some(item => item.key === filePath)) {
        playlist.push({ target: filePath, name: filePath.split(/[\\/]/).pop(), key: filePath });
      }
      const idx = playlist.findIndex(item => item.key === filePath);
      if (idx >= 0) playPlaylistItem(idx);
      else renderPlaylist();
    });

    playlistItemsContainer.appendChild(div);
  });
}

// 播放列表 / 历史记录视图切换
function togglePlaylistView() {
  playlistView = playlistView === 'list' ? 'history' : 'list';
  if (historyViewBtn) historyViewBtn.classList.toggle('active', playlistView === 'history');
  if (playlistView === 'history') {
    renderHistoryView();
  } else {
    renderPlaylist();
  }
}

if (historyViewBtn) {
  historyViewBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlaylistView();
  });
}

// 清空播放列表
if (playlistClearBtn) {
  playlistClearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    playlist = [];
    currentPlaylistIndex = -1;
    hasRealPath = false;
    currentFilePath = '';
    currentSubtitleData = [];
    pendingResumeTime = 0;
    if (customSubtitle) customSubtitle.style.display = 'none';
    if (resumeToast) resumeToast.style.display = 'none';
    video.src = '';
    video.load();
    if (emptyState) emptyState.style.display = 'flex';
    isVideoLoaded = false;
    if (playlistView !== 'list') togglePlaylistView(); // 切回列表视图让清空结果可见
    renderPlaylist();
    showToast('播放列表已清空');
  });
}

function playPlaylistItem(index) {
  clearAutoNextTimer();
  if (index < 0 || index >= playlist.length) return;
  currentPlaylistIndex = index;
  renderPlaylist();
  loadAndPlayVideo(playlist[index].target);
}

function removePlaylistItem(index) {
  clearAutoNextTimer();
  playlist.splice(index, 1);
  if (currentPlaylistIndex === index) {
    if (playlist.length > 0) {
      const nextIndex = index < playlist.length ? index : playlist.length - 1;
      playPlaylistItem(nextIndex);
    } else {
      currentPlaylistIndex = -1;
      hasRealPath = false;
      currentFilePath = '';
      currentSubtitleData = [];
      pendingResumeTime = 0;
      if (customSubtitle) customSubtitle.style.display = 'none';
      if (resumeToast) resumeToast.style.display = 'none';
      video.src = '';
      video.load();
      if (emptyState) emptyState.style.display = 'flex';
      isVideoLoaded = false;
    }
  } else if (currentPlaylistIndex > index) {
    currentPlaylistIndex--;
  }
  renderPlaylist();
}

// 视频播放结束处理（支持全部循环、全部随机、单个循环）
if (video) {
  video.addEventListener('ended', () => {
    if (playMode === 'single-loop') {
      video.currentTime = 0;
      video.play().catch(console.error);
      updatePlayPauseUI(true);
      return;
    }

    if (playlist.length > 0) {
      clearAutoNextTimer();
      let nextIndex = -1;

      if (playMode === 'random') {
        if (playlist.length === 1) {
          nextIndex = 0;
        } else {
          // 随机选择一个不同于当前的索引
          const pool = [];
          for (let i = 0; i < playlist.length; i++) {
            if (i !== currentPlaylistIndex) pool.push(i);
          }
          nextIndex = pool[Math.floor(Math.random() * pool.length)];
        }
        showToast('即将随机播放下一个视频');
      } else {
        // 'list-loop' 全部循环
        nextIndex = currentPlaylistIndex >= playlist.length - 1 ? 0 : currentPlaylistIndex + 1;
        showToast('即将播放下一个视频');
      }

      autoNextTimer = setTimeout(() => {
        if (nextIndex >= 0 && nextIndex < playlist.length) {
          playPlaylistItem(nextIndex);
        }
      }, 1000);
    }
  });
}

// 上一首 / 下一首
if (prevBtn) {
  prevBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (playlist.length === 0) return;
    if (playMode === 'random' && playlist.length > 1) {
      const pool = [];
      for (let i = 0; i < playlist.length; i++) {
        if (i !== currentPlaylistIndex) pool.push(i);
      }
      playPlaylistItem(pool[Math.floor(Math.random() * pool.length)]);
    } else {
      const next = currentPlaylistIndex <= 0 ? playlist.length - 1 : currentPlaylistIndex - 1;
      playPlaylistItem(next);
    }
  });
}

if (nextBtn) {
  nextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (playlist.length === 0) return;
    if (playMode === 'random' && playlist.length > 1) {
      const pool = [];
      for (let i = 0; i < playlist.length; i++) {
        if (i !== currentPlaylistIndex) pool.push(i);
      }
      playPlaylistItem(pool[Math.floor(Math.random() * pool.length)]);
    } else {
      const next = currentPlaylistIndex >= playlist.length - 1 ? 0 : currentPlaylistIndex + 1;
      playPlaylistItem(next);
    }
  });
}

// 播放列表按钮面板显隐控制
if (playlistBtn && playlistPanel) {
  playlistBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    playlistPanel.classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    if (!playlistPanel.contains(e.target) && e.target !== playlistBtn) {
      playlistPanel.classList.remove('open');
    }
  });
}

function updatePlayPauseUI(isPlaying) {
  if (playPauseBtn) {
    const playIcon = playPauseBtn.querySelector('#icon-play-state');
    if (playIcon) {
      if (isPlaying) {
        // 转换为暂停图标 (双连杆)
        playIcon.innerHTML = `<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>`;
      } else {
        // 转换为播放图标 (圆角三角)
        playIcon.innerHTML = `<polygon points="5 3 19 12 5 21 5 3"/>`;
      }
    }
  }
}

function togglePlayPause() {
  if (!video.src || !isVideoLoaded) return;
  if (video.paused) {
    video.play();
    updatePlayPauseUI(true);
  } else {
    video.pause();
    updatePlayPauseUI(false);
  }
}

if (playPauseBtn) playPauseBtn.addEventListener('click', togglePlayPause);

// 完美兼顾画面按住拖拽窗口与单击播放/暂停
if (video) {
  let isDraggingWindow = false;
  let startX = 0;
  let startY = 0;
  let initialWinX = 0;
  let initialWinY = 0;

  video.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // 仅左键响应
    if (document.fullscreenElement) return; // 全屏状态下禁止拖动窗口

    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
    isDraggingWindow = false;
    startX = e.screenX;
    startY = e.screenY;

    // 记录拖拽初始瞬间的屏幕与窗口坐标
    if (window.electronAPI && typeof window.electronAPI.moveWindow === 'function') {
      initialWinX = window.screenX;
      initialWinY = window.screenY;
    }

    const onPointerMove = (moveEv) => {
      const deltaX = moveEv.screenX - startX;
      const deltaY = moveEv.screenY - startY;

      // 位移阈值判断（超过 4px 视作拖动窗口，而不是单击）
      if (!isDraggingWindow && (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4)) {
        isDraggingWindow = true;
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
        }
      }

      if (isDraggingWindow && window.electronAPI && typeof window.electronAPI.moveWindow === 'function') {
        window.electronAPI.moveWindow({
          x: initialWinX + deltaX,
          y: initialWinY + deltaY
        });
      }
    };

    const cleanupPointerListeners = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
    };

    const onPointerUp = (upEv) => {
      cleanupPointerListeners();

      if (!isDraggingWindow) {
        // 说明是纯粹的左键单击，触发播放/暂停
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
        }
        clickTimer = setTimeout(() => {
          clickTimer = null;
          togglePlayPause();
        }, 250);
        showControls();
      }
    };

    const onPointerCancel = () => {
      cleanupPointerListeners();
      isDraggingWindow = false;
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  });
}

// === 点击任意非菜单区域关闭菜单 ===
document.addEventListener('click', () => {
  if (speedMenu) speedMenu.classList.remove('show');
  if (subtitleMenu) subtitleMenu.classList.remove('show');
  if (aspectMenu) aspectMenu.classList.remove('show');
  if (playModeMenu) playModeMenu.classList.remove('show');
});

// === 字幕菜单与字幕控制绑定 ===
if (subtitleBtn && subtitleMenu) {
  subtitleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (speedMenu) speedMenu.classList.remove('show');
    if (aspectMenu) aspectMenu.classList.remove('show');
    subtitleMenu.classList.toggle('show');
  });
}

video.addEventListener('timeupdate', () => {
  if (isSeeking || isNaN(video.duration)) return;
  const current = video.currentTime;
  const total = video.duration;
  const percent = (current / total) * 100;

  if (progressFill) progressFill.style.width = `${percent}%`;
  if (currentTimeEl) currentTimeEl.textContent = formatTime(current);
  if (durationEl) durationEl.textContent = formatTime(total);

  // 驱动字幕实时渲染
  renderSubtitlesAt(current);
});

// 新视频加载完成时重置进度显示（避免残留上一视频的进度）并触发窗口适应视频比例
video.addEventListener('loadedmetadata', () => {
  if (progressFill) progressFill.style.width = '0%';
  if (currentTimeEl) currentTimeEl.textContent = formatTime(0);
  if (durationEl) durationEl.textContent = formatTime(video.duration);

  // 通知主进程调整窗口尺寸及固定宽高比，彻底消除上下左右黑边
  if (video.videoWidth && video.videoHeight && window.electronAPI && typeof window.electronAPI.resizeToVideo === 'function') {
    window.electronAPI.resizeToVideo({
      width: video.videoWidth,
      height: video.videoHeight
    });
  }
});

// 视频加载失败提示（损坏文件 / 不支持的格式）
video.addEventListener('error', () => {
  updatePlayPauseUI(false);
  const ext = currentFilePath ? currentFilePath.split('.').pop().toLowerCase() : '';
  showToast(`视频加载失败：系统无法解码该文件 (${ext || '未知的编码类型'})`);
  
  // 若在播放列表中播放失败，延迟 1.5 秒自动尝试跳过播放下一个视频
  if (playlist.length > 0 && currentPlaylistIndex >= 0 && currentPlaylistIndex < playlist.length - 1) {
    if (autoNextTimer) clearTimeout(autoNextTimer);
    autoNextTimer = setTimeout(() => {
      playPlaylistItem(currentPlaylistIndex + 1);
    }, 1500);
  }
});

// 进度条 Hover 时间小预览
if (progressContainer) {
  progressContainer.addEventListener('mousemove', (e) => {
    if (!video.duration) return;
    const rect = progressContainer.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    const hoverPercent = Math.max(0, Math.min(1, pos));
    const hoverTime = hoverPercent * video.duration;

    if (hoverTimeBubble) {
      hoverTimeBubble.textContent = formatTime(hoverTime);
      // 限制气泡不超出进度条两端
      const clamped = Math.max(4, Math.min(96, hoverPercent * 100));
      hoverTimeBubble.style.left = `${clamped}%`;
      hoverTimeBubble.style.display = 'block';
    }
  });

  progressContainer.addEventListener('mouseleave', () => {
    if (hoverTimeBubble) hoverTimeBubble.style.display = 'none';
  });

  // 点击与拖拽跳转
  const handleSeek = (e) => {
    if (!video.duration) return;
    const rect = progressContainer.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetTime = pos * video.duration;
    if (progressFill) progressFill.style.width = `${pos * 100}%`;
    if (currentTimeEl) currentTimeEl.textContent = formatTime(targetTime);
    video.currentTime = targetTime;
  };

  progressContainer.addEventListener('mousedown', (e) => {
    isSeeking = true;
    handleSeek(e);

    const onMouseMove = (moveEvt) => {
      if (isSeeking) handleSeek(moveEvt);
    };

    const onMouseUp = (upEvt) => {
      if (isSeeking) {
        handleSeek(upEvt);
        isSeeking = false;
      }
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  });
}

// === 音量调节与全局滚轮调音 ===
function setVolumeIcon(vol) {
  if (!volumeBtn) return;
  const iconSvg = volumeBtn.querySelector('#icon-volume-state');
  if (iconSvg) {
    if (vol === 0) {
      // 静音
      iconSvg.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>`;
    } else if (vol < 0.5) {
      // 低音量
      iconSvg.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>`;
    } else {
      // 高音量
      iconSvg.innerHTML = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>`;
    }
  }
}

function updateVolume(val) {
  const vol = Math.max(0, Math.min(1, parseFloat(val)));
  video.volume = vol;
  if (volumeSlider) volumeSlider.value = vol;
  setVolumeIcon(vol);
  persistSettings();
}

if (volumeSlider) {
  volumeSlider.addEventListener('input', (e) => updateVolume(e.target.value));
}

if (volumeBtn) {
  volumeBtn.addEventListener('click', () => {
    if (video.volume > 0) {
      lastVolume = video.volume;
      updateVolume(0);
    } else {
      updateVolume(lastVolume || 1.0);
    }
  });
}

// 全局鼠标滚轮调音（仅视频区域生效；播放列表面板滚动、音量滑块自身、菜单内不干预）
window.addEventListener('wheel', (e) => {
  if (e.target.closest('#playlist-panel')) return;
  if (e.target.closest('#speed-menu') || e.target.closest('#subtitle-menu') || e.target.closest('#aspect-menu')) return;
  if (e.target.closest('#volume-range')) return; // 滑块已有 input 事件，避免双重调节
  if (!videoContainer || !videoContainer.contains(e.target)) return;
  e.preventDefault();
  if (e.deltaY < 0) {
    updateVolume(video.volume + 0.05);
  } else {
    updateVolume(video.volume - 0.05);
  }
}, { passive: false });

// === 多倍速切换菜单 ===
if (speedBtn && speedMenu) {
  speedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (subtitleMenu) subtitleMenu.classList.remove('show');
    if (aspectMenu) aspectMenu.classList.remove('show');
    speedMenu.classList.toggle('show');
  });

  speedMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    const item = e.target.closest('.menu-item');
    if (!item) return;

    const speed = parseFloat(item.getAttribute('data-speed'));
    if (!isNaN(speed)) {
      currentSpeed = speed;
      video.playbackRate = speed;
      if (speedBtn) speedBtn.textContent = `${speed.toFixed(1)}x`;
      speedMenu.querySelectorAll('.menu-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      speedMenu.classList.remove('show');
      showToast(`已切换至 ${speed.toFixed(1)}x 倍速`);
      persistSettings();
    }
  });
}

// === 画面比例切换（自动 / 16:9 / 4:3 / 铺满） ===
const aspectModes = [
  { id: 'auto', label: '自动', objectFit: 'contain' },
  { id: '16-9', label: '16:9', objectFit: 'contain' },
  { id: '4-3', label: '4:3', objectFit: 'contain' },
  { id: 'cover', label: '铺满', objectFit: 'cover' }
];
let currentAspectIndex = 0;

function applyVideoLayout() {
  // 统一计算视频元素布局：先按比例模式算基准宽高，再按旋转角度互换宽高并加 transform
  const mode = aspectModes[currentAspectIndex];
  const cw = videoContainer ? videoContainer.clientWidth : window.innerWidth;
  const ch = videoContainer ? videoContainer.clientHeight : window.innerHeight;
  let baseW, baseH;
  if (mode.id === '16-9') {
    baseW = cw;
    baseH = cw * 9 / 16;
  } else if (mode.id === '4-3') {
    baseW = cw;
    baseH = cw * 3 / 4;
  } else {
    baseW = cw;
    baseH = ch;
  }
  const isQuarter = (currentRotation === 90 || currentRotation === 270);
  video.style.width = isQuarter ? `${Math.round(baseH)}px` : `${Math.round(baseW)}px`;
  video.style.height = isQuarter ? `${Math.round(baseW)}px` : `${Math.round(baseH)}px`;
  video.style.transform = currentRotation > 0 ? `rotate(${currentRotation}deg)` : '';
  video.style.objectFit = mode.objectFit;
}

function applyAspectMode(mode) {
  currentAspectIndex = aspectModes.indexOf(mode);
  applyVideoLayout();
  if (aspectRatioBtn) aspectRatioBtn.textContent = mode.label;
  if (aspectMenu) {
    aspectMenu.querySelectorAll('.menu-item').forEach(i => {
      i.classList.toggle('active', i.dataset.aspect === mode.id);
    });
  }
}

// 窗口尺寸变化时重新计算布局（含比例锁定与旋转）
window.addEventListener('resize', () => {
  applyVideoLayout();
});

if (aspectRatioBtn && aspectMenu) {
  aspectRatioBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (speedMenu) speedMenu.classList.remove('show');
    if (subtitleMenu) subtitleMenu.classList.remove('show');
    aspectMenu.classList.toggle('show');
  });

  aspectMenu.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const mode = aspectModes.find(m => m.id === item.dataset.aspect);
      if (mode) {
        currentAspectIndex = aspectModes.indexOf(mode);
        applyAspectMode(mode);
        aspectMenu.classList.remove('show');
        showToast(`画面比例: ${mode.label}`);
      }
    });
  });
}

// 初始化比例按钮文字（与实际状态一致：默认自动）
applyAspectMode(aspectModes[0]);

// === 外挂字幕解析渲染引擎 (.srt / .vtt / .ass 基础支持) ===
function stripAssTags(text) {
  return text.replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n').trim();
}

function parseAndApplySubtitle(text) {
  currentSubtitleData = [];
  if (!text) return;

  // 标准化换行符
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const isAss = /^\s*Dialogue:/m.test(normalized);

  if (isAss) {
    // ASS / SSA 格式：通过正则兼顾各种头部与字段变体
    normalized.split('\n').forEach(line => {
      const trimmedLine = line.trim();
      if (!trimmedLine.toLowerCase().startsWith('dialogue:')) return;
      
      // 匹配 Dialogue 后的 Start, End 时间与正文内容
      const match = trimmedLine.match(/^Dialogue:\s*[^,]*,([^,]+),([^,]+),(?:[^,]*,){0,7}(.*)$/i);
      if (match) {
        const startTime = parseSubtitleTime(match[1].trim());
        const endTime = parseSubtitleTime(match[2].trim());
        const subText = stripAssTags(match[3].trim());
        if (!isNaN(startTime) && !isNaN(endTime) && subText) {
          currentSubtitleData.push({ start: startTime, end: endTime, text: subText });
        }
      } else {
        // 回退机制：按逗号切分
        const fields = trimmedLine.split(',');
        if (fields.length >= 3) {
          const startTime = parseSubtitleTime(fields[1].trim());
          const endTime = parseSubtitleTime(fields[2].trim());
          const subText = stripAssTags(fields.slice(9).join(',').trim() || fields.slice(fields.length - 1).join(',').trim());
          if (!isNaN(startTime) && !isNaN(endTime) && subText) {
            currentSubtitleData.push({ start: startTime, end: endTime, text: subText });
          }
        }
      }
    });
  } else {
    // SRT / VTT（时间轴均含 -->）
    const blocks = normalized.split(/\n\n+/);
    blocks.forEach(block => {
      const lines = block.trim().split('\n');
      let timeLine = '';
      let textLines = [];

      lines.forEach(line => {
        if (line.includes('-->')) {
          timeLine = line;
        } else if (timeLine && line.trim()) {
          textLines.push(line.trim());
        }
      });

      if (timeLine) {
        const [startStr, endStr] = timeLine.split('-->').map(s => s.trim());
        const startTime = parseSubtitleTime(startStr);
        const endTime = parseSubtitleTime(endStr);
        const subText = textLines.join('\n');
        if (!isNaN(startTime) && !isNaN(endTime) && subText) {
          currentSubtitleData.push({ start: startTime, end: endTime, text: subText });
        }
      }
    });
  }

  // 按开始时间排序，供二分查找
  currentSubtitleData.sort((a, b) => a.start - b.start);
  renderSubtitlesAt(video.currentTime);
}

function parseSubtitleTime(str) {
  if (!str) return NaN;
  const cleanStr = String(str).trim().split(/\s+/)[0];
  const parts = cleanStr.split(':');
  if (parts.length === 3) {
    const h = parseInt(parts[0], 10) || 0;
    const min = parseInt(parts[1], 10) || 0;
    const secParts = parts[2].split(/[.,]/);
    const sec = parseInt(secParts[0], 10) || 0;
    const ms = secParts[1] ? parseInt(secParts[1].padEnd(3, '0').slice(0, 3), 10) : 0;
    return h * 3600 + min * 60 + sec + ms / 1000;
  } else if (parts.length === 2) {
    const min = parseInt(parts[0], 10) || 0;
    const secParts = parts[1].split(/[.,]/);
    const sec = parseInt(secParts[0], 10) || 0;
    const ms = secParts[1] ? parseInt(secParts[1].padEnd(3, '0').slice(0, 3), 10) : 0;
    return min * 60 + sec + ms / 1000;
  }
  return NaN;
}

// 二分查找当前时间命中的字幕（兼容重叠/长字幕，向前回扫最多 20 条）
function findActiveSubtitle(time) {
  if (currentSubtitleData.length === 0) return null;
  // 二分定位最后一个 start <= time 的字幕
  let low = 0;
  let high = currentSubtitleData.length - 1;
  let idx = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (currentSubtitleData[mid].start <= time) {
      idx = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  // 从该位置向前扫描，兼容字幕区间重叠（如一条长时间轴字幕跨过多条短字幕）
  for (let i = idx; i >= 0 && i > idx - 200; i--) {
    const item = currentSubtitleData[i];
    if (time >= item.start && time <= item.end) return item;
  }
  return null;
}

let lastRenderedSubText = null;

function renderSubtitlesAt(currentTime) {
  if (!customSubtitle) return;
  if (!currentSubtitleData || currentSubtitleData.length === 0 || !isSubtitleVisible) {
    if (customSubtitle.style.display !== 'none') {
      customSubtitle.style.display = 'none';
      lastRenderedSubText = null;
    }
    return;
  }

  const activeSub = findActiveSubtitle(currentTime + subtitleOffset);
  if (activeSub) {
    if (lastRenderedSubText !== activeSub.text) {
      customSubtitle.textContent = activeSub.text;
      customSubtitle.style.display = 'block';
      lastRenderedSubText = activeSub.text;
    }
  } else {
    if (customSubtitle.style.display !== 'none') {
      customSubtitle.style.display = 'none';
      lastRenderedSubText = null;
    }
  }
}

// === 字幕加载 / 显示 / 样式控制 ===
if (loadSubBtn) {
  loadSubBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    subtitleMenu.classList.remove('show');
    if (window.electronAPI && window.electronAPI.openSubtitleDialog) {
      try {
        const filePath = await window.electronAPI.openSubtitleDialog();
        if (filePath) {
          const ok = await loadSubtitleFromPath(filePath);
          showToast(ok ? '字幕导入成功' : '加载字幕文件失败');
        }
      } catch (err) {
        console.error('加载字幕失败:', err);
      }
    }
  });
}

if (toggleSubBtn) {
  toggleSubBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    isSubtitleVisible = !isSubtitleVisible;
    renderSubtitlesAt(video.currentTime);
    showToast(isSubtitleVisible ? '显示字幕' : '隐藏字幕');
    persistSettings();
  });
}

if (subSizeUpBtn) {
  subSizeUpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    currentSubtitleFontSize = Math.min(48, currentSubtitleFontSize + 2);
    if (customSubtitle) customSubtitle.style.fontSize = `${currentSubtitleFontSize}px`;
    showToast(`字幕字号: ${currentSubtitleFontSize}px`);
    persistSettings();
  });
}

if (subSizeDownBtn) {
  subSizeDownBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    currentSubtitleFontSize = Math.max(12, currentSubtitleFontSize - 2);
    if (customSubtitle) customSubtitle.style.fontSize = `${currentSubtitleFontSize}px`;
    showToast(`字幕字号: ${currentSubtitleFontSize}px`);
    persistSettings();
  });
}

// 字幕时间整体微调（提前/延后）
if (subOffsetUpBtn) {
  subOffsetUpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    subtitleOffset = Math.max(-60, Math.min(60, subtitleOffset + 0.5));
    showToast(`字幕延后 ${subtitleOffset.toFixed(1)}s`);
    renderSubtitlesAt(video.currentTime);
    persistSettings();
  });
}

if (subOffsetDownBtn) {
  subOffsetDownBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    subtitleOffset = Math.max(-60, Math.min(60, subtitleOffset - 0.5));
    showToast(`字幕提前 ${Math.abs(subtitleOffset).toFixed(1)}s`);
    renderSubtitlesAt(video.currentTime);
    persistSettings();
  });
}

// === 续播按钮提示交互 ===
if (resumeBtn) {
  resumeBtn.addEventListener('click', () => {
    if (pendingResumeTime > 0) {
      const doResume = () => {
        video.currentTime = pendingResumeTime;
        showToast(`已为您自动续播至 ${formatTime(pendingResumeTime)}`);
      };
      if (video.duration && !isNaN(video.duration)) {
        doResume();
      } else {
        // 元数据尚未就绪，等就绪后再跳转；加载失败时清理监听器避免累积
        const onLoadError = () => {
          video.removeEventListener('loadedmetadata', onReady);
        };
        const onReady = () => {
          video.removeEventListener('error', onLoadError);
          doResume();
        };
        video.addEventListener('loadedmetadata', onReady, { once: true });
        video.addEventListener('error', onLoadError, { once: true });
      }
    }
    if (resumeToast) resumeToast.style.display = 'none';
  });
}

if (closeToastBtn) {
  closeToastBtn.addEventListener('click', () => {
    if (resumeToast) resumeToast.style.display = 'none';
  });
}

// === 播放模式控制（全部视频循环 / 全部视频随机 / 单个视频循环） ===
function updatePlayModeUI(mode, showNotification = true) {
  playMode = mode;
  persistSettings();
  if (playModeBtn) {
    const iconState = playModeBtn.querySelector('#icon-playmode-state');
    if (iconState) {
      if (mode === 'list-loop') {
        iconState.innerHTML = `<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>`;
        playModeBtn.title = '当前模式：循环播放';
      } else if (mode === 'random') {
        iconState.innerHTML = `<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>`;
        playModeBtn.title = '当前模式：随机播放';
      } else if (mode === 'single-loop') {
        iconState.innerHTML = `<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="15" font-size="8" font-weight="bold" fill="currentColor" text-anchor="middle">1</text>`;
        playModeBtn.title = '当前模式：单个循环';
      }
    }
  }

  if (playModeMenu) {
    playModeMenu.querySelectorAll('.menu-item').forEach(item => {
      item.classList.toggle('active', item.getAttribute('data-mode') === mode);
    });
  }

  if (showNotification) {
    const nameMap = {
      'list-loop': '循环播放',
      'random': '随机播放',
      'single-loop': '单个循环'
    };
    showToast(`播放模式已切换：${nameMap[mode] || mode}`);
  }
}

if (playModeBtn && playModeMenu) {
  playModeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (speedMenu) speedMenu.classList.remove('show');
    if (subtitleMenu) subtitleMenu.classList.remove('show');
    if (aspectMenu) aspectMenu.classList.remove('show');
    playModeMenu.classList.toggle('show');
  });

  playModeMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    e.stopPropagation();
    const mode = item.getAttribute('data-mode');
    if (mode) {
      updatePlayModeUI(mode, true);
    }
    playModeMenu.classList.remove('show');
  });
}

// === 顺时针旋转视频 90°（循环：0°→90°→180°→270°→0°） ===
if (rotateBtn) {
  rotateBtn.addEventListener('click', (e) => {
    currentRotation = (currentRotation + 90) % 360;
    applyVideoLayout();
    // 旋转态 UI 指示：高亮按钮 + 动态 title（与 screenshotBtn 一致，不阻止冒泡以重置控制条计时器）
    if (currentRotation > 0) {
      rotateBtn.classList.add('active');
      rotateBtn.title = `当前顺时针旋转 ${currentRotation}°（点击继续旋转）`;
    } else {
      rotateBtn.classList.remove('active');
      rotateBtn.title = '顺时针旋转 90°';
    }
    showToast(currentRotation > 0 ? `画面已顺时针旋转 ${currentRotation}°` : '画面已恢复原始方向');
  });
}

// === 高清无损截图 (异步编码，避免大画面卡顿) ===
if (screenshotBtn) {
  screenshotBtn.addEventListener('click', captureScreenshot);
}

function captureScreenshot() {
  if (!video.videoWidth || !video.videoHeight) {
    showToast('视频未加载，无法截图');
    return;
  }
  showToast('正在截图...');
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const isQuarter = (currentRotation === 90 || currentRotation === 270);
  const canvas = document.createElement('canvas');
  // 截图跟随旋转：画布宽高与旋转后的画面一致
  canvas.width = isQuarter ? vh : vw;
  canvas.height = isQuarter ? vw : vh;
  const ctx = canvas.getContext('2d');
  ctx.save();
  if (currentRotation === 90) {
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
  } else if (currentRotation === 180) {
    ctx.translate(canvas.width, canvas.height);
    ctx.rotate(Math.PI);
  } else if (currentRotation === 270) {
    ctx.translate(0, canvas.height);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(video, 0, 0, vw, vh);
  ctx.restore();

  const defaultName = `Screenshot_${Date.now()}.png`;

  canvas.toBlob((blob) => {
    if (!blob) {
      showToast('截图失败');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      if (window.electronAPI && window.electronAPI.saveScreenshot) {
        window.electronAPI.saveScreenshot(dataUrl, defaultName).then(success => {
          showToast(success ? '截图已成功保存到本地！' : '截图保存失败');
        }).catch(() => {
          showToast('截图保存失败');
        });
      }
    };
    reader.readAsDataURL(blob);
  }, 'image/png');
}

// === 全屏与窗口退出/展开 ===
function toggleFullscreen() {
  // 真正的全屏（主进程 setFullScreen），区别于窗口最大化
  if (window.electronAPI && window.electronAPI.fullscreenWindow) {
    window.electronAPI.fullscreenWindow();
  }
}

if (fullscreenBtn) fullscreenBtn.addEventListener('click', toggleFullscreen);

// 双击视频区域切换全屏
if (videoContainer) {
  videoContainer.addEventListener('dblclick', (e) => {
    if (e.target.closest('#controls-overlay') || e.target.closest('#titlebar')) return;
    // 取消待触发的单击播放，避免双击时播放状态被翻转
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
    toggleFullscreen();
  });
}

// 快捷键
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  // 如果按下了 Ctrl / Alt / Command 等系统组合功能键，不触发内置快捷键
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      togglePlayPause();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (video.src) video.currentTime = Math.max(0, video.currentTime - 5);
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (video.src && video.duration > 0 && !isNaN(video.duration)) {
        video.currentTime = Math.min(Math.max(0, video.duration - 0.2), video.currentTime + 5);
      }
      break;
    case 'ArrowUp':
      e.preventDefault();
      updateVolume(video.volume + 0.05);
      break;
    case 'ArrowDown':
      e.preventDefault();
      updateVolume(video.volume - 0.05);
      break;
    case 'KeyS':
      e.preventDefault();
      captureScreenshot();
      break;
    case 'F11':
      e.preventDefault();
      toggleFullscreen();
      break;
    case 'Escape':
      // 全屏状态下按 Esc 退出全屏
      if (window.electronAPI && typeof window.electronAPI.isFullScreen === 'function') {
        window.electronAPI.isFullScreen().then(isFs => {
          if (isFs) window.electronAPI.fullscreenWindow();
        }).catch(() => {});
      }
      break;
    case 'KeyM':
      e.preventDefault();
      if (volumeBtn) volumeBtn.click();
      break;
  }
});

// === 鼠标闲置自动隐藏工具栏逻辑 ===
function showControls() {
  if (controlBar) controlBar.classList.remove('hide');
  if (titleBar) titleBar.classList.remove('hide');

  if (controlsTimeout) clearTimeout(controlsTimeout);

  // 仅在视频处于播放状态时，3秒后自动隐藏
  if (!video.paused) {
    controlsTimeout = setTimeout(() => {
      if (controlBar) controlBar.classList.add('hide');
      if (titleBar) titleBar.classList.add('hide');
      if (speedMenu) speedMenu.classList.remove('show');
      if (subtitleMenu) subtitleMenu.classList.remove('show');
      if (aspectMenu) aspectMenu.classList.remove('show');
    }, 3000);
  }
}

if (videoContainer) {
  videoContainer.addEventListener('mousemove', showControls);
  videoContainer.addEventListener('click', showControls);
}

// === 软件无边框顶部原生控件事件绑定 ===
const btnMinimize = document.getElementById('btn-minimize');
const btnMaximize = document.getElementById('btn-maximize');
const btnClose = document.getElementById('btn-close');

if (btnMinimize) {
  btnMinimize.addEventListener('click', () => {
    window.electronAPI.minimizeWindow();
  });
}

if (btnMaximize) {
  btnMaximize.addEventListener('click', () => {
    window.electronAPI.maximizeWindow();
  });
}

if (btnClose) {
  btnClose.addEventListener('click', () => {
    window.electronAPI.closeWindow();
  });
}
