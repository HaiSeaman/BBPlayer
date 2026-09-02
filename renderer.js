// 本软件仅运行于 Electron，preload 未注入即属致命错误
if (!window.electronAPI) throw new Error('BBPlayer 必须在 Electron 环境中运行');

// === 监听外部/命令行双击打开的文件 ===
window.electronAPI.getInitialFile().then(filePath => {
  if (filePath) {
    addFilesToPlaylist([filePath]);
  }
}).catch(err => {
  console.error('获取冷启动文件失败:', err);
});

window.electronAPI.onOpenFile((filePath) => {
  if (filePath) {
    addFilesToPlaylist([filePath]);
  }
});

// 窗口最小化自动暂停（仅视频）与恢复（不弹提示：最小化时用户看不到 Toast，恢复时安静续播即可）
// 纯音频音乐模式例外：最小化不暂停，让音乐在后台继续播放（背景节流已由 backgroundThrottling:false 关闭）
let wasPlayingBeforeMinimize = false;
window.electronAPI.onWindowMinimized(() => {
  if (video && !video.paused && isVideoLoaded && !isMusicMode) {
    wasPlayingBeforeMinimize = true;
    video.pause();
    updatePlayPauseUI(false);
  }
});
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

// === 纯音频音乐播放效果层 DOM ===
const musicVisualizer = document.getElementById('music-visualizer');
const musicCoverImg = document.getElementById('music-cover-img');
const musicCoverFallback = document.getElementById('music-cover-fallback');
const musicTitleEl = document.getElementById('music-title');
const musicMetaEl = document.getElementById('music-meta');
const musicSpectrumCanvas = document.getElementById('music-spectrum');

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
let playlist = []; // 存储 { target, name, key }
let currentPlaylistIndex = -1;
let playlistView = 'list'; // 'list' | 'history'

// === 全局状态 ===
let currentFilePath = '';
let hasRealPath = false; // 是否具有物理路径（决定是否记播放历史）
let isSeeking = false;
let titlebarIdleTimer = null; // 标题栏 3 秒闲置兜底计时器
let titlebarHideTimer = null; // 标题栏移出感应区后的延迟隐藏计时器
let controlsIdleTimer = null; // 底部功能栏 3 秒闲置兜底计时器
const CONTROLS_HOTZONE_HEIGHT = 120; // 底部感应区高度（像素）：鼠标进入此范围功能栏才出现
const TITLEBAR_HOTZONE_HEIGHT = 56; // 顶部感应区高度（像素）：标题栏 42px + 14px 余量，鼠标接近顶部即唤出
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

// === 纯音频音乐模式状态 ===
// 音频扩展名（与 shared-video-exts.js / preload.js 保持一致；注意 m4v 是视频，别混进来）
const AUDIO_EXTS = new Set(['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac']);
let isMusicMode = false;        // 当前是否处于"纯音频音乐播放效果"模式
let musicAnimFrame = null;      // 频谱动画 requestAnimationFrame 句柄
let musicCoverToken = 0;        // 封面异步加载令牌：换歌后旧封面结果作废

// 判断是否为音频扩展名（用于跳字幕查找等同步分支）
function isAudioExt(p) {
  if (!p || typeof p !== 'string') return false;
  const dot = p.lastIndexOf('.');
  if (dot < 0) return false;
  return AUDIO_EXTS.has(p.substring(dot + 1).toLowerCase());
}

// === 音量增益管线（Web Audio：音量可放大到 0%~200%，带防破音保护） ===
// 原理：在 <video> 与扬声器之间加装“数字功放”。video.volume 被系统限制在 0~1（0%~100%），
// 但 GainNode 放大倍率无上限，可把音频信号物理放大到 200% 甚至更高。
let audioCtx = null;
let gainNode = null;
let audioPipelineReady = false; // 增益管线是否可用（初始化失败则回退原生音量 0~100%）
let masterVolume = 1.0;         // 用户音量 0.0 ~ 2.0：0~1 原生区，1~2 增益放大区
let analyserNode = null;        // 频谱分析器（从管线分路读取实时频率数据，供音乐模式可视化）

// 惰性初始化音频增益管线。铁律：同一个 <video> 一生只能绑定一次 MediaElementSource，
// 重复绑定会抛错，因此必须保证本函数只成功执行一次（换片/切歌时绝不重建）。
function initAudioPipeline() {
  if (audioPipelineReady) return true;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return false;

    audioCtx = new AudioContextClass();

    // 1) 视频声源接入调音台（仅此一次，成功后永久绑定）
    const sourceNode = audioCtx.createMediaElementSource(video);

    // 2) 增益放大器：负责 100%~200% 的扩展音量
    gainNode = audioCtx.createGain();
    gainNode.gain.value = 1.0;

    // 3.5) 频谱分析器（只读分流，不改变音质）：接在增益后、压缩前，
    //     可视化数据反映用户实际听到的（含增益效果）信号
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;                 // 128 个频率桶，足够绘制细腻频谱
    analyserNode.smoothingTimeConstant = 0.82;  // 时间平滑：柱子过渡更柔和自然

    // 4) 防破音动态压缩器（安全气囊）：常规音量（峰值低于 -3dB）完全不受影响，
    //    一旦放大后接近 0dB 峰值，自动柔和削平毛刺，防止喇叭“滋啦”破音。
    const compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-3, audioCtx.currentTime);
    compressor.knee.setValueAtTime(6, audioCtx.currentTime);
    compressor.ratio.setValueAtTime(20, audioCtx.currentTime);
    compressor.attack.setValueAtTime(0.002, audioCtx.currentTime);
    compressor.release.setValueAtTime(0.1, audioCtx.currentTime);

    // 5) 串联管线：视频源 -> 增益放大器 -> 频谱分析器 -> 防破音压缩器 -> 扬声器
    sourceNode.connect(gainNode);
    gainNode.connect(analyserNode);
    analyserNode.connect(compressor);
    compressor.connect(audioCtx.destination);

    audioPipelineReady = true;
    console.log('[BBPlayer] 音频增益管线已就绪：音量支持 0%~200%，防破音已启用');
    // 兜底激活调音台：部分自动播放策略下 AudioContext 会处于挂起状态
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return true;
  } catch (err) {
    console.warn('音频增益管线初始化失败，回退到原生音量控制(0%~100%):', err);
    audioPipelineReady = false;
    return false;
  }
}

// === 纯音频音乐播放效果：频谱动画 + 封面 + 歌名 ===
// 频谱数据来源：initAudioPipeline 创建的 analyserNode（只读分流，不影响音量/防破音链路）。

// 按当前窗口尺寸重新铺设频谱画布（含高分屏清晰度补偿）
function setupSpectrumCanvas() {
  if (!musicSpectrumCanvas || !musicVisualizer) return;
  const rect = musicVisualizer.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.min(rect.width * 0.64, 720);
  const h = 64;
  musicSpectrumCanvas.style.width = w + 'px';
  musicSpectrumCanvas.style.height = h + 'px';
  musicSpectrumCanvas.width = Math.round(w * dpr);
  musicSpectrumCanvas.height = Math.round(h * dpr);
}

