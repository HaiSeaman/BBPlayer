// 媒体兼容层（主进程模块）：让 Chromium 内核播不了的格式也能播。
// 三档策略（判定规则由真机实测对账确定，详见 docs/FORMAT-EXPANSION-REPORT.md）：
//   native   内核直接能播 → 什么都不做
//   remux    只换容器（视频音频原样复制，秒级、无损）
//   audiofix 视频原样复制、只把音频转成 AAC（秒级，专治 AC3/EAC3/DTS 没声音）
//   transcode 解码再编码成 H.264+AAC（慢，但老编码只能这样）
//
// 为什么不带 ffprobe：`ffmpeg -i <文件>` 的文本输出已能稳定拿到容器/编码/时长，
// 省掉一个 90MB 量级的额外二进制（本项目实测对账通过）。
// 本模块刻意不依赖 electron，便于用普通 node 直接自检（verify-converter.js）。
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

// 改动转换逻辑（参数/档位含义）时必须改这个版本号，否则旧缓存会被继续命中
const PIPELINE_VERSION = 'v1';

// ffmpeg 报出的容器名里，内核能直接打开的（首个逗号前的名字；mov 组覆盖 mp4/m4v/f4v/3gp）
const NATIVE_CONTAINERS = new Set(['mov', 'matroska', 'ogg', 'wav', 'mp3', 'flac', 'aac']);
// 内核能解的视频编码
const OK_VIDEO = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);
// 内核能解的音频编码（mp2 是实测能播的，别凭直觉删掉）
const OK_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'mp2']);

// 转码编码器优先级：硬件优先（快得多），最后才是 LGPL 构建自带的 OpenH264 软编码
const ENCODER_CANDIDATES = [
  { name: 'h264_nvenc', args: ['-preset', 'p4', '-cq', '26'] },
  { name: 'h264_qsv', args: ['-preset', 'veryfast', '-global_quality', '26'] },
  { name: 'h264_amf', args: ['-quality', 'balanced', '-qp_i', '26', '-qp_p', '26'] },
  { name: 'libx264', args: ['-preset', 'veryfast', '-crf', '23'] },        // GPL 构建才有，缺了就跳过
  { name: 'libopenh264', args: ['-b:v', '4M'] }                            // LGPL 构建的软件兜底
];

// 判定档位失败/无法探测时用的兜底值：交给内核试播，再由渲染端的运行时兜底纠正
const FALLBACK_TIER = 'native';

let config = {
  ffmpegPath: path.join(__dirname, 'vendor', 'ffmpeg', 'ffmpeg.exe'),
  cacheDir: path.join(os.tmpdir(), 'BBPlayer-convert'),
  maxCacheBytes: 20 * 1024 * 1024 * 1024,
  // 单个转码产物的硬上限。磁盘预检按"目标码率×时长"估算，估算偏小或素材异常
  // （例如超长时长的老编码录像）时仍可能转出巨物把磁盘写满，这条是最后一道闸。
  // 刻意**不用 ffmpeg 的 -fs**：实测它触顶时直接以异常退出、产物根本不落地，
  // 等于把"转了半小时"白扔；这里改为运行中监控、超限主动中止并给出明确原因。
  maxOutputBytes: 16 * 1024 * 1024 * 1024
};

function configure(next) {
  if (next && next.ffmpegPath && next.ffmpegPath !== config.ffmpegPath) {
    versionOk = null;
    encoderCache = null;
  }
  config = Object.assign({}, config, next);
}

function ffmpegPath() { return config.ffmpegPath; }

// ============ 纯逻辑（可单测，无副作用） ============

