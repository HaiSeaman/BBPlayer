// converter.js 的自检（零依赖，与 verify-exts.js 同风格）
// 用法：node verify-converter.js
//   · 第一层：纯逻辑断言（永远跑）
//   · 第二层 A：自带样本的真实转换验证（只要有内置 ffmpeg 就会跑，不需要外部样本）
//   · 第二层 B：真实样本对账（可选，设 BB_SAMPLES 指向样本目录才启用）
//
// 为什么要有第二层 A：很多关键行为**必须用真 ffmpeg 才能验证**（换片作废、产物落地、
// 体积闸门、进度上报），而旧版把这些全塞在"需要外部样本"的分支里 —— 结果默认环境下
// 一条都跑不到，等于没有保护。自带样本让这些回归默认就能跑。
// 为什么还要第二层 B：判定规则必须对着"真机内核实测结果"对账，
// 否则规则写得再漂亮也可能与现实不符（本项目已经踩过一次：MP2 音频实际能播）。
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('[通过] ' + name);
}

const ROOT = __dirname;
const converter = require(path.join(ROOT, 'converter.js'));

// ============ 第一层：纯逻辑 ============

ok('探测输出解析：带视频+音频的文件', () => {
  const stderr = [
    "Input #0, matroska,webm, from 'D:\\a.mkv':",
    '  Metadata:',
    '    ENCODER         : Lavf61.7.100',
    '  Duration: 00:00:02.02, start: 0.000000, bitrate: 187 kb/s',
    '  Stream #0:0: Video: h264 (Constrained Baseline), yuv420p(tv, progressive), 320x240, 15 fps',
    '  Stream #0:1: Audio: ac3, 44100 Hz, mono, fltp, 448 kb/s'
  ].join('\n');
  const p = converter.parseProbe(stderr);
  assert.strictEqual(p.container, 'matroska,webm');
  assert.strictEqual(p.video, 'h264');
  assert.strictEqual(p.audio, 'ac3');
  assert.strictEqual(Math.round(p.duration * 100) / 100, 2.02);
});

ok('探测输出解析：纯音频文件没有视频轨', () => {
  const stderr = [
    "Input #0, mp3, from 'D:\\b.mp3':",
    '  Duration: 00:03:20.50, start: 0.025057, bitrate: 128 kb/s',
    '  Stream #0:0: Audio: mp3, 44100 Hz, mono, fltp, 128 kb/s'
  ].join('\n');
  const p = converter.parseProbe(stderr);
  assert.strictEqual(p.video, null);
  assert.strictEqual(p.audio, 'mp3');
  assert.strictEqual(Math.round(p.duration), 201);
});

ok('探测输出解析：读不出来的内容返回 null（不抛异常）', () => {
  assert.strictEqual(converter.parseProbe(''), null);
  assert.strictEqual(converter.parseProbe('moov atom not found'), null);
});

ok('探测输出解析：带内嵌封面的音频不算"有视频轨"（否则音乐会被白白转码）', () => {
  const stderr = [
    "Input #0, mp3, from 'D:\\song.mp3':",
    '  Duration: 00:03:20.50, start: 0.025057, bitrate: 128 kb/s',
    '  Stream #0:0: Audio: mp3, 44100 Hz, mono, fltp, 128 kb/s',
    '  Stream #0:1: Video: mjpeg (Baseline) (attached pic), yuvj420p(pc), 600x600, 90k tbr'
  ].join('\n');
  const p = converter.parseProbe(stderr);
  assert.strictEqual(p.video, null, '内嵌封面不能被当成真视频轨');
  assert.strictEqual(p.audio, 'mp3');
  assert.strictEqual(converter.decideTier(p), 'native');
});

ok('判定：MKV(H.264+AAC) 直接播', () => {
  assert.strictEqual(converter.decideTier({ container: 'matroska,webm', video: 'h264', audio: 'aac' }), 'native');
});

ok('判定：TS(H.264+AAC) 只换容器', () => {
  assert.strictEqual(converter.decideTier({ container: 'mpegts', video: 'h264', audio: 'aac' }), 'remux');
});