// 绘制一帧频谱柱状图（32 根细渐变圆角柱，青→紫，顶部亮、底部融入背景）
function drawSpectrumFrame() {
  if (!isMusicMode) { musicAnimFrame = null; return; }
  if (video.paused) {
    // 暂停即停：清空画布（干净利落），不再空转耗电
    musicAnimFrame = null;
    if (musicSpectrumCanvas && musicSpectrumCanvas.width > 0) {
      const c2 = musicSpectrumCanvas.getContext('2d');
      if (c2) c2.clearRect(0, 0, musicSpectrumCanvas.width, musicSpectrumCanvas.height);
    }
    return;
  }
  const ctx = musicSpectrumCanvas && musicSpectrumCanvas.getContext('2d');
  if (!ctx || !analyserNode) { musicAnimFrame = null; return; }
  const W = musicSpectrumCanvas.width;
  const H = musicSpectrumCanvas.height;
  if (!W || !H) { musicAnimFrame = null; return; }

  const bins = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteFrequencyData(bins);

  const barCount = 32;
  // 只取低频到中频段（前 96 桶），人耳最敏感、视觉最"音乐"
  const usable = Math.min(bins.length, 96);
  const step = Math.max(1, Math.floor(usable / barCount));

  ctx.clearRect(0, 0, W, H);
  const gap = Math.max(2, W * 0.008);
  const bw = (W - gap * (barCount - 1)) / barCount;

  for (let i = 0; i < barCount; i++) {
    let sum = 0;
    for (let j = 0; j < step; j++) sum += bins[Math.min(i * step + j, bins.length - 1)];
    const v = (sum / step) / 255;
    // 底部留出低亮"基座"，柱子最高 88% 高度
    const bh = Math.max(3, v * H * 0.88);
    const x = i * (bw + gap);
    const hue = 190 + (i / barCount) * 80; // 190(青) → 270(紫)
    const grad = ctx.createLinearGradient(0, H - bh, 0, H);
    grad.addColorStop(0, `hsla(${hue}, 95%, 66%, 0.95)`);  // 柱顶亮
    grad.addColorStop(1, `hsla(${hue}, 95%, 62%, 0.10)`);  // 柱底融入背景
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, H - bh, bw, bh, Math.min(bw / 2, 2.5));
    ctx.fill();
  }

  musicAnimFrame = requestAnimationFrame(drawSpectrumFrame);
}

// 从封面图采样主色，把背景渐变与环境光晕染成歌的主色调（Ambient 风格）。
// file:// 页面下 canvas 读本地图一般允许；万一被污染/受限，catch 后保留默认深色背景，绝不崩。
function applyCoverGlow(imgEl) {
  if (!musicVisualizer || !imgEl) return;
  try {
    const probe = document.createElement('canvas');
    probe.width = probe.height = 24;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(imgEl, 0, 0, 24, 24);
    const d = ctx.getImageData(0, 0, 24, 24).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    if (!n) return;
    r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
    // 背景用压暗 45% 的主色做光源；光晕直接用主色半透明
    musicVisualizer.style.background =
      `radial-gradient(ellipse 130% 95% at 50% 22%, rgb(${(r * 0.55) | 0},${(g * 0.55) | 0},${(b * 0.55) | 0}) 0%, #101a30 58%, #070b16 100%)`;
    musicVisualizer.style.setProperty('--cover-glow', `rgba(${r},${g},${b},0.35)`);
  } catch (err) {
    // 忽略：保留默认背景
  }
}

// 切换进入音乐模式：显示效果层、铺设画布、隐藏音频无意义的按钮、异步加载封面
async function enterMusicMode(filePath, displayName) {
  isMusicMode = true;
  if (musicVisualizer) {
    musicVisualizer.style.display = 'flex';
    setupSpectrumCanvas();
  }
  if (musicTitleEl) musicTitleEl.textContent = displayName || '未命名曲目';

  // 元信息行：格式 · 时长（loadedmetadata 后 duration 已可用）
  if (musicMetaEl) {
    const ext = (typeof filePath === 'string' && filePath.includes('.'))
      ? filePath.split('.').pop().toUpperCase() : '';
    const dur = (Number.isFinite(video.duration) && video.duration > 0) ? formatTime(video.duration) : '';
    musicMetaEl.textContent = [ext, dur].filter(Boolean).join(' · ');
  }

  // 音频没有画面可截、没有字幕可挂：隐藏相关按钮并收起字幕菜单
  if (subtitleBtn) subtitleBtn.style.display = 'none';
  if (screenshotBtn) screenshotBtn.style.display = 'none';
  if (subtitleMenu) subtitleMenu.classList.remove('show');

  // 封面：异步查找，令牌防串台（快速切歌时旧封面不覆盖新歌）
  const token = ++musicCoverToken;
  let coverUrl = null;
  if (filePath) {
    try { coverUrl = await window.electronAPI.findCover(filePath); } catch (err) { coverUrl = null; }
  }
  if (token !== musicCoverToken) return; // 已切换到别的媒体，丢弃本次结果
  if (coverUrl && musicCoverImg) {
    const myToken = token;
    musicCoverImg.onload = () => {
      if (myToken !== musicCoverToken) return; // 旧歌封面晚到：丢弃，不覆盖新歌
      musicCoverImg.style.display = 'block';
      if (musicCoverFallback) musicCoverFallback.style.display = 'none';
      applyCoverGlow(musicCoverImg);
    };
    musicCoverImg.onerror = () => {
      if (myToken !== musicCoverToken) return;
      musicCoverImg.style.display = 'none';
      if (musicCoverFallback) musicCoverFallback.style.display = 'flex';
    };
    musicCoverImg.src = coverUrl;
  } else {
    if (musicCoverImg) musicCoverImg.style.display = 'none';
    if (musicCoverFallback) musicCoverFallback.style.display = 'flex';
    // 无封面：恢复默认深色背景，避免残留上一首的环境光染色
    if (musicVisualizer) {
      musicVisualizer.style.background = '';
      musicVisualizer.style.removeProperty('--cover-glow');
    }
  }

  // 若正在播放，立即启动频谱动画（暂停状态等 play 事件再启动）
  if (!video.paused && !musicAnimFrame) drawSpectrumFrame();
}

// 退出音乐模式（切回视频或清空播放器）：隐藏效果层、停动画、恢复按钮
function exitMusicMode() {
  isMusicMode = false;
  musicCoverToken++; // 作废未落地的封面加载
  if (musicAnimFrame) { cancelAnimationFrame(musicAnimFrame); musicAnimFrame = null; }
  if (musicVisualizer) musicVisualizer.style.display = 'none';
  if (subtitleBtn) subtitleBtn.style.display = '';
  if (screenshotBtn) screenshotBtn.style.display = '';
}