// 解析 `ffmpeg -i` 的 stderr 文本
function parseProbe(text) {
  if (!text || typeof text !== 'string') return null;
  const head = /Input #0,\s*(.+?),\s*from\s/i.exec(text);
  if (!head) return null;
  // 带内嵌封面的音乐文件会被 ffmpeg 报成 "Video: mjpeg (attached pic)"，
  // 那不是真视频轨；不排除掉的话，一首带封面的 MP3 会被误判成"视频编码不支持"而白白转码。
  const videoStreams = [...text.matchAll(/Stream #\d+:\d+[^\n]*?: Video: ([A-Za-z0-9_]+)[^\n]*/g)];
  const realVideo = videoStreams.find((m) => !/attached pic/i.test(m[0]));
  const audio = /Stream #\d+:\d+.*?: Audio: ([A-Za-z0-9_]+)/.exec(text);
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const dim = realVideo ? /(\d{2,5})x(\d{2,5})/.exec(realVideo[0]) : null;
  return {
    container: head[1].trim(),
    video: realVideo ? realVideo[1] : null,
    audio: audio ? audio[1] : null,
    width: dim ? parseInt(dim[1], 10) : 0,
    height: dim ? parseInt(dim[2], 10) : 0,
    duration: dur ? (+dur[1]) * 3600 + (+dur[2]) * 60 + parseFloat(dur[3]) : 0
  };
}

// 软件编码器（OpenH264）只能按码率来，必须随分辨率给值：
// 给 SD 老片灌 4Mbps 会产出体积翻倍的垃圾文件，给 1080p 2Mbps 又会糊。
function openh264Bitrate(height) {
  const h = Number(height) || 0;
  if (h >= 1000) return '6M';
  if (h >= 700) return '4M';
  return '2M';
}

function audioSupported(codec) {
  if (!codec) return true;                       // 没有音轨 → 不存在"解不了音频"
  return OK_AUDIO.has(codec) || codec.startsWith('pcm_');
}

function decideTier(probe) {
  if (!probe) return FALLBACK_TIER;
  const containerOk = NATIVE_CONTAINERS.has(String(probe.container).split(',')[0].trim().toLowerCase());
  const videoOk = !probe.video || OK_VIDEO.has(probe.video);
  const audioOk = audioSupported(probe.audio);
  if (containerOk && videoOk && audioOk) return 'native';
  if (videoOk && audioOk) return 'remux';        // 只差容器
  if (videoOk && !audioOk) return 'audiofix';    // 容器与音频一起换（同一条命令）
  return 'transcode';
}

function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
}

// 缓存名：同一文件必须稳定命中；文件变了（大小/时间）就换名
function cacheFileName(inputPath, size, mtimeMs, tier) {
  const base = sanitize(path.basename(inputPath, path.extname(inputPath))).slice(0, 60);
  let h = 5381;
  const full = path.resolve(inputPath).toLowerCase();
  for (let i = 0; i < full.length; i++) h = ((h * 33) ^ full.charCodeAt(i)) >>> 0;
  return `${base}.${h.toString(16)}.${size}.${Math.floor(mtimeMs)}.${tier}.${PIPELINE_VERSION}.mp4`;
}

// 解析 `-progress pipe:1` 的输出。注意 ffmpeg 的 out_time_ms 实际是微秒
// （历史遗留命名，新版本同时给 out_time_us），所以两者都按微秒处理。
// total_size 是 ffmpeg 自报的"已写入字节数"，用它做产物体积闸门：零额外 IO、
// 每次进度输出都检查一遍（实测转码常常只要 1~2 秒，靠定时 stat 根本来不及拦）。
function parseProgress(text) {
  if (!text) return null;
  let outTimeSec = null;
  let speed = null;
  let done = false;
  let totalSize = null;
  for (const line of String(text).split(/\r?\n/)) {
    const [k, v] = line.split('=');
    if (!k || v === undefined) continue;
    if (k === 'out_time_us' || k === 'out_time_ms') {
      const n = Number(v);
      if (Number.isFinite(n)) outTimeSec = n / 1e6;
    } else if (k === 'out_time') {
      const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(v);
      if (m && outTimeSec === null) outTimeSec = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
    } else if (k === 'speed') {
      speed = String(v).trim();
    } else if (k === 'total_size') {
      const n = Number(String(v).trim());
      if (Number.isFinite(n)) totalSize = n;
    } else if (k === 'progress') {
      done = String(v).trim() === 'end';
    }
  }
  if (outTimeSec === null && speed === null && !done && totalSize === null) return null;
  return { outTimeSec, speed, done, totalSize };
}

function progressPercent(outTimeSec, totalSec) {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return 0;
  if (!Number.isFinite(outTimeSec)) return 0;
  return Math.max(0, Math.min(100, Math.round((outTimeSec / totalSec) * 100)));
}

// ============ ffmpeg 调用 ============

let versionOk = null;
let availablePending = null;
// 异步探测（绝不用 spawnSync：那是同步阻塞，会把整个主进程的 IPC 与窗口按钮一起卡住最多 10 秒）
async function isAvailable() {
  if (versionOk === true) return true;
  if (availablePending) return availablePending;
  availablePending = (async () => {
    const exists = await fsp.access(config.ffmpegPath).then(() => true, () => false);
    if (!exists) return false;   // 文件不存在是稳定事实；其它失败不缓存，免得瞬时失败被永久钉成"不可用"
    const ok = await new Promise((resolve) => {
      let done = false;
      let child = null;
      let timer = null;
      const fin = (v) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (child) children.delete(child);
        resolve(v);
      };
      try {
        child = spawn(config.ffmpegPath, ['-hide_banner', '-version'], { windowsHide: true });
      } catch (e) {
        return fin(false);
      }
      children.add(child);
      let out = '';
      child.stdout.on('data', (d) => { if (out.length < 32768) out += d.toString(); });
      child.on('error', () => fin(false));
      child.on('close', (code) => fin(code === 0 && /ffmpeg version/i.test(out)));
      timer = setTimeout(() => { try { child.kill(); } catch (e) {} fin(false); }, 10000);
    });
    if (ok) versionOk = true;
    return ok;
  })();
  try {
    return await availablePending;
  } finally {
    availablePending = null;
  }
}