ok('判定：FLV(H.264+AAC) 只换容器', () => {
  assert.strictEqual(converter.decideTier({ container: 'flv', video: 'h264', audio: 'aac' }), 'remux');
});

ok('判定：MKV(H.264+DTS) 只换音频', () => {
  assert.strictEqual(converter.decideTier({ container: 'matroska,webm', video: 'h264', audio: 'dts' }), 'audiofix');
});

ok('判定：AC3 / EAC3 都要换音频', () => {
  assert.strictEqual(converter.decideTier({ container: 'mov,mp4,m4a,3gp,3g2,mj2', video: 'h264', audio: 'ac3' }), 'audiofix');
  assert.strictEqual(converter.decideTier({ container: 'matroska,webm', video: 'h264', audio: 'eac3' }), 'audiofix');
});

ok('判定：TS(H.264+MP2) 只换容器（MP2 实测内核能解，别多转一次）', () => {
  assert.strictEqual(converter.decideTier({ container: 'mpegts', video: 'h264', audio: 'mp2' }), 'remux');
});

ok('判定：表外的音频编码一律按"换音频"（宁可多花 0.4 秒，也不能没声音）', () => {
  assert.strictEqual(converter.decideTier({ container: 'mov,mp4,m4a,3gp,3g2,mj2', video: 'h264', audio: 'cook' }), 'audiofix');
  assert.strictEqual(converter.decideTier({ container: 'matroska,webm', video: 'h264', audio: 'wmav2' }), 'audiofix');
});

ok('判定：AVI(Xvid+MP3) 必须重编码', () => {
  assert.strictEqual(converter.decideTier({ container: 'avi', video: 'mpeg4', audio: 'mp3' }), 'transcode');
});

ok('判定：RMVB(RV20+AC3) 必须重编码', () => {
  assert.strictEqual(converter.decideTier({ container: 'rm', video: 'rv20', audio: 'ac3' }), 'transcode');
});

ok('判定：WMV(WMV2+WMA) 必须重编码', () => {
  assert.strictEqual(converter.decideTier({ container: 'asf', video: 'wmv2', audio: 'wmav2' }), 'transcode');
});

ok('判定：MPEG-TS 里的 MPEG-2 视频必须重编码（容器认、编码不认）', () => {
  assert.strictEqual(converter.decideTier({ container: 'mpegts', video: 'mpeg2video', audio: 'mp2' }), 'transcode');
});

ok('判定：OGV(Theora) 必须重编码', () => {
  assert.strictEqual(converter.decideTier({ container: 'ogg', video: 'theora', audio: 'vorbis' }), 'transcode');
});

ok('判定：HEVC / 10bit 先按"能播"处理，交给运行时兜底去纠正', () => {
  assert.strictEqual(converter.decideTier({ container: 'matroska,webm', video: 'hevc', audio: 'aac' }), 'native');
});

ok('判定：PCM 音频算能播', () => {
  assert.strictEqual(converter.decideTier({ container: 'mov,mp4,m4a,3gp,3g2,mj2', video: 'h264', audio: 'pcm_s16le' }), 'native');
});

ok('判定：无音频轨的视频不因"没音频"被误判去转码', () => {
  assert.strictEqual(converter.decideTier({ container: 'mpegvideo', video: 'mpeg2video', audio: null }), 'transcode');
  assert.strictEqual(converter.decideTier({ container: 'matroska,webm', video: 'h264', audio: null }), 'native');
});

ok('判定：探测失败时按"直接播"处理（让现有报错提示接管，不要盲目转码）', () => {
  assert.strictEqual(converter.decideTier(null), 'native');
});