// 统一应用音量：masterVolume 范围 0~2。
// 增益可用时：video.volume 固定满格，总音量完全交给 gainNode 放大；
// 增益不可用（初始化失败回退）：直接限制在原生 0~1。
function applyMasterVolume() {
  const clamped = Math.max(0, Math.min(2.0, masterVolume));
  masterVolume = clamped;

  if (audioPipelineReady && audioCtx && gainNode) {
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const now = audioCtx.currentTime;
    gainNode.gain.cancelScheduledValues(now);
    // 指数平滑过渡（约 10ms 趋近目标），防止瞬间拉高音量产生“啪”的爆音
    gainNode.gain.setTargetAtTime(clamped, now, 0.01);
    video.volume = 1; // 增益模式下视频元素保持满格
  } else {
    video.volume = Math.min(1.0, clamped);
  }

  // UI 同步：滑块值、音量图标、超量警示样式与按钮提示
  if (volumeSlider) volumeSlider.value = String(clamped);
  setVolumeIcon(clamped);
  if (volumeSlider) volumeSlider.classList.toggle('boost', clamped > 1);
  if (volumeBtn) {
    volumeBtn.title = clamped > 1
      ? `音量 ${Math.round(clamped * 100)}%（增益放大，已开启防破音）`
      : `音量 ${Math.round(clamped * 100)}% / 静音`;
  }
}

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

// 倍速显示统一格式：整数保留一位小数（1.0x），非整数原样（1.25x），避免 toFixed(1) 把 1.25 显示成 1.3x
function formatSpeed(speed) {
  return `${Number.isInteger(speed * 10) ? speed.toFixed(1) : String(speed)}x`;
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

// === 播放历史存取（限制条数） ===
function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}');
    const out = {};
    for (const [key, val] of Object.entries(raw)) {
      if (val && typeof val === 'object' && typeof val.t === 'number') {
        out[key] = val;
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
      volume: masterVolume,
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
    initAudioPipeline(); // 先初始化增益管线，让恢复的音量走统一“数字功放”管道
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    // 音量范围 0~200%：旧存档只有 0~1，直接兼容；非法值或损坏数据钳制回安全范围
    if (typeof s.volume === 'number' && isFinite(s.volume)) masterVolume = Math.max(0, Math.min(2, s.volume));
    // 倍速必须钳制在合法范围：localStorage 损坏存入 0/负数/超大值时，
    // playbackRate 赋值会抛异常并中断后续所有设置的恢复
    if (typeof s.speed === 'number' && isFinite(s.speed) && s.speed >= 0.25 && s.speed <= 4) currentSpeed = s.speed;
    if (typeof s.subtitleOffset === 'number') subtitleOffset = Math.max(-60, Math.min(60, s.subtitleOffset));
    if (typeof s.subtitleFontSize === 'number') currentSubtitleFontSize = Math.max(12, Math.min(48, s.subtitleFontSize));
    if (typeof s.subtitleVisible === 'boolean') isSubtitleVisible = s.subtitleVisible;
    if (s.playMode && ['list-loop', 'random', 'single-loop'].includes(s.playMode)) {
      playMode = s.playMode;
    }
    updatePlayModeUI(playMode, false);
    if (customSubtitle) {
      customSubtitle.style.fontSize = `${currentSubtitleFontSize}px`;
      customSubtitle.style.display = isSubtitleVisible ? 'block' : 'none';
    }
    // 字幕开关菜单文案与恢复的状态保持一致
    if (toggleSubBtn) toggleSubBtn.textContent = isSubtitleVisible ? '隐藏字幕' : '显示字幕';
    applyMasterVolume(); // 应用恢复的 0~200% 音量并统一同步滑块/图标/警示样式
    if (speedBtn) speedBtn.textContent = formatSpeed(currentSpeed);
    if (speedMenu) {
      speedMenu.querySelectorAll('.menu-item').forEach(i => {
        i.classList.toggle('active', parseFloat(i.getAttribute('data-speed')) === currentSpeed);
      });
    }
  } catch (e) {
    console.error('恢复设置失败:', e);
  }
})();

// 全局保存创出的 Blob URL，方便垃圾回收释放
let currentBlobUrl = null;

function revokeCurrentBlobUrl() {
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
}

let autoNextTimer = null;

// 加载序号令牌：loadAndPlayVideo 已异步化（等待主进程转 URL），
// 快速连续切换视频时旧调用在 await 后作废，防止交错写入播放器状态
let loadSequence = 0;

// 连续播放失败集合（成功加载元数据时清空）；列表内所有条目都失败过才停止自动跳转
let failedPlaylistKeys = new Set();

function clearAutoNextTimer() {
  if (autoNextTimer) {
    clearTimeout(autoNextTimer);
    autoNextTimer = null;
  }
}

// === 核心：通用视频加载与播放函数 (双重保险机制) ===
async function loadAndPlayVideo(filePathOrFile) {
  if (!filePathOrFile) return;

  const seq = ++loadSequence; // 本次加载的令牌

  let targetSrc = '';
  let fileName = '';
  let fullPath = '';
  hasRealPath = false;

  if (typeof filePathOrFile === 'string') {
    fullPath = filePathOrFile;
    fileName = filePathOrFile.split(/[\\/]/).pop();
    hasRealPath = true;
    targetSrc = await window.electronAPI.toFileUrl(fullPath);
  } else if (filePathOrFile instanceof File) {
    fileName = filePathOrFile.name;
    // 从原生 API 提取物理路径（失败时返回空串，走 Blob 播放）
    const extractedPath = window.electronAPI.getFilePath(filePathOrFile);

    if (extractedPath) {
      fullPath = extractedPath;
      hasRealPath = true;
      targetSrc = await window.electronAPI.toFileUrl(extractedPath);
    } else {
      // 降级双保险：URL.createObjectURL(file) 内存直接播放（无物理路径，不记历史）
      revokeCurrentBlobUrl();
      currentBlobUrl = URL.createObjectURL(filePathOrFile);
      targetSrc = currentBlobUrl;
      fullPath = filePathOrFile.name;
    }
  }

  // 异步等待期间用户已切换到其他视频：本次加载整体作废，避免旧状态覆盖新视频
  if (seq !== loadSequence) return;

  if (!targetSrc) {
    showToast('无法解析媒体源');
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

  // 重置续播状态（新视频不沿用上一部的续播提示）
  pendingResumeTime = 0;
  if (resumeToast) resumeToast.style.display = 'none';

  // 重置进度打卡基准（防止新旧视频秒数撞车丢一次保存）
  lastSavedProgressSec = -1;

  // 字幕状态重置完成后，若本次加载的正是随拖字幕配套的视频，立即应用登记的字幕
  tryApplyPendingDropSubtitle();

  video.src = targetSrc;

  // 保留并应用当前的倍速设置
  video.playbackRate = currentSpeed;

  // 隐藏无视频空状态
  if (emptyState) emptyState.style.display = 'none';
  isVideoLoaded = true;

  // 尝试自动播放（带令牌校验：快速连播时旧视频的异步回调不覆盖新视频的播放状态 UI）
  video.play().then(() => {
    if (seq !== loadSequence) return;
    // 播放成功但用户已手动暂停（如播放中立刻按了暂停）：以元素实际状态为准
    if (video.paused) { updatePlayPauseUI(false); return; }
    updatePlayPauseUI(true);
  }).catch((err) => {
    if (seq !== loadSequence) return;
    console.warn('自动播放被阻断，等待手动触发:', err);
    updatePlayPauseUI(false);
  });

  showToast(`已加载: ${fileName}`);

  // 检查并自动加载同目录下的同名字幕 (仅当有物理路径且确为视频时；音频文件无字幕，避免同名 .srt 被误挂)
  if (hasRealPath && !isAudioExt(fullPath)) {
    // 仅当最后一个 '.' 位于路径分隔符之后才视为扩展名（目录名含点不算），避免 C:\a.b\movie 被误截断
    const lastDot = fullPath.lastIndexOf('.');
    const lastSep = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
    if (lastDot > lastSep) {
      const basePath = fullPath.substring(0, lastDot);
      checkAndAutoLoadSubtitles(basePath);
    }
  }

  // 检查播放历史记忆（仅真实路径）
  // 等元数据就绪后再判断，确保"接近完结"过滤使用真实 duration；
  // 带令牌校验，避免旧视频的续播检查误应用到新视频；加载失败时也要清理，防止监听器累积
  if (hasRealPath) {
    const resumeToken = fullPath;
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onError);
    };
    const onMeta = () => {
      cleanup();
      if (currentFilePath === resumeToken) checkHistoryResume(resumeToken);
    };
    const onError = () => cleanup();
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', onError);
  }
}