const PROBE_ARGS = (file) => ['-hide_banner', '-nostdin', '-i', file];

// 同步探测（自检脚本用）
function probeFileSync(file) {
  try {
    const r = spawnSync(config.ffmpegPath, PROBE_ARGS(file), { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    return parseProbe(String(r.stderr || ''));
  } catch (e) {
    return null;
  }
}

// 探测并发闸门：渲染进程一旦因为 bug 或被注入脚本循环调用，裸奔的探测会把几百个 ffmpeg 一起拉起来
// （每个几十 MB 内存 + 文件句柄）把机器拖死。这里限流到 2 个并发，多出来的排队。
const MAX_CONCURRENT_PROBES = 2;
let probeActive = 0;
const probeWaiters = [];
function acquireProbeSlot() {
  if (probeActive < MAX_CONCURRENT_PROBES) { probeActive++; return Promise.resolve(); }
  return new Promise((resolve) => probeWaiters.push(resolve));
}
function releaseProbeSlot() {
  const next = probeWaiters.shift();
  if (next) next();          // 名额直接转交给排队者，计数不减少
  else probeActive--;
}

// 异步探测：`ffmpeg -i 文件` 无输出目标时必然以非零码退出，这是预期行为
async function probeFile(file, key, expectedGen) {
  await acquireProbeSlot();
  if (key && expectedGen !== undefined && expectedGen !== generationOf(key)) {
    releaseProbeSlot();
    return null;
  }
  return new Promise((resolve) => {
    let stderr = '';
    let finished = false;
    let child = null;
    let timer = null;
    const done = (p) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (child) {
        children.delete(child);
        if (key && activeProbes.has(key)) {
          const s = activeProbes.get(key);
          s.delete(child);
          if (s.size === 0) activeProbes.delete(key);
        }
      }
      releaseProbeSlot();
      resolve(p);
    };
    try {
      child = spawn(config.ffmpegPath, PROBE_ARGS(file), { windowsHide: true });
    } catch (e) {
      return done(null);
    }
    children.add(child);
    if (key) {
      let s = activeProbes.get(key);
      if (!s) { s = new Set(); activeProbes.set(key, s); }
      s.add(child);
    }
    timer = setTimeout(() => { try { child.kill(); } catch (e) {} done(null); }, 20000);
    child.stderr.on('data', (d) => { if (stderr.length < 200000) stderr += d.toString(); });
    child.on('error', () => done(null));
    child.on('close', () => done(parseProbe(stderr)));
  });
}

// ============ 任务队列（并发 1）+ 按来源作废 ============

let chain = Promise.resolve();
const generations = new Map();   // key → 代号；号一变，该 key 的旧任务全部作废
const activeProbes = new Map();  // key → Set<ChildProcess>，换片时连同在途探测一并中止
let activeChild = null;
let activeKey = null;
// 所有在跑的子进程（含探测进程）：关窗/退出时必须一个不剩地杀掉，否则会留下吃 CPU 的幽灵 ffmpeg
const children = new Set();
// 正在写入的临时产物（.part.mp4）：cleanup 扫描缓存目录时必须跳过它们。
// 为什么：cleanup 在转换成功后以 fire-and-forget 方式发起（不 await），它在 await readdir/stat
// 让出期间，队列里的下一个任务可能已经开始写自己的 .part.mp4 —— 若 cleanup 把这条"半截产物"
// 当残留碎片删掉，那个正在跑的 ffmpeg 就会写到一个已被删除的路径上而失败。
const activeParts = new Set();

function generationOf(key) {
  return generations.get(key) || 0;
}

// 同一窗口发起新请求时调用：旧任务立刻杀掉、排队的旧任务醒来后自我作废
function invalidate(key) {
  generations.set(key, generationOf(key) + 1);
  if (activeChild && activeKey === key) {
    try { activeChild.kill(); } catch (e) { /* 已退出 */ }
  }
  const probes = activeProbes.get(key);
  if (probes) {
    for (const p of probes) {
      try { p.kill(); } catch (e) { /* 已退出 */ }
    }
  }
}

function enqueue(task) {
  const run = chain.then(task, task);
  chain = run.then(() => {}, () => {});
  return run;
}

function makeCancelledError() {
  const e = new Error('转换已取消');
  e.name = 'CancelledError';
  return e;
}

// ============ 转换 ============

// 内核原生就能播的扩展名：这些文件不探测、不转换，直接原样播放。
// 理由：探测要起一次 ffmpeg 进程（几十毫秒），而 mp4/mkv 是主人日常最常开的格式，
// 不能为了少数老格式让常用格式变慢。这类文件万一里面装了怪编码，交给渲染端的运行时兜底纠正。
const NATIVE_EXTS = new Set([...require('./shared-video-exts').nativeAll]);

function extOf(p) {
  return path.extname(p).slice(1).toLowerCase();
}

function buildArgs(input, out, tier, probe, encoder) {
  // -progress pipe:1 -nostats 必须带上：不带它 ffmpeg 一个字都不往 stdout 写，
  // 进度回调永远不会触发（界面在长转码期间看不到任何百分比）。
  const base = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-i', input];
  // -map 显式选流：默认只挑一条，且裸 -map 0 会把 VOB 的数据流也带上（实测踩过）
  const map = ['-map', '0:v:0?', '-map', '0:a:0?'];
  const tail = ['-movflags', '+faststart', out];
  if (tier === 'remux') return base.concat(map, ['-c', 'copy'], tail);
  if (tier === 'audiofix') return base.concat(map, ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k'], tail);
  // OpenH264 的码率随分辨率走（其它编码器都用自带的恒定质量参数）
  const vargs = encoder.name === 'libopenh264'
    ? ['-b:v', openh264Bitrate(probe && probe.height)]
    : encoder.args;
  return base.concat(map, ['-c:v', encoder.name], vargs,
    ['-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k'], tail);
}

// 硬件编码器"列在表里"不等于"本机能用"：初始化失败要换下一个候选。
// 必须覆盖真实见过的失败文本——例如新版 ffmpeg 会报
// "Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0"，
// 早期版本漏了这条，导致本该退到软件编码的转码直接失败。
function looksLikeEncoderFailure(text) {
  return /Error while opening encoder|Error initializing output stream|Cannot load|cannot load|No capable devices|No NVENC capable|Driver does not support|nvenc API version|OpenEncodeSession|InitializeEncoder failed|Unknown encoder|not found/i.test(text || '');
}

// 把转码子进程的优先级降到"低于正常"：重编码是 CPU 密集型，占满一个核时
// 会让同一台机器上的其它操作（含本播放器界面、系统输入响应）明显发涩。
// Windows 上对子进程调 setPriority 需要相应权限，失败一律忽略（退化为默认优先级，
// 只影响流畅度、不影响正确性），绝不因为调不动优先级就让转换失败。
function lowerPriority(child) {
  if (!child || !child.pid) return;
  try {
    os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch (e) {
    // 权限不足 / 进程已退出：忽略
  }
}

function runFfmpegOnce(args, key, durationSec, onProgress) {
  return new Promise((resolve, reject) => {
    let stderrTail = '';
    let stdoutBuf = '';
    let finished = false;
    let child;
    try {
      child = spawn(config.ffmpegPath, args, { windowsHide: true });
    } catch (e) {
      return reject(e);
    }
    lowerPriority(child);
    activeChild = child;
    activeKey = key;
    children.add(child);
    // 看门狗：源文件在会挂起的介质上（掉线网络盘、被拔的 U 盘、坏道）时 ffmpeg 可能不退出也不报错，
    // 而队列并发是 1 —— 那样会把整个转换层永久堵死，所以 120 秒没有任何输出就杀掉按失败处理。
    // 必须单独记一个"是我超时杀的"标志：实测 Windows 上 kill() 后 close 回调是
    // `code=null, signal=SIGTERM`，与"用户换片主动取消"在事件层面完全一样。
    // 不区分的话，真实原因（源文件读不动）会被伪装成'用户取消'并被 main.js 静默吞掉，
    // 用户只看到"无法解析媒体源"，误以为文件损坏（实际是介质卡住）。
    let lastActivity = Date.now();
    let timedOut = false;
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > 120000) {
        timedOut = true;
        try { child.kill(); } catch (e) { /* 已退出 */ }
      }
    }, 15000);
    // 产物体积闸门：磁盘预检是"按目标码率×时长估算"，估算偏小或素材异常时仍可能把磁盘写满。
    // 判定依据用 ffmpeg 自己上报的 total_size（-progress 输出里就有，零额外 IO）：
    // 实测转码常常只要 1~2 秒，靠定时 stat 根本来不及拦，必须每条进度都查。
    // 刻意不用 ffmpeg 的 -fs：实测它触顶时以异常码退出、产物不落地，等于把已转的部分白扔。
    let tooLarge = false;
    const finish = (fn) => {
      if (finished) return;      // 幂等：spawn 失败时 'error' 与 'close' 都会触发（实测），
      finished = true;           // 不设这道闸会让第二次清理误伤"下一个已启动任务"的 activeChild
      clearInterval(watchdog);
      children.delete(child);
      // 只清理属于自己的登记：队列已换到下一个任务时，activeChild 已经是新子进程，
      // 这里若无条件置空，就会让 invalidate() 再也杀不掉正在跑的那个（进程泄漏）
      if (activeChild === child) { activeChild = null; activeKey = null; }
      fn();
    };
    let progressLines = [];
    const flushProgressBlock = () => {
      if (progressLines.length === 0) return;
      const p = parseProgress(progressLines.join('\n'));
      progressLines = [];
      if (p && Number.isFinite(p.totalSize) && p.totalSize > config.maxOutputBytes) {
        tooLarge = true;
        try { child.kill(); } catch (e) { /* 已退出 */ }
      }
      if (p && onProgress) onProgress({ percent: progressPercent(p.outTimeSec, durationSec), speed: p.speed });
    };
    child.stdout.on('data', (d) => {
      lastActivity = Date.now();
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        progressLines.push(line);
        if (/^progress=/i.test(line)) flushProgressBlock();
      }
    });
    child.stderr.on('data', (d) => {
      lastActivity = Date.now();
      stderrTail += d.toString();
      if (stderrTail.length > 8000) stderrTail = stderrTail.slice(-8000);
    });
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code, signal) => {
      if (stdoutBuf) { progressLines.push(stdoutBuf); stdoutBuf = ''; }
      flushProgressBlock();
      finish(() => {
        // 体积超限先判：超限时是我们主动 kill，close 回调为 code=null/signal=SIGTERM（实测），
        // 会与"用户主动取消"撞在一起；不先判就被当成取消静默吞掉，用户看不到"产物超限"这个真因。
        if (tooLarge) {
          const limit = config.maxOutputBytes >= 1024 ** 3
            ? `${(config.maxOutputBytes / 1024 ** 3).toFixed(0)} GB`
            : `${Math.round(config.maxOutputBytes / 1024 / 1024)} MB`;
          return reject(Object.assign(
            new Error(`产物超过单文件上限（${limit}），已中止转换`),
            { isOutputTooLarge: true, stderrTail }
          ));
        }
        // 看门狗超时优先判：它与"用户取消"的 close 都是 code=null/signal=SIGTERM（实测），
        // 不先判这条，"源文件读不动"会被当成用户取消而静默吞掉
        if (timedOut) {
          return reject(Object.assign(
            new Error('转换超时：源文件 120 秒无任何响应，可能所在的磁盘/网络位置已断开或存在坏道'),
            { isTimeout: true, stderrTail }
          ));
        }
        if (signal) return reject(makeCancelledError());
        if (code === 0) return resolve({ stderrTail });
        reject(Object.assign(new Error(`ffmpeg 退出码 ${code}: ${stderrTail.trim().split('\n').pop() || ''}`), { stderrTail }));
      });
    });
  });
}

