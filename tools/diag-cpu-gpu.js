// ============================================================================
// BBPlayer 无界面 CPU/GPU 占用诊断
//
// 用途：量清"播放视频时 CPU/GPU 到底花在哪"——各进程（主进程 / 渲染 / GPU）
//       分别吃多少 CPU 与内存，视频是「显卡硬解」还是「CPU 软解」。
//
// 铁律遵守：窗口 show:false（用户看不到任何界面，不是 GUI 测试），
//           全部结论走命令行输出，不弹窗、不打开浏览器、不截图。
//
// 用法（在项目根目录）：
//   npx electron tools/diag-cpu-gpu.js                    # 用内置样本
//   npx electron tools/diag-cpu-gpu.js D:\影片\a.mp4      # 用指定视频
//   npx electron tools/diag-cpu-gpu.js a.mp4 --seconds=20 # 采样 20 秒
//   npx electron tools/diag-cpu-gpu.js a.mp4 --blur       # 额外测一次「有毛玻璃层」对比
//
// 说明：本脚本是开发期诊断工具，不进打包（package.json 的 files 是白名单，不含 tools/）。
// ============================================================================
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

// ---- 解析命令行参数 ----
// 注意：Electron 主进程的 argv 形如 [electron.exe, 各种开关, 脚本体路径, ...用户参数]。
// 必须把「开关」和「脚本体路径」都排除掉，否则会把脚本自己当成视频路径（踩过）。
function isUserArg(a) {
  if (!a || a.startsWith('--')) return false;                 // 开关
  if (/\.(js|asar|cjs|mjs)$/i.test(a)) return false;          // 脚本体 / asar 路径
  const base = path.basename(a).toLowerCase();
  if (base === 'electron' || base === 'electron.exe') return false;
  return true;
}
const argv = process.argv.slice(1).filter(isUserArg);
const secondsArg = process.argv.find(a => a.startsWith('--seconds='));
const SAMPLE_SECONDS = secondsArg ? Math.max(3, parseInt(secondsArg.split('=')[1], 10) || 12) : 12;
const WITH_BLUR = process.argv.includes('--blur');
const VISIBLE = process.argv.includes('--visible'); // 默认隐藏（无界面）；加此参数才显示窗口（能测到真实 CPU）
const videoArg = argv.find(a => !a.startsWith('--'));

const FFMPEG = path.join(__dirname, '..', 'vendor', 'ffmpeg', 'ffmpeg.exe');

// 关键：隐藏窗口默认会被 Chromium 当成"后台页"降级，甚至停止视频解码。
// 下面三个开关阻止渲染进程被背景化/Occlusion 降级，隐藏窗口才能真实解码、量到真实占用。
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// 没有给视频就用 ffmpeg 现造一个 720p 测试片（H.264，最能体现解码开销）
function ensureSampleVideo() {
  if (videoArg) {
    if (!fs.existsSync(videoArg)) {
      console.error(`[错误] 指定的视频不存在：${videoArg}`);
      process.exit(2);
    }
    return path.resolve(videoArg);
  }
  if (!fs.existsSync(FFMPEG)) {
    console.error(`[错误] 找不到内置 ffmpeg：${FFMPEG}\n       请改用：npx electron tools/diag-cpu-gpu.js <你的视频路径>`);
    process.exit(2);
  }
  const out = path.join(os.tmpdir(), 'BBPlayer-diag-sample.mp4');
  if (!fs.existsSync(out)) {
    console.log('[准备] 正在生成 720p 测试视频（约 10 秒）…');
    execFileSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=10',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-c:v', 'libopenh264', '-b:v', '2M', '-c:a', 'aac', '-shortest', out
    ], { stdio: 'inherit' });
  }
  return out;
}