// 通过主进程读取字幕文件（避免 fetch file:// 的路径编码与 CORS 问题）
async function loadSubtitleFromPath(filePath, expectedVideoPath) {
  if (!filePath) return false;
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

// 检查同名本地字幕（依次尝试 .srt / .vtt / .ass / .ssa，与主进程白名单一致）
async function checkAndAutoLoadSubtitles(basePath) {
  const videoKey = currentFilePath; // 发起时的视频路径（令牌）
  for (const ext of ['.srt', '.vtt', '.ass', '.ssa']) {
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
  if (saved && saved.t >= 5) {
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

// 自动打卡记录播放进度（暂停或进度未变时跳过，避免无谓的解析/排序/写盘）
let lastSavedProgressSec = -1;
function saveCurrentProgress() {
  if (!currentFilePath || !hasRealPath) return;
  if (video.paused || !video.duration || video.currentTime < 3) return;
  const sec = Math.floor(video.currentTime);
  if (sec === lastSavedProgressSec) return;
  lastSavedProgressSec = sec;
  saveHistoryEntry(currentFilePath, video.currentTime);
}

// 定时保存进度 (每 5 秒打卡)
setInterval(saveCurrentProgress, 5000);

// === 点击“打开本地视频文件”按键交互（支持多选） ===
if (openFileBtn) {
  openFileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.electronAPI.openFileDialog().then(files => {
      if (files && files.length > 0) {
        addFilesToPlaylist(files);
      }
    }).catch(err => {
      console.error('打开文件对话框失败:', err);
    });
  });
}

// === 打开整个文件夹，把其中视频全部加入播放列表 ===
async function openFolderAndAdd() {
  try {
    const result = await window.electronAPI.openFolderDialog();
    if (result === null) return; // 用户取消选择
    const { files, truncated } = result;
    if (!files || files.length === 0) {
      showToast('所选文件夹中没有视频文件');
      return;
    }
    const added = addFilesToPlaylist(files);
    if (added > 0) {
      showToast(`已添加文件夹中的 ${added} 个视频${truncated ? '（文件夹较大，超出上限的部分未载入）' : ''}`);
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

// 判断是否具有可被新窗口打开的本地绝对路径（Windows 盘符或 UNC 网络路径）。
// 拖拽且无物理路径的临时文件（blob 播放）无法在另一窗口打开，需提示用户
function canOpenInNewWindow(p) {
  return typeof p === 'string' && /^([a-zA-Z]:[\\/]|[\\/]{2})/.test(p);
}

// 在新窗口播放当前正在播放的视频（多视频同时播放）
const btnNewWindow = document.getElementById('btn-new-window');
if (btnNewWindow) {
  btnNewWindow.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!currentFilePath) {
      showToast('当前没有正在播放的视频');
      return;
    }
    if (!canOpenInNewWindow(currentFilePath)) {
      showToast('该视频无本地路径，无法在新窗口播放');
      return;
    }
    window.electronAPI.openInNewWindow(currentFilePath);
  });
}

// === 强力全域拖拽播放支持 (丢入软件任意区域均能识别播放) ===

// 字幕编码嗅探：BOM 识别 → UTF-8 严格解码 → GBK 回退（中文 ANSI 老字幕必备）。
// 与 main.js 中主进程 readText 路径的 decodeSubtitleBuffer 保持同步。
function decodeSubtitleBuffer(bytes) {
  if (!bytes || bytes.length === 0) return '';
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch (e2) {
      return new TextDecoder('latin1').decode(bytes); // 终极兜底，至少不抛异常
    }
  }
}

// 随视频一起拖入的字幕登记处：{ forVideo, text }。
// 视频 URL 转换与字幕文件解码都是异步的，先后顺序不定，
// 因此双方完成后各自查登记表，谁后到谁触发应用（事件驱动，避免轮询与竞态）
let pendingDropSubtitle = null;

// 尝试应用登记中的字幕：仅当字幕文本已解码且当前播放的正是配套视频时生效
function tryApplyPendingDropSubtitle() {
  if (!pendingDropSubtitle || !pendingDropSubtitle.text) return;
  if (currentFilePath !== pendingDropSubtitle.forVideo) return;
  parseAndApplySubtitle(pendingDropSubtitle.text);
  showToast('已加载拖入的字幕');
  pendingDropSubtitle = null;
}

// 拖入字幕文件：读 ArrayBuffer 后按编码嗅探解码，避免 GBK 字幕按 UTF-8 读出乱码
function loadDraggedSubtitle(file, forVideoKey) {
  file.arrayBuffer().then((buf) => {
    const text = decodeSubtitleBuffer(new Uint8Array(buf));
    if (forVideoKey) {
      // 与视频混拖：登记后由 tryApplyPendingDropSubtitle 择机应用。
      // 无条件覆盖旧登记：旧登记未被应用说明配套视频已被切走或字幕损坏，已无保留价值
      pendingDropSubtitle = { forVideo: forVideoKey, text };
      tryApplyPendingDropSubtitle();
    } else if (text) {
      // 仅拖字幕：直接应用到当前画面
      parseAndApplySubtitle(text);
      showToast('已加载拖入的字幕');
    }
  }).catch((err) => {
    console.warn('读取拖入字幕失败:', err);
    if (!forVideoKey) showToast('读取字幕文件失败');
  });
}

let dragDepth = 0; // 嵌套计数：dragenter/dragleave 成对触发，归零才算真正离开窗口
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  if (videoContainer) videoContainer.classList.add('drag-over');
});
window.addEventListener('dragover', (e) => {
  e.preventDefault(); // 必须阻止默认行为，否则浏览器会直接打开被拖入的文件
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0 && videoContainer) videoContainer.classList.remove('drag-over');
});