// 输入文件本身有问题（损坏、半截下载、不存在、没权限）：换编码器重试没有意义，直接报错，
// 否则一个坏文件会白跑 4 遍（每遍都起一个 ffmpeg）。
function looksLikeInputError(text) {
  return /Invalid data found|Error opening input|No such file|moov atom not found|Permission denied|could not find codec parameters/i.test(text || '');
}

async function convertWithRetry(input, out, tier, probe, key, onProgress, encoders) {
  if (tier !== 'transcode') return runFfmpegOnce(buildArgs(input, out, tier, probe, null), key, probe && probe.duration, onProgress);
  let lastErr = null;
  for (const encoder of ENCODER_CANDIDATES) {
    if (encoders && encoders.size > 0 && !encoders.has(encoder.name)) continue;
    const startedAt = Date.now();
    try {
      await runFfmpegOnce(buildArgs(input, out, tier, probe, encoder), key, probe && probe.duration, onProgress);
      return;
    } catch (e) {
      if (e && e.name === 'CancelledError') throw e;
      // 体积超限是素材/目标码率的问题，换编码器只会再超一次 → 直接失败
      if (e && e.isOutputTooLarge) throw e;
      // 看门狗超时是源文件/介质的问题，换编码器毫无意义（每个都要再等 120 秒）→ 直接失败
      if (e && e.isTimeout) throw e;
      lastErr = e;
      // 输入本身有问题 → 立刻失败，不换编码器重试
      if (looksLikeInputError(e && e.stderrTail)) throw e;
      // 换下一个候选的条件：错误文本像"编码器用不了"，或者它失败得太快（3 秒内），
      // 后者能兜住各种没预料到的驱动/初始化报错；转了一半才失败的不重试（避免白跑一遍）。
      const encoderish = looksLikeEncoderFailure(e && e.stderrTail) || (Date.now() - startedAt < 3000);
      if (!encoderish) throw e;   // 不是编码器问题 → 不掩盖真错误
      try { await fsp.unlink(out); } catch (e2) { /* 没产出 */ }
    }
  }
  throw lastErr || new Error('没有可用的视频编码器');
}