ok('缓存文件名：包含大小/时间/档位，且中文与空格安全', () => {
  const n1 = converter.cacheFileName('D:\\影片\\测试 视频（第 1 集）.rmvb', 123456, 1700000000000, 'transcode');
  const n2 = converter.cacheFileName('D:\\影片\\测试 视频（第 1 集）.rmvb', 123456, 1700000000000, 'transcode');
  const n3 = converter.cacheFileName('D:\\影片\\测试 视频（第 1 集）.rmvb', 123457, 1700000000000, 'transcode');
  assert.strictEqual(n1, n2, '同一文件两次调用必须得到同一个名字（缓存才能命中）');
  assert.notStrictEqual(n1, n3, '文件大小变了必须换名字');
  assert.ok(!/[\\/:*?"<>|]/.test(n1), '文件名不能含 Windows 非法字符');
  assert.ok(n1.endsWith('.mp4'), '产物必须是 .mp4');
  assert.ok(n1.includes('transcode'), '名字里要能看出档位（排查用）');
});

ok('进度解析：拿到已转出时长与完成标记', () => {
  const text = 'frame=120\nfps=30\nout_time_ms=4680000\nspeed=16x\nprogress=continue\n';
  const p = converter.parseProgress(text);
  assert.strictEqual(p.outTimeSec, 4.68);
  assert.strictEqual(p.done, false);
  const end = converter.parseProgress('out_time_us=1000000\nprogress=end\n');
  assert.strictEqual(end.done, true);
});

ok('进度解析：必须读出 total_size（产物体积闸门靠它，缺了就拦不住巨物）', () => {
  // 真实 ffmpeg -progress 输出片段（实测形态）
  const text = 'frame=45\nfps=0.00\ntotal_size=73674\nout_time_us=3018594\nout_time_ms=3018594\nspeed=2.34e+03x\nprogress=end\n';
  const p = converter.parseProgress(text);
  assert.strictEqual(p.totalSize, 73674, '必须解析出 total_size（字节）');
  assert.strictEqual(Math.round(p.outTimeSec * 1000) / 1000, 3.019);
});

ok('进度百分比：总时长未知时不返回 NaN', () => {
  assert.strictEqual(converter.progressPercent(5, 0), 0);
  assert.strictEqual(converter.progressPercent(5, 10), 50);
  assert.strictEqual(converter.progressPercent(99, 10), 100);
});

ok('探测输出解析：拿到画面分辨率（转码码率要按它算）', () => {
  const stderr = [
    "Input #0, mpeg, from 'D:\\a.vob':",
    '  Duration: 00:01:00.00, start: 0.000000, bitrate: 6000 kb/s',
    '  Stream #0:0: Video: mpeg2video (Main), yuv420p, 720x576 [SAR 16:15 DAR 4:3], 25 fps'
  ].join('\n');
  const p = converter.parseProbe(stderr);
  assert.strictEqual(p.width, 720);
  assert.strictEqual(p.height, 576);
});

ok('软件编码码率随分辨率走（SD 老片不能被灌成 4Mbps 巨文件）', () => {
  assert.strictEqual(converter.openh264Bitrate(1080), '6M');
  assert.strictEqual(converter.openh264Bitrate(720), '4M');
  assert.strictEqual(converter.openh264Bitrate(576), '2M');
  assert.strictEqual(converter.openh264Bitrate(0), '2M');
});

ok('硬件编码器失败的判定要覆盖"驱动不支持的 NVENC 版本"（本机真实踩到过）', () => {
  const real = 'Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0';
  assert.strictEqual(converter.looksLikeEncoderFailure(real), true, '这条必须被认成"编码器用不了"，否则不会退到软件编码');
  assert.strictEqual(converter.looksLikeEncoderFailure('Error while opening encoder for output stream #0:0'), true);
  assert.strictEqual(converter.looksLikeEncoderFailure('Cannot load nvcuda.dll'), true);
  assert.strictEqual(converter.looksLikeEncoderFailure('Invalid data found when processing input'), false, '输入文件坏了不该被当成编码器问题（否则会白白重试 5 次）');
});

ok('输入文件本身的错误要能被识别（不再换 4 个编码器白跑）', () => {
  assert.strictEqual(converter.looksLikeInputError('Invalid data found when processing input'), true);
  assert.strictEqual(converter.looksLikeInputError('Error opening input files: No such file or directory'), true);
  assert.strictEqual(converter.looksLikeInputError('moov atom not found'), true);
  assert.strictEqual(converter.looksLikeInputError('Driver does not support the required nvenc API version'), false);
});

ok('产物空间估算要贴合真实体积（旧公式把 20GB 的 VOB 判成"需要 30GB"而拒绝转换）', () => {
  const oneHour = 3600;
  const vob = converter.estimateOutputBytes('transcode', 20 * 1024 ** 3, oneHour, 576);   // DVD 老片
  assert.ok(vob < 3 * 1024 ** 3, 'DVD 一小时重编码应估在 3GB 以内，实际 ' + (vob / 1024 ** 3).toFixed(1) + 'GB');
  const hd = converter.estimateOutputBytes('transcode', 20 * 1024 ** 3, oneHour, 1080);
  assert.ok(hd > 2 * 1024 ** 3 && hd < 8 * 1024 ** 3, '1080p 一小时重编码应估在 2~8GB，实际 ' + (hd / 1024 ** 3).toFixed(1) + 'GB');
  const remux = converter.estimateOutputBytes('remux', 40 * 1024 ** 3, oneHour, 1080);
  assert.ok(remux >= 40 * 1024 ** 3 && remux < 45 * 1024 ** 3, '换容器约等于复制一份，实际 ' + (remux / 1024 ** 3).toFixed(1) + 'GB');
  assert.strictEqual(converter.estimateOutputBytes('transcode', 1024, 0, 0) >= 512 * 1024 * 1024, true, '时长未知也要给下限，不能算出 0');
});

ok('单文件产物体积上限必须真的配好（防"转出 100GB 撑爆磁盘"）', () => {
  const cfg = converter.currentConfig();
  assert.ok(Number.isFinite(cfg.maxOutputBytes) && cfg.maxOutputBytes > 0,
    '必须存在单文件产物体积上限（此前文档声称有、代码里其实没有）');
  assert.ok(cfg.maxOutputBytes <= cfg.maxCacheBytes,
    '单文件上限不能超过整个缓存上限，否则缓存淘汰永远追不上产出');
});

ok('缓存的两条语义：档位必须编进产物名（强制档位绕缓存才有意义）', () => {
  const p = 'D:\\v\\movie.avi';
  const remux = converter.cacheFileName(p, 100, 2000, 'remux');
  const audiofix = converter.cacheFileName(p, 100, 2000, 'audiofix');
  const transcode = converter.cacheFileName(p, 100, 2000, 'transcode');
  assert.notStrictEqual(remux, audiofix, '不同档位的产物名必须不同');
  assert.notStrictEqual(audiofix, transcode, '不同档位的产物名必须不同');
  for (const n of [remux, audiofix, transcode]) {
    assert.ok(n.includes('.v1.'), '产物名必须带管线版本号（改转换逻辑后旧缓存自动失效）');
  }
});

ok('看门狗超时与"用户取消"必须是两种错误（否则真实原因被静默吞掉）', () => {
  // 实测：Windows 上 kill 子进程后 close 回调是 code=null/signal=SIGTERM，
  // 与"用户换片主动取消"在事件层面完全一样。若不单独记超时标志，
  // "源文件所在磁盘/网络断开"会被报成"用户取消"并被 main.js 静默忽略，
  // 用户只看到"无法解析媒体源"，误以为文件坏了。
  const src = fs.readFileSync(path.join(ROOT, 'converter.js'), 'utf8');
  assert.ok(/let timedOut = false/.test(src), '看门狗必须有自己的超时标志位');
  assert.ok(/timedOut = true/.test(src), '看门狗触发时必须置位该标志');
  assert.ok(/isTimeout: true/.test(src), '超时错误必须带 isTimeout 标记（供上层区分与跳过重试）');
  assert.ok(/e\.isTimeout\) throw e/.test(src), '转码重试循环里遇到超时必须直接失败（换编码器只会再等 120 秒）');
  // 关键顺序：超时判断必须排在 signal 判断之前，否则永远走不到（signal 总是先满足）。
  // 从 runFfmpegOnce 定义处开始找 close 回调，避开 isAvailable 里同名的那个。
  const fnIdx = src.indexOf('function runFfmpegOnce(');
  assert.ok(fnIdx > 0, '必须能找到 runFfmpegOnce');
  const body = src.slice(fnIdx);
  const closeIdx = body.indexOf("child.on('close'");
  assert.ok(closeIdx > 0, 'runFfmpegOnce 里必须能找到 close 回调');
  const tail = body.slice(closeIdx, closeIdx + 1600);
  const timeoutIdx = tail.indexOf('if (timedOut)');
  const signalIdx = tail.indexOf('if (signal)');
  assert.ok(timeoutIdx > 0, 'close 回调里必须判断超时标志');
  assert.ok(signalIdx > 0, 'close 回调里必须判断 signal');
  assert.ok(timeoutIdx < signalIdx, '超时判断必须排在 signal 判断之前，否则永远走不到');
});

ok('缓存淘汰不能依赖 atime（Windows NTFS 默认不更新它）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'converter.js'), 'utf8');
  assert.ok(!/a\.atime - b\.atime/.test(src), '不能按 atime 排序：NTFS 上 atime 恒等于创建时间，会退化成"按创建时间淘汰"（天天看的老剧先被删）');
  assert.ok(/used: lastUsedAt\.get\(p\) \|\| st\.mtimeMs/.test(src),
    '应按"最后一次被使用的时间"排序，缺记录时退回 mtime');
  assert.ok(/function markUsed/.test(src), '必须存在 markUsed 记录函数');
  // 至少要在"命中缓存"和"新产出产物"两类返回点上真的打过标记
  const calls = (src.match(/markUsed\(/g) || []).length;
  assert.ok(calls >= 5, `markUsed 至少要在 5 处被调用（实际 ${calls} 处：定义 1 + 4 个产物使用点）`);
});

ok('原生扩展名的强制档产物复用顺序：transcode 必须优先于 audiofix', () => {
  const src = fs.readFileSync(path.join(ROOT, 'converter.js'), 'utf8');
  assert.ok(/for \(const t of \['transcode', 'audiofix'\]\)/.test(src),
    '必须先找 transcode 产物：它是 audiofix 的超集。反过来的话，' +
    '"先只换音频、后又要重编码"的文件第二次打开会复用到那个播不出来的 audiofix 产物 → 又黑屏一次');
});

// ============ 第二层：真实样本验证（需要有 ffmpeg 与样本） ============

const ffmpegPath = process.env.BB_FFMPEG || path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const samplesDir = process.env.BB_SAMPLES || '';

// 真机内核实测结果（来自《格式扩展开发报告》第 5.1 节的 22 样本 × 3 档验证）
const MEASURED = {
  '05_h264_aac.mkv': 'native',
  '14_h264_aac.avi': 'remux',
  '15_h264_aac.flv': 'remux',
  '20_h264_aac.ts': 'remux',
  '21_h264_aac.m2ts': 'remux',
  '41_mkv_h264_ac3.mkv': 'audiofix',
  '42_mkv_h264_dts.mkv': 'audiofix',
  '61_mkv_h264_eac3.mkv': 'audiofix',
  '62_mp4_h264_ac3.mp4': 'audiofix',
  '13_xvid_mp3.avi': 'transcode',
  '47_mp4_xvid.mp4': 'transcode',
  '16_flv1_mp3.flv': 'transcode',
  '17_wmv2_wmav2.wmv': 'transcode',
  '18_mpeg1_mp2.mpg': 'transcode',
  '19_mpeg2_mp2.mpeg': 'transcode',
  '22_mpeg2_mp2.vob': 'transcode',
  '23_mpeg2.m2v': 'transcode',
  '25_theora_vorbis.ogv': 'transcode',
  '26_rv20_ac3.rm': 'transcode',
  '27_rv20_ac3.rmvb': 'transcode',
  '50_mov_prores.mov': 'transcode',
  '60_3gp_h263_amr.3gp': 'transcode'
};

if (!fs.existsSync(ffmpegPath)) {
  console.log('\n[跳过] 未找到 ffmpeg（' + ffmpegPath + '），真实转换验证未执行');
  console.log(`\n[OK] converter 自检全部通过（${passed} 项）`);
} else {
  // ============ 第二层 A：自带样本的真实转换验证（不需要 BB_SAMPLES，默认就会跑）============
  // 这些用例自己造样本，专门盯住"必须用真 ffmpeg 才能验证"的关键行为。
  // 有了它，"没设 BB_SAMPLES 就什么都验不了"这个缺口被补上了。
  (async () => {
    const selfDir = path.join(os.tmpdir(), 'bb-verify-self');
    fs.mkdirSync(selfDir, { recursive: true });
    const prevCache = converter.currentConfig().cacheDir;
    converter.configure({ cacheDir: path.join(selfDir, 'cache') });

    // 换片必须立刻作废旧任务，且**不能**把新片堵在队列后面。
    // 这条盯的是一个真实踩过的严重缺陷：代号原本在"探测之后"才记录，导致
    // "打开长片 → 探测期间换片 → 长片探测完才读代号"时，长片读到作废后的新代号、
    // 误以为自己有效，于是把长片完整转码（实测堵住新片 37.8 秒，修复后 0.4 秒）。
    try {
      const longAvi = path.join(selfDir, 'long.avi');
      const shortAvi = path.join(selfDir, 'short.avi');
      const mk = (args) => spawnSync(ffmpegPath, args, { windowsHide: true, timeout: 180000 });
      if (!fs.existsSync(longAvi)) {
        mk(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
          '-i', 'testsrc=d=180:s=640x480:r=25', '-f', 'lavfi', '-i', 'sine=f=440:d=180',
          '-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'libmp3lame', '-shortest', longAvi]);
      }
      if (!fs.existsSync(shortAvi)) {
        mk(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
          '-i', 'testsrc=d=2:s=320x240:r=25', '-f', 'lavfi', '-i', 'sine=f=440:d=2',
          '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'libmp3lame', '-shortest', shortAvi]);
      }
      const longOk = fs.existsSync(longAvi) && fs.statSync(longAvi).size > 10000;
      const shortOk = fs.existsSync(shortAvi) && fs.statSync(shortAvi).size > 1000;
      if (longOk && shortOk) {
        const t0 = Date.now();
        // 立刻挂上处理器（真实调用方 main.js 也是包在 try/catch 里的）
        const oldTask = converter.prepare(longAvi, { key: 'switch-W' }).then(
          () => 'completed', (e) => (e && e.name) || 'error'
        );
        await new Promise(r => setTimeout(r, 60));      // 用户很快就换了片
        converter.invalidate('switch-W');
        const fresh = await converter.prepare(shortAvi, { key: 'switch-W' }).catch(() => null);
        const elapsed = Date.now() - t0;
        const oldResult = await oldTask;
        assert.ok(fresh, '换片后的新请求必须能拿到结果');
        assert.ok(elapsed < 20000,
          `换片后新片必须很快返回（修复前实测会被旧任务堵 37.8 秒），实际 ${elapsed}ms —— ` +
          '说明旧任务的作废检查点漏了（代号必须在 prepare 开头、任何 await 之前记录）');
        assert.strictEqual(oldResult, 'CancelledError',
          `被换掉的旧任务必须作废退出，实际 ${oldResult}（'completed' = 白转了整个长片）`);
        passed++;
        console.log(`[通过] 换片作废：旧任务已取消，新片 ${elapsed}ms 返回（未被旧任务堵住）`);
      } else {
        console.log('[跳过] 换片作废验证：自带样本生成失败');
      }
    } catch (e) {
      console.error('[失败] 换片作废验证异常: ' + (e && e.message));
      process.exit(1);
    } finally {
      converter.configure({ cacheDir: prevCache });
    }

    // ============ 第二层 B：真实样本对账（可选，需 BB_SAMPLES 指向样本目录）============
    // 这一段拿"真机内核实测结果"逐样本对账判定表，是最权威的一层，但依赖外部样本。
    if (!samplesDir || !fs.existsSync(samplesDir)) {
      console.log('[跳过] 真实样本对账未执行（设 BB_SAMPLES 指向样本目录即可启用，见 docs/DEVELOPER.md 第 20 节）');
      console.log(`\n[OK] converter 自检全部通过（${passed} 项）`);
      return;
    }
    converter.configure({ ffmpegPath, cacheDir: path.join(os.tmpdir(), 'bb-verify-cache') });
    let same = 0;
    let skippedNative = 0;
    const diffs = [];
    for (const [file, expected] of Object.entries(MEASURED)) {
      const full = path.join(samplesDir, file);
      if (!fs.existsSync(full)) { diffs.push(file + '（样本缺失）'); continue; }
      // 原生扩展名（mkv/mp4/mov/ogv 等）走"快速通道"：不探测、不转换，直接交给内核；
      // 它们里面的怪编码由渲染端的运行时兜底处理（已由 renderer 的测试覆盖），不参与这里的对账。
      const ext = path.extname(file).slice(1).toLowerCase();
      if (converter.NATIVE_EXTS.has(ext)) { skippedNative++; continue; }
      const p = converter.probeFileSync(full);
      const got = converter.decideTier(p);
      if (got === expected) same++;
      else diffs.push(`${file}: 期望 ${expected} 实际 ${got}`);
    }
    assert.deepStrictEqual(diffs, [], '真实样本判定与实测不符:\n  ' + diffs.join('\n  '));
    passed++;
    console.log(`[通过] 真实样本判定对账：${same} / ${same + skippedNative} 与真机内核实测一致` +
      `（另有 ${skippedNative} 个原生扩展名走快速通道，不在本项对账范围）`);

    // 真跑一次转换：这一步才能抓住"命令拼错/临时文件命名错/产物不落地"这类问题
    // （曾经踩过：临时文件叫 xxx.mp4.part 导致 ffmpeg 认不出封装格式而失败）
    const cases = [
      { file: '20_h264_aac.ts', tier: 'remux' },
      { file: '13_xvid_mp3.avi', tier: 'transcode' },
      { file: '41_mkv_h264_ac3.mkv', force: 'audiofix', tier: 'audiofix' }
    ];
    for (const c of cases) {
      const input = path.join(samplesDir, c.file);
      if (!fs.existsSync(input)) { console.log('[跳过] 转换用例样本缺失: ' + c.file); continue; }
      const key = 'verify-' + c.file;
      const r = await converter.prepare(input, { key, force: c.force || null });
      assert.strictEqual(r.tier, c.tier, `${c.file} 档位应为 ${c.tier}，实际 ${r.tier}`);
      assert.strictEqual(r.converted, true, `${c.file} 必须产出转换文件（否则等于没转）`);
      const product = decodeURIComponent(r.url.replace('file:///', ''));
      assert.ok(fs.existsSync(product) && fs.statSync(product).size > 1024, `${c.file} 产物必须真实落地且非空: ${product}`);
      const again = await converter.prepare(input, { key, force: c.force || null });
      if (c.force) {
        // 强制档位只在"运行时兜底"时出现（说明现有产物播不出来）→ 必须重转，不能命中缓存
        assert.strictEqual(again.converted, true, `${c.file} 强制档位必须产出转换文件`);
        assert.notStrictEqual(again.cached, true, `${c.file} 强制档位不能命中缓存，否则兜底等于空转`);
      } else {
        assert.strictEqual(again.cached, true, `${c.file} 第二次打开必须命中缓存（否则每次开片都要重转）`);
      }
      passed++;
      console.log(`[通过] 真实转换：${c.file} → ${c.tier}，产物 ${Math.round(fs.statSync(product).size / 1024)} KB，二次打开${c.force ? '按强制档位重转' : '命中缓存'}`);
    }

    // 两个窗口同时打开同一个待转文件：必须都拿到同一个产物，且不能转出两份
    const dupInput = path.join(samplesDir, '27_rv20_ac3.rmvb');
    if (fs.existsSync(dupInput)) {
      const [r1, r2] = await Promise.all([
        converter.prepare(dupInput, { key: 'dup-a' }),
        converter.prepare(dupInput, { key: 'dup-b' })
      ]);
      assert.strictEqual(r1.url, r2.url, '并发打开同一文件必须得到同一个产物（否则会重复转换、缓存串号）');
      passed++;
      console.log('[通过] 并发打开同一文件：两条请求得到同一产物，不重复转换');
    }

    // 进度上报：曾经漏了 `-progress pipe:1`，ffmpeg 一个字都不往 stdout 写、进度回调一次都不触发，
    // 长转码期间界面看不到任何百分比。这条测试就是用来盯住那个参数的。
    const longXvid = path.join(samplesDir, '80_long_xvid.mp4');
    if (fs.existsSync(longXvid)) {
      const calls = [];
      const r = await converter.prepare(longXvid, { key: 'prog', force: 'transcode', onProgress: (p) => calls.push(p) });
      assert.strictEqual(r.converted, true, '强制档位必须真的转换');
      assert.ok(calls.length > 0, '转码必须上报进度（少了 -progress pipe:1 就一条都不会有）');
      assert.ok(calls.some((c) => Number.isFinite(c.percent)), '进度必须带数字百分比');
      passed++;
      console.log(`[通过] 进度上报：收到 ${calls.length} 次进度回调（最后一次 ${calls[calls.length - 1].percent}%）`);

      // 强制档位必须绕过缓存：否则运行时兜底会命中"那个播不出来的产物"，等于空转
      const again = await converter.prepare(longXvid, { key: 'prog2', force: 'transcode' });
      assert.notStrictEqual(again.cached, true, '强制档位不能命中缓存，否则兜底什么都没做');
      passed++;
      console.log('[通过] 强制档位绕过缓存：确实重新转了一遍');
    }

    // 原生扩展名 + 内部音轨不兼容：转好一次后，第二次普通打开必须直接复用产物，
    // 否则又会静音，而"每文件一次"的兜底已挡住重试 —— 用户只能重启软件。
    const dtsMkv = path.join(samplesDir, '42_mkv_h264_dts.mkv');
    if (fs.existsSync(dtsMkv)) {
      await converter.prepare(dtsMkv, { key: 'reuse1', force: 'audiofix' });
      const plain = await converter.prepare(dtsMkv, { key: 'reuse2' });
      assert.strictEqual(plain.tier, 'audiofix', '第二次打开必须复用已转好的音频修复产物');
      assert.strictEqual(plain.converted, true, '第二次打开不该退回原始 MKV');
      assert.strictEqual(plain.cached, true, '第二次打开必须命中缓存');
      passed++;
      console.log('[通过] 已兜底过的文件第二次打开：直接复用产物，不再静音');
    }

    // 产物体积闸门：磁盘预检只是"按码率×时长估算"，估算偏小或素材异常时仍可能把磁盘写满。
    // 这条用真 ffmpeg 跑，确认闸门真的会在超限时中止（而不是静默转出一个巨物）。
    // 注意不要用 ffmpeg 的 -fs：实测它触顶时以异常码退出、产物不落地，等于把已转的部分白扔。
    const gateSrc = path.join(samplesDir, '13_xvid_mp3.avi');
    if (fs.existsSync(gateSrc)) {
      converter.configure({ maxOutputBytes: 64 * 1024 });   // 故意压到 64KB，任何真实转换都会超
      let blocked = false;
      let msg = '';
      try {
        await converter.prepare(gateSrc, { key: 'gate-test', force: 'transcode' });
      } catch (e) {
        blocked = true;
        msg = e && e.message;
        assert.strictEqual(e.isOutputTooLarge, true, '超限错误必须带 isOutputTooLarge 标记（否则会被当成编码器故障反复重试）');
      }
      converter.configure({ maxOutputBytes: 16 * 1024 ** 3 });   // 恢复，别影响其它用例
      assert.ok(blocked, '产物体积超限时转换必须被中止，实际没有拦住');
      passed++;
      console.log('[通过] 产物体积闸门：超限时中止转换（' + msg + '）');
    }

    console.log(`\n[OK] converter 自检全部通过（${passed} 项）`);
  })().catch((e) => {
    console.error('\n[失败] ' + (e && e.stack || e));
    process.exit(1);
  });
}