window.addEventListener('drop', (e) => {
  e.preventDefault(); // 阻止浏览器默认打开被拖入的文件
  dragDepth = 0;
  if (videoContainer) videoContainer.classList.remove('drag-over');

  const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
  if (files.length === 0) return;

  // 视频扩展名与主进程共享同一份列表（preload 注入）
  const videoExtensions = window.electronAPI.videoExtensions;
  const videoFiles = files.filter(f => {
    // 过滤掉非视频扩展名以及大小为0或类似文件夹的非法条目
    if (!f.name || f.size === 0 || (f.type === '' && !f.name.includes('.'))) return false;
    const ext = f.name.split('.').pop().toLowerCase();
    return videoExtensions.includes(ext);
  });

  const subtitleFiles = files.filter(f => {
    const ext = f.name.split('.').pop().toLowerCase();
    return ['srt', 'vtt', 'ass', 'ssa'].includes(ext);
  });

  // 处理拖入的视频（同时拖了视频+字幕时也照常加入列表）
  if (videoFiles.length > 0) {
    // 记录第一个视频的唯一 key：若它随后被自动播放，配套字幕才能安全应用
    const firstVideoKey = window.electronAPI.getFilePath(videoFiles[0]) || videoFiles[0].name;
    addFilesToPlaylist(videoFiles);

    if (subtitleFiles.length > 0) {
      loadDraggedSubtitle(subtitleFiles[0], firstVideoKey);
    }
    return;
  }

  // 仅拖入字幕：直接应用到当前播放画面
  if (subtitleFiles.length > 0) {
    loadDraggedSubtitle(subtitleFiles[0], null);
  }
});

// === 播放列表管理功能 ===
function addFilesToPlaylist(fileList) {
  const existingKeys = new Set(playlist.map(item => item.key)); // O(1) 去重，替代 O(n²) 的逐项 some 扫描
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
      key = window.electronAPI.getFilePath(fileOrPath) || name;
    }
    if (!key) return;
    // 防止重复添加（按唯一 key；同一批次内的重复也拦截）
    if (!existingKeys.has(key)) {
      existingKeys.add(key);
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

  // DocumentFragment 批量构建后一次性挂载，避免大列表逐条插入造成的多次回流
  const frag = document.createDocumentFragment();
  playlist.forEach((item, index) => {
    const div = document.createElement('div');
    div.className = `playlist-item ${index === currentPlaylistIndex ? 'active' : ''}`;
    div.dataset.index = String(index);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name';
    nameSpan.textContent = `${index + 1}. ${item.name}`;
    nameSpan.title = item.name;

    // 在新窗口播放该视频（多视频同时播放）
    const newWinBtn = document.createElement('span');
    newWinBtn.className = 'new-win-btn';
    newWinBtn.textContent = '↗';
    newWinBtn.title = '在新窗口播放';

    const removeBtn = document.createElement('span');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '✕';
    removeBtn.title = '从列表移除';

    div.appendChild(nameSpan);
    div.appendChild(newWinBtn);
    div.appendChild(removeBtn);
    frag.appendChild(div);
  });

  playlistItemsContainer.innerHTML = '';
  playlistItemsContainer.appendChild(frag);
}

// 播放列表点击统一走事件委托（绑定一次，条目再多也只有单个监听器）
if (playlistItemsContainer) {
  playlistItemsContainer.addEventListener('click', (e) => {
    if (playlistView !== 'list') return; // 历史视图条目有自己的独立绑定
    const itemDiv = e.target.closest('.playlist-item');
    if (!itemDiv || !itemDiv.dataset.index) return;
    const index = Number(itemDiv.dataset.index);
    if (!Number.isInteger(index) || index < 0 || index >= playlist.length) return;
    if (e.target.classList.contains('remove-btn')) {
      e.stopPropagation();
      removePlaylistItem(index);
    } else if (e.target.classList.contains('new-win-btn')) {
      e.stopPropagation();
      const item = playlist[index];
      if (item && item.key) {
        if (!canOpenInNewWindow(item.key)) {
          showToast('该视频无本地路径，无法在新窗口播放');
          return;
        }
        window.electronAPI.openInNewWindow(item.key);
      }
    } else {
      playPlaylistItem(index);
    }
  });
}

// 删除单条观看历史
function deleteHistoryEntry(pathKey) {
  try {
    const history = loadHistory();
    delete history[pathKey];
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    showToast('已删除该条观看历史');
  } catch (e) {
    console.error('删除历史失败:', e);
  }
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

  // 批量挂载：先拼进 DocumentFragment 再一次性插入，减少逐条插入引发的多次重排
  const frag = document.createDocumentFragment();
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

    const removeBtn = document.createElement('span');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '✕';
    removeBtn.title = '删除该条历史';

    div.appendChild(nameSpan);
    div.appendChild(timeSpan);
    div.appendChild(removeBtn);

    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteHistoryEntry(filePath);
      renderHistoryView();
    });

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

    frag.appendChild(div);
  });
  playlistItemsContainer.appendChild(frag);
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

// 将播放器重置为空状态（播放列表由调用方清空）
function resetPlayerToEmpty() {
  clearAutoNextTimer(); // 挂起的"1秒后自动切集"必须作废，防止清空后误播新加入的视频
  currentPlaylistIndex = -1;
  hasRealPath = false;
  currentFilePath = '';
  currentSubtitleData = [];
  pendingResumeTime = 0;
  lastSavedProgressSec = -1;
  revokeCurrentBlobUrl();
  if (customSubtitle) customSubtitle.style.display = 'none';
  if (resumeToast) resumeToast.style.display = 'none';
  video.src = '';
  video.load();
  exitMusicMode(); // 清空播放器时撤掉音乐效果层，避免残留
  if (emptyState) emptyState.style.display = 'flex';
  isVideoLoaded = false;
  updatePlayPauseUI(false); // 复位播放/暂停图标（清空时可能正处于播放中）
}

// 清空播放列表（历史视图下则清空观看历史）
if (playlistClearBtn) {
  playlistClearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (playlistView === 'history') {
      try {
        localStorage.removeItem(HISTORY_KEY);
        renderHistoryView();
        showToast('观看历史已清空');
      } catch (err) {
        console.error('清空历史失败:', err);
      }
      return;
    }
    playlist = [];
    resetPlayerToEmpty();
    if (playlistView !== 'list') togglePlaylistView(); // 切回列表视图让清空结果可见
    renderPlaylist();
    showToast('播放列表已清空');
  });
}