// 本机可用的编码器集合（探测一次并缓存）。
// 用 spawn 而不是 spawnSync：同步版会把主进程（含所有窗口的 IPC 与按钮）卡住最多 15 秒。
let encoderCache = null;
let encodersPending = null;
async function availableEncoders() {
  if (encoderCache && encoderCache.size > 0) return encoderCache;
  if (encodersPending) return encodersPending;
  encodersPending = (async () => {
    const set = new Set();
    await new Promise((resolve) => {
      let done = false;
      let child = null;
      let timer = null;
      const fin = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (child) children.delete(child);
        resolve();
      };
      try {
        child = spawn(config.ffmpegPath, ['-hide_banner', '-encoders'], { windowsHide: true });
      } catch (e) {
        return fin();
      }
      children.add(child);
      let out = '';
      child.stdout.on('data', (d) => { if (out.length < 200000) out += d.toString(); });
      child.on('error', () => fin());
      child.on('close', () => {
        for (const line of out.split(/\r?\n/)) {
          const m = /^\s*[VAS][\w.]{5}\s+(\S+)/.exec(line);
          if (m) set.add(m[1]);
        }
        fin();
      });
      timer = setTimeout(() => { try { child.kill(); } catch (e) {} fin(); }, 15000);
    });
    if (set.size > 0) encoderCache = set;   // 只在探测成功时缓存
    return set;
  })();
  try {
    return await encodersPending;
  } finally {
    encodersPending = null;
  }
}