// 隐藏窗口加载的极简页面：一个全屏 video（可选一层毛玻璃，模拟控制栏常亮）
function buildHtml(videoUrl, withBlur) {
  const blurLayer = withBlur ? `
    <div id="glass" style="position:absolute;left:0;right:0;bottom:20px;height:100px;
      backdrop-filter: blur(20px) saturate(160%);background:rgba(14,17,23,0.72);
      border-radius:16px;"></div>` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden}
    #v{width:100%;height:100%;object-fit:contain;background:#000}
  </style></head><body>
    <video id="v" src="${videoUrl}"></video>${blurLayer}
  </body></html>`;
}

// 把 getAppMetrics() 的一次采样整理成一行
function fmtMetric(m) {
  const memMB = (m.memory && (m.memory.privateBytes || m.memory.workingSetSize) || 0) / 1024;
  const cpu = (m.cpu && m.cpu.percentCPUUsage) || 0;
  return { type: m.type, pid: m.pid, cpu, memMB };
}

async function runOnce(samplePath, withBlur, label) {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    show: VISIBLE,            // 默认隐藏：用户看不到任何界面（不是 GUI 测试）
    skipTaskbar: true,
    webPreferences: {
      backgroundThrottling: false, // 后台不休眠，保证隐藏窗口下仍尽力解码
      offscreen: false
    }
  });
  win.webContents.setBackgroundThrottling(false);

  const url = pathToFileURL(samplePath).href;
  // 必须用 file:// 页面加载 file:// 视频：data: 页面属于另一个来源，加载本地视频会被拦（"no supported sources"）
  const htmlPath = path.join(os.tmpdir(), `BBPlayer-diag-page-${process.pid}.html`);
  fs.writeFileSync(htmlPath, buildHtml(url, withBlur), 'utf8');
  await win.loadFile(htmlPath);

  // 开始播放
  const started = await win.webContents.executeJavaScript(`
    (async () => {
      const v = document.getElementById('v');
      v.muted = true;                    // 静音避免音频设备开销干扰
      try { await v.play(); } catch (e) { return 'play-failed:' + e.message; }
      return 'ok';
    })()
  `);
  if (started !== 'ok') {
    console.log(`  [警告] 播放未启动：${started}`);
  }

  // 采样：每秒读一次 app.getAppMetrics() + playbackQuality
  const samples = [];
  for (let i = 0; i < SAMPLE_SECONDS; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const metrics = app.getAppMetrics().map(fmtMetric);
    const quality = await win.webContents.executeJavaScript(`
      (() => {
        const v = document.getElementById('v');
        const q = (v.getVideoPlaybackQuality && v.getVideoPlaybackQuality()) || {};
        return { t: v.currentTime, total: q.totalVideoFrames||0, dropped: q.droppedVideoFrames||0, w: v.videoWidth, h: v.videoHeight };
      })()
    `).catch(() => ({ t: 0 }));
    samples.push({ metrics, quality });
  }

  // 汇总：CPU 与内存取平均
  const agg = new Map();
  for (const s of samples) {
    for (const m of s.metrics) {
      const k = m.type;
      if (!agg.has(k)) agg.set(k, { cpuSum: 0, memSum: 0, n: 0, pid: m.pid });
      const a = agg.get(k);
      a.cpuSum += m.cpu; a.memSum += m.memMB; a.n++;
    }
  }
  const last = samples[samples.length - 1].quality;
  const first = samples[0].quality;
  const advanced = (last.t || 0) - (first.t || 0);

  console.log(`\n──── ${label} ────`);
  console.log(`  进程占用（${SAMPLE_SECONDS} 秒平均）：`);
  const rows = [...agg.entries()].sort((a, b) => b[1].cpuSum - a[1].cpuSum);
  let totalCpu = 0;
  for (const [type, a] of rows) {
    const cpu = a.cpuSum / a.n;
    totalCpu += cpu;
    console.log(`    ${type.padEnd(12)} CPU ${cpu.toFixed(1).padStart(5)}%   私有内存 ${(a.memSum / a.n).toFixed(0).padStart(5)} MB   pid ${a.pid}`);
  }
  console.log(`    ${'合计'.padEnd(11)} CPU ${totalCpu.toFixed(1).padStart(5)}%`);
  console.log(`  播放推进：${advanced.toFixed(1)} 秒（视频时长已播 ${(last.t || 0).toFixed(1)}s，分辨率 ${last.w}x${last.h}）`);
  console.log(`  解码帧：共 ${last.total} 帧，丢弃 ${last.dropped} 帧`);

  win.destroy();
  return { totalCpu, advanced, agg };
}

app.whenReady().then(async () => {
  const samplePath = ensureSampleVideo();
  console.log('════════════════════════════════════════════════════════════');
  console.log('  BBPlayer 无界面 CPU/GPU 诊断（隐藏窗口，不显示任何界面）');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  样本视频：${samplePath}`);
  console.log(`  采样时长：${SAMPLE_SECONDS} 秒`);

  // ① 视频解码是否走硬件加速（判定"硬解还是软解"的关键结论，与窗口可见性无关）
  const gpu = app.getGPUFeatureStatus();
  console.log('\n  ── GPU 特性状态（video_decode 是关键）──');
  console.log(`    video_decode : ${gpu.video_decode}`);
  console.log(`    video_encode : ${gpu.video_encode}`);
  console.log(`    gpu_compositing : ${gpu.gpu_compositing}`);
  console.log(`    canvas : ${gpu.canvas}`);

  // ①b GPU 设备与图形栈：只调一次（项目文档记录：定时轮询 app.getGPUInfo 会导致 GPU 进程内存泄漏）
  //     重要局限：本脚本用隐藏窗口运行，Chromium 对隐藏/不可见窗口往往不初始化图形栈
  //     （实测 auxAttributes 会出现 glImplementationParts=(gl=none,angle=none)、skiaBackendType=None），
  //     因此这里的图形状态**不能代表真实播放**。要看真实硬解请加 --visible 参数。
  let gpuInited = false; // 图形栈是否真的初始化（隐藏窗口下可能为 false，见下）
  try {
    const info = await app.getGPUInfo('basic');
    const devs = (info && info.gpuDevice) || [];
    console.log('\n  ── GPU 设备与图形栈 ──');
    for (const d of devs) {
      console.log(`    ${d.deviceString || '未知'}  vendor=0x${(d.vendorId || 0).toString(16)}  active=${d.active}  驱动=${d.driverVersion || '?'}`);
    }
    const aux = (info && info.auxAttributes) || {};
    console.log(`    GL 实现：${aux.glImplementationParts || '?'}`);
    console.log(`    Skia 后端：${aux.skiaBackendType || '?'}`);
    console.log(`    D3D12 支持：${aux.supportsDx12}   Vulkan 支持：${aux.supportsVulkan}`);
    console.log(`    Overlay 支持：${aux.overlayInfo && aux.overlayInfo.supportsOverlays}`);
    gpuInited = !!(aux.glImplementationParts && !/none/.test(aux.glImplementationParts));
    if (!gpuInited && !VISIBLE) {
      console.log('    ⚠️ 图形栈未初始化（隐藏窗口所致）→ 硬解判定不可信，请用 --visible 重测');
    }
  } catch (e) {
    console.log(`    （GPU 信息获取失败：${e.message}）`);
  }

  // ② 基线：只有 video
  const base = await runOnce(samplePath, false, '基线（仅视频画面）');

  // ③ 可选：额外加一层毛玻璃（模拟"控制栏常亮"），看多花多少
  let blurTotal = null;
  if (WITH_BLUR) {
    const blur = await runOnce(samplePath, true, '对照组（视频 + 毛玻璃层）');
    blurTotal = blur.totalCpu;
  }

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  结论');
  console.log('════════════════════════════════════════════════════════════');
  // 硬解结论只在"图形栈真的初始化了"时才敢下；隐藏窗口未初始化图形栈时如实说"不可判定"，
  // 否则会误导（上面 GPU 段已给出同样的告警）。
  if (gpuInited) {
    console.log(`  · 视频解码：${gpu.video_decode === 'hardware_accelerated' ? '✅ 硬件加速（走显卡）' : '⚠️ 软件解码（走 CPU）→ 这是 CPU 偏高的主要原因'}`);
  } else {
    console.log('  · 视频解码：❓ 本次无法判定——隐藏窗口下 Chromium 未初始化图形栈，');
    console.log('    硬解与否必须用 --visible 运行才能测准（屏幕会短暂显示一个测试窗口）。');
  }
  if (base.advanced < SAMPLE_SECONDS * 0.4) {
    console.log('  · ⚠️ 播放推进异常缓慢（本机解码能力不足或样本过大），下方占比数字仅供参考。');
  }
  console.log(`  · 采样模式：${VISIBLE ? '可见窗口（CPU/硬解接近真实）' : '隐藏窗口（无界面；CPU 明显偏低、硬解不可判定）'}`);
  if (!VISIBLE) {
    console.log('    想要真实的 CPU 占用与硬解判定：加 --visible 参数运行。');
  }
  if (blurTotal != null) {
    const diff = blurTotal - base.totalCpu;
    console.log(`  · 毛玻璃层额外 CPU：${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%（${base.totalCpu.toFixed(1)}% → ${blurTotal.toFixed(1)}%）`);
  }
  console.log('');

  app.quit();
});

app.on('window-all-closed', () => app.quit());