// 随机选一个不同于当前的播放索引（列表仅 1 项时只能重播自己）
function randomIndexExcluding(excludeIdx) {
  if (playlist.length === 1) return 0;
  const pool = [];
  for (let i = 0; i < playlist.length; i++) {
    if (i !== excludeIdx) pool.push(i);
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

function playPlaylistItem(index) {
  clearAutoNextTimer();
  if (index < 0 || index >= playlist.length) return;
  const prevIndex = currentPlaylistIndex;
  currentPlaylistIndex = index;
  // 列表 DOM 与数据同步时仅移动高亮条目，避免整列表重建（不同步则退回全量渲染）
  const items = playlistItemsContainer ? playlistItemsContainer.children : [];
  if (playlistView === 'list' && items.length === playlist.length) {
    if (prevIndex >= 0 && items[prevIndex]) items[prevIndex].classList.remove('active');
    if (items[index]) items[index].classList.add('active');
  } else {
    renderPlaylist();
  }
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
      resetPlayerToEmpty();
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
      // UI 跟随 play() 结果：成功才显示播放中，失败保持暂停态，避免假状态
      video.play().then(() => updatePlayPauseUI(true)).catch(() => updatePlayPauseUI(false));
      return;
    }

    if (playlist.length > 0) {
      clearAutoNextTimer();
      let nextIndex = -1;

      if (playMode === 'random') {
        nextIndex = randomIndexExcluding(currentPlaylistIndex);
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

// 上一首 / 下一首（随机模式下随机跳转，否则顺序循环）
function skipPlaylist(step) {
  if (playlist.length === 0) return;
  if (playMode === 'random' && playlist.length > 1) {
    playPlaylistItem(randomIndexExcluding(currentPlaylistIndex));
  } else {
    const delta = currentPlaylistIndex + step;
    const next = delta < 0 ? playlist.length - 1 : delta % playlist.length;
    playPlaylistItem(next);
  }
}

if (prevBtn) {
  prevBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    skipPlaylist(-1);
  });
}

if (nextBtn) {
  nextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    skipPlaylist(1);
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
    video.play().then(() => {
      updatePlayPauseUI(true);
    }).catch((err) => {
      console.warn('播放失败:', err);
      updatePlayPauseUI(false);
    });
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
    initialWinX = window.screenX;
    initialWinY = window.screenY;

    // rAF 合帧：拖拽每秒可达 60-120 次 pointermove，窗口位置只需每帧同步一次
    let dragRafPending = false;
    let dragTarget = { x: 0, y: 0 };
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

      if (isDraggingWindow) {
        dragTarget = { x: initialWinX + deltaX, y: initialWinY + deltaY };
        if (!dragRafPending) {
          dragRafPending = true;
          requestAnimationFrame(() => {
            dragRafPending = false;
            window.electronAPI.moveWindow(dragTarget);
          });
        }
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

// === 菜单互斥与统一关闭 ===
function closeAllMenus(except) {
  [speedMenu, subtitleMenu, aspectMenu, playModeMenu].forEach(menu => {
    if (menu && menu !== except) menu.classList.remove('show');
  });
}

// 点击任意非菜单区域关闭菜单
document.addEventListener('click', () => closeAllMenus());

// === 字幕菜单与字幕控制绑定 ===
if (subtitleBtn && subtitleMenu) {
  subtitleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMenus(subtitleMenu);
    subtitleMenu.classList.toggle('show');
  });
}

video.addEventListener('timeupdate', () => {
  // 时长 0 / Infinity / NaN 时进度不可算，跳过（避免写入 NaN%/Infinity% 无效样式值）
  if (isSeeking || !isFinite(video.duration) || video.duration <= 0) return;
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
  failedPlaylistKeys.clear(); // 成功加载，清空失败记录
  // 换源后 Chromium 会将倍速重置为 1.0，元数据就绪时重新应用用户设置
  video.playbackRate = currentSpeed;
  if (progressFill) progressFill.style.width = '0%';
  if (currentTimeEl) currentTimeEl.textContent = formatTime(0);
  if (durationEl) durationEl.textContent = formatTime(video.duration);

  // 通知主进程调整窗口尺寸及固定宽高比，彻底消除上下左右黑边
  if (video.videoWidth && video.videoHeight) {
    window.electronAPI.resizeToVideo({
      width: video.videoWidth,
      height: video.videoHeight
    }).catch(err => console.warn('窗口自适应失败:', err));
  }

  // 纯音频判定：无视频轨时 videoWidth/videoHeight 为 0（实测确认），切换音乐播放效果模式
  if (!video.videoWidth && !video.videoHeight) {
    const displayName = currentFilePath
      ? currentFilePath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') || ''
      : '';
    enterMusicMode(currentFilePath, displayName);
  } else {
    exitMusicMode();
  }
});

// 频谱动画跟随播放状态：播放即动、暂停即停（省电，不空转）
video.addEventListener('play', () => {
  // AudioContext 挂起兜底：自动播放策略收紧/长时间挂起后，每次播放都尝试唤醒音频上下文，否则会无声且无提示
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  if (isMusicMode && !musicAnimFrame) drawSpectrumFrame();
});
video.addEventListener('pause', () => {
  if (musicAnimFrame) { cancelAnimationFrame(musicAnimFrame); musicAnimFrame = null; }
});

// 视频加载失败提示（损坏文件 / 不支持的格式）
video.addEventListener('error', () => {
  updatePlayPauseUI(false);
  // 主动清空播放器(src='' + load())也会触发 error，此时不提示
  if (!isVideoLoaded) return;
  exitMusicMode(); // 文件加载失败：撤掉残留的音乐界面（若上一首是纯音频），等下一个文件 loadedmetadata 再重建
  const ext = currentFilePath ? currentFilePath.split('.').pop().toLowerCase() : '';
  showToast(`播放失败：系统无法解码该文件 (${ext || '未知的编码类型'})`);

  // 若在播放列表中播放失败，延迟 1.5 秒自动跳到下一个"没失败过"的媒体；
  // 全部条目都失败过才停止（用集合记录而非计数，列表中途增删也不会误判）
  if (playlist.length > 0 && currentPlaylistIndex >= 0 && currentPlaylistIndex < playlist.length && playMode !== 'single-loop') {
    failedPlaylistKeys.add(currentFilePath);
    if (playlist.every(item => failedPlaylistKeys.has(item.key))) {
      showToast('播放列表中的媒体均无法播放，已停止');
      return;
    }
    if (autoNextTimer) clearTimeout(autoNextTimer);
    autoNextTimer = setTimeout(() => {
      const startIdx = (currentPlaylistIndex + 1) % playlist.length;
      let idx = startIdx;
      do {
        if (!failedPlaylistKeys.has(playlist[idx].key)) break;
        idx = (idx + 1) % playlist.length;
      } while (idx !== startIdx); // 全失败场景已在上方拦截，此处必有未失败项
      playPlaylistItem(idx);
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

    const cleanup = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('blur', onBlur);
    };

    const onMouseUp = (upEvt) => {
      if (isSeeking) {
        handleSeek(upEvt);
        isSeeking = false;
      }
      cleanup();
    };

    // 兜底：鼠标在窗口外松开时 mouseup 不会触发，失焦时复位，避免进度条/时间卡死不刷新
    const onBlur = () => {
      isSeeking = false;
      cleanup();
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('blur', onBlur);
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
  // 支持 0~2（0%~200%）：0~1 原生音量区，1~2 由增益放大器扩展
  masterVolume = Math.max(0, Math.min(2.0, parseFloat(val) || 0));
  applyMasterVolume();
  persistSettings();
}

if (volumeSlider) {
  volumeSlider.addEventListener('input', (e) => updateVolume(e.target.value));
}

if (volumeBtn) {
  volumeBtn.addEventListener('click', () => {
    if (masterVolume > 0) {
      lastVolume = masterVolume;
      updateVolume(0);
    } else {
      updateVolume(lastVolume || 1.0);
    }
  });
}

// 全局鼠标滚轮调音（仅视频区域生效；播放列表面板滚动、音量滑块自身、各菜单内不干预）
window.addEventListener('wheel', (e) => {
  if ([speedMenu, subtitleMenu, aspectMenu, playModeMenu].some(m => m && m.contains(e.target))) return;
  if (e.target.closest('#playlist-panel')) return;
  if (e.target.closest('#volume-range')) return; // 滑块已有 input 事件，避免双重调节
  if (!videoContainer || !videoContainer.contains(e.target)) return;
  e.preventDefault();
  if (e.deltaY < 0) {
    updateVolume(masterVolume + 0.05);
  } else {
    updateVolume(masterVolume - 0.05);
  }
}, { passive: false });

// === 多倍速切换菜单 ===
if (speedBtn && speedMenu) {
  speedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMenus(speedMenu);
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
      if (speedBtn) speedBtn.textContent = formatSpeed(speed);
      speedMenu.querySelectorAll('.menu-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      speedMenu.classList.remove('show');
      showToast(`已切换至 ${formatSpeed(speed)} 倍速`);
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
  if (mode.id === '16-9' || mode.id === '4-3') {
    // 强制比例：先按宽度计算，容器高度不足时以高度为准，避免上下被裁
    const aspect = mode.id === '16-9' ? 16 / 9 : 4 / 3;
    baseW = cw;
    baseH = cw / aspect;
    if (baseH > ch) {
      baseH = ch;
      baseW = ch * aspect;
    }
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
  if (isMusicMode) setupSpectrumCanvas(); // 音乐模式下同步重铺频谱画布
});

if (aspectRatioBtn && aspectMenu) {
  aspectRatioBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeAllMenus(aspectMenu);
    aspectMenu.classList.toggle('show');
  });

  aspectMenu.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const mode = aspectModes.find(m => m.id === item.dataset.aspect);
      if (mode) {
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

// 剥离 SRT/VTT 内联标签（<i> <b> <font ...> <c.xxx> <v 名字> 等），
// 本播放器以纯文本渲染，不剥离会原样显示成文字。只匹配字母开头的标签，避免误删正文中的比较符号
function stripInlineTags(text) {
  return text.replace(/<\/?[A-Za-z][^>]{0,63}>/g, '');
}

function parseAndApplySubtitle(text) {
  currentSubtitleData = [];
  if (!text) return;

  // 标准化换行符
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const isAss = /^\s*Dialogue:/m.test(normalized);

  if (isAss) {
    // ASS / SSA 格式：标准 Dialogue 为逗号分隔字段
    // Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text（文本自索引 9 起，可含逗号）
    normalized.split('\n').forEach(line => {
      const trimmedLine = line.trim();
      if (!trimmedLine.toLowerCase().startsWith('dialogue:')) return;

      const fields = trimmedLine.slice(trimmedLine.indexOf(':') + 1).split(',');
      if (fields.length < 10) return;
      const startTime = parseSubtitleTime(fields[1].trim());
      const endTime = parseSubtitleTime(fields[2].trim());
      const subText = stripAssTags(fields.slice(9).join(',').trim());
      if (!isNaN(startTime) && !isNaN(endTime) && subText) {
        currentSubtitleData.push({ start: startTime, end: endTime, text: subText });
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
        const subText = stripInlineTags(textLines.join('\n'));
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
  const parts = String(str).trim().split(/\s+/)[0].split(':');
  if (parts.length === 2) parts.unshift('0'); // mm:ss 补齐为 hh:mm:ss
  if (parts.length !== 3) return NaN;
  const h = parseInt(parts[0], 10);
  const min = parseInt(parts[1], 10);
  const secParts = parts[2].split(/[.,]/);
  const sec = parseInt(secParts[0], 10);
  const ms = secParts[1] ? parseInt(secParts[1].padEnd(3, '0').slice(0, 3), 10) : 0;
  // 任一段解析失败（非数字）整体返回 NaN，由调用方丢弃该条目，避免坏时间轴被静默当 0s 显示
  if (isNaN(h) || isNaN(min) || isNaN(sec) || isNaN(ms)) return NaN;
  return h * 3600 + min * 60 + sec + ms / 1000;
}

// 二分查找当前时间命中的字幕（兼容重叠/长字幕，向前回扫最多 200 条）
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

  const activeSub = findActiveSubtitle(currentTime - subtitleOffset);
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
    if (subtitleMenu) subtitleMenu.classList.remove('show');
    try {
      const filePath = await window.electronAPI.openSubtitleDialog();
      if (filePath) {
        // 带令牌：对话框/读取期间切了视频则丢弃旧字幕，避免覆盖到新视频上
        const ok = await loadSubtitleFromPath(filePath, currentFilePath);
        showToast(ok ? '字幕导入成功' : '加载字幕文件失败');
      }
    } catch (err) {
      console.error('加载字幕失败:', err);
    }
  });
}

if (toggleSubBtn) {
  toggleSubBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    isSubtitleVisible = !isSubtitleVisible;
    // 同步菜单文案，让用户随时能看出当前字幕是显示还是隐藏状态
    toggleSubBtn.textContent = isSubtitleVisible ? '隐藏字幕' : '显示字幕';
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
    // 续播提示仅在元数据就绪后弹出，此处 duration 必然可用
    if (pendingResumeTime > 0) {
      video.currentTime = pendingResumeTime;
      showToast(`已为您自动续播至 ${formatTime(pendingResumeTime)}`);
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
// 仅负责 UI 更新；持久化由调用方按需触发（恢复设置时不写回）
function updatePlayModeUI(mode, showNotification = true) {
  playMode = mode;
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
    closeAllMenus(playModeMenu);
    playModeMenu.classList.toggle('show');
  });

  playModeMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.menu-item');
    if (!item) return;
    e.stopPropagation();
    const mode = item.getAttribute('data-mode');
    if (mode) {
      updatePlayModeUI(mode, true);
      persistSettings();
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
    // 以 ArrayBuffer 传输，避免大图 base64 字符串经 IPC 结构化克隆造成卡顿
    blob.arrayBuffer().then((buf) => {
      window.electronAPI.saveScreenshot(buf, defaultName).then(success => {
        showToast(success ? '截图已成功保存到本地！' : '截图保存失败');
      }).catch(() => {
        showToast('截图保存失败');
      });
    }).catch(() => {
      showToast('截图失败');
    });
  }, 'image/png');
}

// === 全屏与窗口退出/展开 ===
function toggleFullscreen() {
  // 真正的全屏（主进程 setFullScreen），区别于窗口最大化
  window.electronAPI.fullscreenWindow();
}

if (fullscreenBtn) fullscreenBtn.addEventListener('click', toggleFullscreen);

// 双击视频区域切换全屏
if (videoContainer) {
  videoContainer.addEventListener('dblclick', (e) => {
    // 只在真正的视频画面区双击才切换全屏：
    // 控制条/标题栏/播放列表面板/续播提示/空状态都是交互区，双点击中它们不应触发全屏
    if (e.target.closest('#controls-overlay') || e.target.closest('#titlebar') ||
        e.target.closest('#playlist-panel') || e.target.closest('#resume-toast') ||
        e.target.closest('#empty-state') || e.target.closest('#global-toast')) return;
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
  // 焦点在原生可交互控件上时，把按键交还给控件自身，避免与全局快捷键双重触发
  // （典型场景：点击播放按钮后按钮保持焦点，再按 Space 会同时触发按钮 click 与全局 toggle）
  if (e.target.closest && e.target.closest('input, button, textarea, select')) return;
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
      updateVolume(masterVolume + 0.05);
      break;
    case 'ArrowDown':
      e.preventDefault();
      updateVolume(masterVolume - 0.05);
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
      window.electronAPI.isFullScreen().then(isFs => {
        if (isFs) window.electronAPI.fullscreenWindow();
      }).catch(() => {});
      break;
    case 'KeyM':
      e.preventDefault();
      if (volumeBtn) volumeBtn.click();
      break;
  }
});

// === 自动隐藏控制：底部功能栏 / 顶部标题栏 ===
// 统一契约：热区唤出 → 移开延时收起 → 播放中 3 秒闲置兜底；悬停本体或按住鼠标拖拽窗口时保持显示。
// 差异：底部"移开即隐"（无延迟），顶部带 0.4s 延迟去抖，防止鼠标滑过顶部边缘时闪烁。

// --- 底部功能栏 ---
// 判断本次鼠标事件的目标是否落在功能栏本体上（含其向上弹出的子菜单，
// 因为倍速/比例/字幕/播放模式菜单在 DOM 上都是 #controls-overlay 的后代）
function isPointerOverControlBar(e) {
  return !!(e && e.target && e.target.closest && e.target.closest('#controls-overlay'));
}

// 鼠标移开感应区且不在功能栏上时立即隐藏
function hideControlsNow() {
  if (controlsIdleTimer) {
    clearTimeout(controlsIdleTimer);
    controlsIdleTimer = null;
  }
  if (controlBar) controlBar.classList.add('hide');
  closeAllMenus();
}

// --- 顶部标题栏 ---
// 判断本次鼠标事件的目标是否落在标题栏本体上（窗口控制按钮区）
function isPointerOverTitleBar(e) {
  return !!(e && e.target && e.target.closest && e.target.closest('#titlebar'));
}

// 沉浸模式：有视频且在播放时才启用"自动隐藏"，空状态/暂停时标题栏常驻
function isImmersiveMode() {
  return !!(video && video.src && !video.paused);
}

// 立即收起标题栏（清掉一切相关计时器）
function hideTitleBarNow() {
  if (titlebarHideTimer) {
    clearTimeout(titlebarHideTimer);
    titlebarHideTimer = null;
  }
  if (titlebarIdleTimer) {
    clearTimeout(titlebarIdleTimer);
    titlebarIdleTimer = null;
  }
  if (titleBar) titleBar.classList.add('hide');
}

// 移出顶部感应区：延迟 0.4 秒再藏（防误触/防闪烁），期间鼠标回来会立即取消
function scheduleHideTitleBar() {
  if (titlebarHideTimer) return; // 已经挂着的延迟不重复计时
  titlebarHideTimer = setTimeout(() => {
    titlebarHideTimer = null;
    hideTitleBarNow();
  }, 400);
}

// 唤出标题栏；播放中启动 3 秒闲置兜底
function showTitleBar() {
  if (titleBar) titleBar.classList.remove('hide');
  if (titlebarHideTimer) {
    clearTimeout(titlebarHideTimer);
    titlebarHideTimer = null;
  }
  if (titlebarIdleTimer) {
    clearTimeout(titlebarIdleTimer);
    titlebarIdleTimer = null;
  }
  if (isImmersiveMode()) {
    titlebarIdleTimer = setTimeout(() => {
      titlebarIdleTimer = null;
      hideTitleBarNow();
    }, 3000);
  }
}

// 功能栏显示 + 播放中启动 3 秒闲置兜底计时（悬停在功能栏上时不走这条路径）
function showControls() {
  if (controlBar) controlBar.classList.remove('hide');

  if (controlsIdleTimer) clearTimeout(controlsIdleTimer);

  if (video && !video.paused) {
    controlsIdleTimer = setTimeout(() => {
      controlsIdleTimer = null;
      if (controlBar) controlBar.classList.add('hide');
      closeAllMenus();
    }, 3000);
  }
}

// 每次鼠标移动时统一裁决标题栏与功能栏的去留
function updateControlsOnMouseMove(e) {
  // 一次取容器布局矩形，顶部/底部热区共用。
  // getBoundingClientRect() 会强制同步重排，而 mousemove 高频触发，
  // 合并为一次可避免鼠标快速扫过时每帧触发两次布局计算。
  const rect = videoContainer ? videoContainer.getBoundingClientRect() : null;

  // --- 顶部标题栏 ---
  // 鼠标悬停在标题栏本体上：一直保持显示，暂停一切隐藏计时（含按住鼠标拖拽窗口的场景）
  if (isPointerOverTitleBar(e)) {
    if (titleBar) titleBar.classList.remove('hide');
    if (titlebarHideTimer) {
      clearTimeout(titlebarHideTimer);
      titlebarHideTimer = null;
    }
    if (titlebarIdleTimer) {
      clearTimeout(titlebarIdleTimer);
      titlebarIdleTimer = null;
    }
  } else if (isImmersiveMode() && rect) {
    const inTopHotzone = (e.clientY - rect.top) <= TITLEBAR_HOTZONE_HEIGHT;

    if (inTopHotzone) {
      showTitleBar(); // 踩进顶部感应区：唤出（含 3 秒兜底）
    } else if (!(e.buttons > 0) && titleBar && !titleBar.classList.contains('hide')) {
      scheduleHideTitleBar(); // 已离开感应区且没按住鼠标：延迟收起
      // 正在按住鼠标拖拽窗口时不隐藏，避免 -webkit-app-region: drag 区域中途消失导致拖拽脱手
    }
  }

  // --- 底部功能栏 ---
  // 鼠标悬停在功能栏本体上：一直保持显示，不启动任何隐藏计时
  if (isPointerOverControlBar(e)) {
    if (controlBar) controlBar.classList.remove('hide');
    if (controlsIdleTimer) {
      clearTimeout(controlsIdleTimer);
      controlsIdleTimer = null;
    }
    return;
  }

  const inHotzone = rect ? (rect.bottom - e.clientY) <= CONTROLS_HOTZONE_HEIGHT : false;

  if (inHotzone) {
    showControls(); // 踩进底部感应区：唤出功能栏（含 3 秒兜底）
  } else if (controlBar && !controlBar.classList.contains('hide')) {
    hideControlsNow(); // 已离开感应区：立刻收起
  }
}

if (videoContainer) {
  videoContainer.addEventListener('mousemove', (e) => {
    updateControlsOnMouseMove(e);
  });
  // 点击画面唤出标题栏；播放列表等非画面交互区的点击不参与，避免列表操作时 UI 跳动
  videoContainer.addEventListener('click', (e) => {
    if (e.target.closest('#playlist-panel')) return;
    showTitleBar();
  });
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