// 产物体积估算（只为"磁盘够不够"这一道预检服务）。
// 换容器/换音频约等于复制一份；重编码按目标码率×时长算——曾经用"输入体积×1.5"估，
// 结果 20GB 的 VOB 被要求 30GB 空间（实际产物 1~2GB），明明能转却被拒。
function estimateOutputBytes(tier, inputBytes, durationSec, height) {
  const slack = 300 * 1024 * 1024;
  if (tier === 'transcode') {
    const mbps = Number(openh264Bitrate(height).replace('M', '')) || 2;
    const dur = Number(durationSec) > 0 ? Number(durationSec) : 600;   // 时长未知时按 10 分钟估
    return Math.max(512 * 1024 * 1024, Math.round((mbps * 1e6 / 8) * dur * 1.5) + slack);
  }
  return Math.round(Number(inputBytes) * 1.05) + slack;
}

// 产物"最后被使用"的内存记录。
// 为什么必须有它：Windows NTFS 默认不更新 last access time（实测读文件后 atimeMs **完全不变**，
// 恒等于创建时间），所以直接拿 atime 排序会退化成"按创建时间淘汰"——结果是天天看的老剧
// 先被删、只看过一次的新文件反而留着，与设计意图"按最久未访问淘汰"正好相反；
// 更糟的是可能把用户**正在看**的那个产物删掉（拖进度到未缓冲处就失败）。
// 这里在每次 prepare 命中/产出产物时记一笔；进程重启后没有记录，退回用 mtime 兜底。
const lastUsedAt = new Map();   // 产物绝对路径 → 最后使用时间戳

function markUsed(productPath) {
  if (productPath) lastUsedAt.set(productPath, Date.now());
}

async function existsNonEmpty(p) {
  try {
    const st = await fsp.stat(p);
    return st.isFile() && st.size > 0;
  } catch (e) {
    return false;
  }
}

async function ensureFreeSpace(needBytes) {
  let free = null;
  try {
    const st = await fsp.statfs(config.cacheDir);
    free = Number(st.bavail) * Number(st.bsize);
  } catch (e) {
    return; // 查不到剩余空间就不拦（宁可能转了报错，也不要因探测失败卡住播放）
  }
  if (free < needBytes) {
    throw new Error(`磁盘空间不足：本次转换约需 ${(needBytes / 1024 ** 3).toFixed(1)} GB，当前只剩 ${(free / 1024 ** 3).toFixed(1)} GB`);
  }
}

// 对外主入口：给一个文件路径，返回可直接喂给 <video> 的 URL
async function prepare(inputPath, opts = {}) {
  const { key = 'default', force = null, onProgress = null } = opts;
  if (!inputPath || typeof inputPath !== 'string') throw new Error('文件路径无效');
  // 必须在**函数最开头**记下"代"，也就是任何 await 之前。
  // 踩过的坑：原先这一行写在探测（probeFile，可能耗时数秒到 20 秒）之后，于是
  // "用户打开长片 → 探测期间换片（invalidate）→ 长片探测完才读代号"时，长片读到的是
  // **作废后的新代号**，误以为自己有效 → 排进队列把长片完整转码（实测堵住新片 37 秒）。
  // 提到最前面后：长片入口记下旧代号，换片时代号一变，它在探测后立刻自我作废。
  const myGen = generationOf(key);
  const stat = await fsp.stat(inputPath);
  if (!stat.isFile()) throw new Error('不是文件');

  const directUrl = pathToFileURL(inputPath).href;
  // 快速通道：原生可播的扩展名 + 没有指定强制档位 → 不做任何探测，直接播。
  // 但先看缓存里有没有它的"强制档产物"：这类文件常常是"容器合法、内部编码内核不认"
  // （MKV 装 DTS、mp4 装 Xvid），上一次靠运行时兜底转好过——直接复用产物，
  // 否则第二次打开又会静音/黑屏，而兜底已被"每文件一次"挡住，用户只能重启。
  if (!force && NATIVE_EXTS.has(extOf(inputPath))) {
    // 顺序必须是 transcode 优先：它是在"画面也解不出"时转的，信息量/可播性是 audiofix 的超集。
    // 反过来的话（先命中 audiofix），一个"先只换音频、后又要重编码"的文件第二次打开
    // 会复用到那个已知播不出来的 audiofix 产物 → 必然又黑屏一次。
    for (const t of ['transcode', 'audiofix']) {
      const cached = path.join(config.cacheDir, cacheFileName(inputPath, stat.size, stat.mtimeMs, t));
      if (await existsNonEmpty(cached)) {
        markUsed(cached);
        return { url: pathToFileURL(cached).href, tier: t, converted: true, cached: true };
      }
    }
    return { url: directUrl, tier: 'native', converted: false };
  }

  // 非原生扩展名若已有完整缓存产物，直接复用（跳过 isAvailable 与 probeFile 外部进程开销）
  if (!force) {
    for (const t of ['transcode', 'audiofix', 'remux']) {
      const cached = path.join(config.cacheDir, cacheFileName(inputPath, stat.size, stat.mtimeMs, t));
      if (await existsNonEmpty(cached)) {
        markUsed(cached);
        return { url: pathToFileURL(cached).href, tier: t, converted: true, cached: true };
      }
    }
  }

  // 确定要探测或转换，先发准备提示让界面响应用户点击，原生与命中缓存绝不误发
  if (onProgress) {
    try { onProgress({ percent: 0, tier: force || 'auto', stage: 'prepare' }); } catch (e) { /* 回调异常不影响转换 */ }
  }

  // 走到这里就一定需要探测/转换 → 先确认转换器真的能用，给出明确原因，
  // 而不是让内核去报"系统无法解码该文件"（打包漏带 ffmpeg 时用户根本查不出原因）。
  if (!(await isAvailable())) {
    throw new Error(`内置转换器不可用：找不到或无法运行 ${config.ffmpegPath}`);
  }
  if (myGen !== generationOf(key)) throw makeCancelledError();   // 上面两次 await 期间可能已换片

  // 运行时兜底可以直接指定档位（探测说能播、实际黑屏/无声时用）
  const probe = await probeFile(inputPath, key, myGen);
  // 探测是最慢的一步（起一个 ffmpeg 解析头部）。用户换片时若已作废，立刻退出，
  // 绝不进入后面的转换——这是"换片不堵队列"的关键闸口。
  if (myGen !== generationOf(key)) throw makeCancelledError();
  const tier = force || decideTier(probe);
  if (tier === 'native') {
    return { url: directUrl, tier, converted: false };
  }

  const outPath = path.join(config.cacheDir, cacheFileName(inputPath, stat.size, stat.mtimeMs, tier));
  // 强制档位意味着"现有产物播不出来"：必须绕过缓存重转一次，否则命中同一个废产物，兜底等于空转
  if (force) {
    try { await fsp.unlink(outPath); } catch (e) { /* 还没有产物 */ }
  } else if (await existsNonEmpty(outPath)) {
    markUsed(outPath);
    return { url: pathToFileURL(outPath).href, tier, converted: true, cached: true };
  }

  // 确认要进转换队列时才把判定档位汇报一次，避免直接播/命缓存白闪烁进度提示
  if (onProgress) {
    try { onProgress({ percent: 0, tier, stage: 'decided' }); } catch (e) { /* 回调异常不影响转换 */ }
  }

  return enqueue(async () => {
    if (myGen !== generationOf(key)) throw makeCancelledError();
    // 排队期间可能有别的窗口把同一个文件转好了（多窗口同时打开同一部片的场景）→ 直接复用，别重复劳动
    if (await existsNonEmpty(outPath)) {
      markUsed(outPath);
      return { url: pathToFileURL(outPath).href, tier, converted: true, cached: true };
    }
    await fsp.mkdir(config.cacheDir, { recursive: true });
    await ensureFreeSpace(estimateOutputBytes(tier, stat.size, probe && probe.duration, probe && probe.height));
    if (myGen !== generationOf(key)) throw makeCancelledError();

    const encoders = tier === 'transcode' ? await availableEncoders() : null;
    if (myGen !== generationOf(key)) throw makeCancelledError();

    // 临时名必须仍然以 .mp4 结尾：ffmpeg 是靠输出扩展名挑封装器的，
    // 写成 "xxx.mp4.part" 会直接报 "Error opening output files: Invalid argument"（实测踩过）。
    const part = outPath.replace(/\.mp4$/, '.part.mp4');
    try { await fsp.unlink(part); } catch (e) { /* 不存在 */ }
    activeParts.add(part);   // 登记：cleanup 扫描时必须跳过，直至原子改名彻底落地或失败删除
    let renamed = false;
    try {
      await convertWithRetry(inputPath, part, tier, probe, key, onProgress, encoders);
      if (myGen !== generationOf(key)) throw makeCancelledError();
      await fsp.rename(part, outPath);   // 原子改名：播放端永远看不到半截文件
      renamed = true;
    } finally {
      if (!renamed) { try { await fsp.unlink(part); } catch (e) { /* 没产出 */ } }
      activeParts.delete(part);
    }
    markUsed(outPath);                  // 记录使用时间（缓存淘汰按它排，不用 Windows 上失效的 atime）
    cleanup();                          // 顺手清一次缓存（内部节流到每分钟最多一次）
    return { url: pathToFileURL(outPath).href, tier, converted: true };
  });
}
// 缓存清理：残留的 .part.mp4 碎片一律删；超上限按最久未访问淘汰。
// 两处调用：启动时（force=true）+ 每次转换成功后（节流到每分钟最多扫一次，避免每次都遍历目录）。
let lastCleanupAt = 0;
async function cleanup(force) {
  const now = Date.now();
  if (!force && now - lastCleanupAt < 60000) return;
  lastCleanupAt = now;
  try {
    const dir = config.cacheDir;
    const entries = await fsp.readdir(dir).catch(() => null);
    if (!entries) return;
    let files = [];
    let total = 0;
    const batchSize = 16;
    for (let i = 0; i < entries.length; i += batchSize) {
      const stats = await Promise.all(entries.slice(i, i + batchSize).map(async (name) => {
        const p = path.join(dir, name);
        const st = await fsp.stat(p).catch(() => null);
        return { name, p, st };
      }));
      for (const { name, p, st } of stats) {
        if (!st || !st.isFile()) continue;
        if (/\.part\.mp4$/.test(name)) {
          // 跳过正在写入的半截产物（见 activeParts）：删它会让正在跑的 ffmpeg 写向已删除路径而失败
          if (!activeParts.has(p)) await fsp.unlink(p).catch(() => {});
          continue;
        }
        // 排序依据：优先用"本次进程内最后一次被 prepare 命中"的时间（可靠、跨平台一致），
        // 没有记录（软件刚重启）才退回文件 mtime。
        // 绝不用 atime：Windows NTFS 默认不更新它（实测读文件后完全不变），
        // 会退化成"按创建时间淘汰"——天天看的老剧先被删，还可能删掉正在播的产物。
        files.push({ p, size: st.size, used: lastUsedAt.get(p) || st.mtimeMs });
        total += st.size;
      }
    }
    if (total <= config.maxCacheBytes) return;
    files.sort((a, b) => a.used - b.used);
    for (const f of files) {
      if (total <= config.maxCacheBytes) break;
      // 刚被使用过的产物（正在播的片）不许淘汰：删掉后拖进度条会直接失败。
      // 已按使用时间升序排好，遇到第一个"还新鲜"的就可以整体停止（后面的只会更新）。
      if (now - f.used < 10 * 60 * 1000) break;
      await fsp.unlink(f.p).catch(() => {});
      lastUsedAt.delete(f.p);
      total -= f.size;
    }
  } catch (e) { /* 清理失败不影响播放 */ }
}

// 关窗/退出时立刻杀掉所有在跑的 ffmpeg（含探测），避免留下一直吃 CPU 的孤儿进程。
// 探测闸门的名额无需在此手动归还：被杀的探测进程仍会触发 'close'/'error'，
// 由 probeFile 的 done() → releaseProbeSlot() 正常放行（同一条路径，不重复还）。
function killActive() {
  for (const child of children) {
    try { child.kill(); } catch (e) { /* 已退出 */ }
  }
  children.clear();
  activeChild = null;
  activeKey = null;
}

// 自检用：把内部常量暴露出来（避免测试里再抄一份规则）
module.exports = {
  configure, ffmpegPath, isAvailable, probeFile, probeFileSync,
  parseProbe, decideTier, cacheFileName, parseProgress, progressPercent,
  prepare, invalidate, killActive, cleanup, looksLikeEncoderFailure, openh264Bitrate,
  looksLikeInputError, estimateOutputBytes,
  NATIVE_EXTS,
  // 读取当前生效配置（测试要断言产物体积上限这类配置真被读进去了）
  currentConfig: () => Object.assign({}, config)
};
