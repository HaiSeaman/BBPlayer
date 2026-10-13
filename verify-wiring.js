// 端到端接线对账（零依赖，与 verify-exts.js / verify-converter.js / verify-renderer.js 同风格）
// 用法：node verify-wiring.js
//
// 为什么要有它：这个项目是"零构建"的 Electron 应用——主进程、preload、渲染进程、
// 打包清单、HTML 之间的契约全靠手写字符串对齐，没有任何类型系统或打包器帮忙检查。
// 一旦对不上，症状往往是**运行时的静默失效**（调了个不存在的 API → 抛异常被吞掉；
// 监听了主进程从不发送的通道 → 回调永不触发；打包漏了一个文件 → 安装后才崩），
// 而这些都极难靠"打开软件点一点"发现。这里把五组契约全部机器化对账。
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = __dirname;
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const mainSrc = read('main.js');
const preSrc = read('preload.js');
const renSrc = read('renderer.js');
const htmlSrc = read('index.html');
const pkg = JSON.parse(read('package.json'));

// 1) 打包清单必须覆盖所有运行必需文件（漏一个就是"安装后才崩"）
const REQUIRED_IN_PACKAGE = [
  'main.js', 'preload.js', 'renderer.js', 'converter.js', 'index.html',
  'shared-video-exts.js', 'shared-subtitle-exts.js', 'package.json'
];
const missingPacked = REQUIRED_IN_PACKAGE.filter(f => !pkg.build.files.includes(f));
assert.deepStrictEqual(missingPacked, [], `打包清单 build.files 缺少运行必需文件: ${missingPacked.join(', ')}`);
assert.ok(fs.existsSync(path.join(ROOT, pkg.main)), `package.json 的 main 指向的文件不存在: ${pkg.main}`);

// 2) 主进程 require 的本地模块必须都存在
const mainRequires = [...mainSrc.matchAll(/require\('(\.\/[^']+)'\)/g)].map(m => m[1]);
const missingDeps = mainRequires.filter((m) => {
  const p = path.join(ROOT, m);
  return !fs.existsSync(p) && !fs.existsSync(p + '.js');
});
assert.deepStrictEqual(missingDeps, [], `主进程依赖缺失: ${missingDeps.join(', ')}`);

// 3) renderer 调用的 electronAPI 方法，preload 必须真的暴露了
const exposed = new Set([...preSrc.matchAll(/^\s{2}([A-Za-z_]\w*):/gm)].map(m => m[1]));
const called = new Set([...renSrc.matchAll(/electronAPI\.([A-Za-z_]\w*)/g)].map(m => m[1]));
const notExposed = [...called].filter(c => !exposed.has(c));
assert.deepStrictEqual(notExposed, [], `renderer 调用了 preload 未暴露的 API: ${notExposed.join(', ')}`);

// 4) IPC 通道对账：preload 发的通道主进程要处理；preload 监听的通道主进程要发
const handled = new Set([
  ...[...mainSrc.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]),
  ...[...mainSrc.matchAll(/ipcMain\.on\('([^']+)'/g)].map(m => m[1])
]);
const sent = new Set([...mainSrc.matchAll(/webContents\.send\('([^']+)'/g)].map(m => m[1]));
const invoked = new Set([
  ...[...preSrc.matchAll(/invoke\('([^']+)'/g)].map(m => m[1]),
  ...[...preSrc.matchAll(/ipcRenderer\.send\('([^']+)'/g)].map(m => m[1])
]);
const listened = new Set([...preSrc.matchAll(/makeIdempotentSubscriber\('([^']+)'\)/g)].map(m => m[1]));
const noHandler = [...invoked].filter(c => !handled.has(c));
assert.deepStrictEqual(noHandler, [], `preload 发出但主进程没有处理器的通道（调用会挂住/报错）: ${noHandler.join(', ')}`);
const noSender = [...listened].filter(c => !sent.has(c));
assert.deepStrictEqual(noSender, [], `preload 监听但主进程从不发送的通道（回调永不触发）: ${noSender.join(', ')}`);

// 5) HTML 引用的本地资源必须存在
const htmlRefs = [...htmlSrc.matchAll(/src="([^"]+)"/g)].map(m => m[1]).filter(s => !/^https?:/.test(s));
const missingRefs = htmlRefs.filter(r => !fs.existsSync(path.join(ROOT, r)));
assert.deepStrictEqual(missingRefs, [], `index.html 引用了不存在的文件: ${missingRefs.join(', ')}`);

// 6) 主进程两条"容易改回去"的防御性修复，用静态契约盯住
//    —— 它们都不会报错、只会让用户遇到"关不掉窗口"/"文件莫名消失"，必须有人看着。
{
  // 6a) 窗口尺寸必须被钳进当前工作区。本软件是 frame:false 无边框窗口，
  //     最小化/最大化/关闭按钮画在右上角；从 4K 屏换到 1080p 屏时若只钳位置不钳尺寸，
  //     窗口会比屏幕宽一大截，右上角按钮整体落在屏外 → 用户关不掉也拖不动窗口。
  assert.ok(/state\.width = Math\.max\([\s\S]{0,80}Math\.min\(state\.width, wa\.width\)\)/.test(mainSrc),
    'loadWindowState 必须把 width 钳进工作区宽度（否则换小屏后无边框窗口的关闭按钮会落在屏幕外）');
  assert.ok(/state\.height = Math\.max\([\s\S]{0,80}Math\.min\(state\.height, wa\.height\)\)/.test(mainSrc),
    'loadWindowState 必须把 height 钳进工作区高度');
  // 6b) 目录扫描深度超限必须标记 truncated：此前直接 return，深层视频静默消失，
  //     用户以为"文件夹就这些片子"，而数量触顶却会如实提示 —— 两种"没扫全"应同等待遇。
  const walkIdx = mainSrc.indexOf('async function walk(dir, depth)');
  assert.ok(walkIdx > 0, '必须能找到 scanDirectorySafe 的 walk 函数');
  const walkBody = mainSrc.slice(walkIdx, walkIdx + 400);
  const depthReturnIdx = walkBody.indexOf('if (depth > maxDepth)');
  assert.ok(depthReturnIdx >= 0, '必须能找到深度上限判断');
  const depthBlock = walkBody.slice(depthReturnIdx, depthReturnIdx + 80);
  assert.ok(/truncated = true/.test(depthBlock),
    '目录扫描深度超限时必须置 truncated=true（否则深层视频静默丢失，用户不会知道）');
}

// 7) 控制栏收起时必须关掉毛玻璃（GPU 开销约束，用静态契约盯住）
//    —— 毛玻璃 backdrop-filter 在背后画面变化时每帧都要重算；视频播放期控制栏若一直亮着，
//       它就是持续 GPU 开销。收起态（.hide）必须显式置 backdrop-filter: none。
//    这条规则只在 .hide 生效，静态截图/肉眼打开页面都验不出来，必须用契约盯住。
{
  const hideIdx = htmlSrc.indexOf('#controls-overlay.hide');
  assert.ok(hideIdx > 0, '必须能找到 #controls-overlay.hide 规则（控制栏收起态）');
  const hideBlock = htmlSrc.slice(hideIdx, hideIdx + 600);
  const blockEnd = hideBlock.indexOf('}');
  assert.ok(blockEnd > 0, '#controls-overlay.hide 规则必须有完整的 { } 块');
  assert.ok(/backdrop-filter:\s*none/.test(hideBlock.slice(0, blockEnd)),
    '控制栏收起(.hide)时必须 backdrop-filter: none（否则播放期毛玻璃每帧重算，白白烧 GPU）');
  // 同时盯住：renderer 的 play 事件必须真的调用自动收起函数（改了 CSS 却没接线 = 白改）
  assert.ok(/hideControlsIfUnused/.test(renSrc), 'renderer 必须定义并调用 hideControlsIfUnused（播放开始自动收起控制栏）');
  const playIdx = renSrc.indexOf("video.addEventListener('play'");
  assert.ok(playIdx > 0, '必须能找到 video 的 play 监听');
  assert.ok(/hideControlsIfUnused\(\)/.test(renSrc.slice(playIdx, playIdx + 800)),
    'video 的 play 监听里必须调用 hideControlsIfUnused()，否则控制栏永远不自动收起');
}

// 8) 本轮审查修复的 4 条"改了但容易改回去"的问题，用静态契约盯住
{
  // 8a) loadWindowState 的尺寸钳制必须**无条件**执行。
  //     可见性校验会 delete x/y；若尺寸钳制挂在 hasPos 条件里，最需要钳制的场景反而被跳过。
  const hasPosIdx = mainSrc.indexOf('const hasPos');
  const clampIdx = mainSrc.indexOf('state.width = Math.max(480, Math.min(state.width, wa.width))');
  const posGuardIdx = mainSrc.indexOf('if (hasPos) {');
  assert.ok(hasPosIdx > 0 && clampIdx > 0 && posGuardIdx > 0, '必须能找到 hasPos / 尺寸钳制 / hasPos 分支');
  assert.ok(clampIdx < posGuardIdx, '尺寸钳制必须排在 if (hasPos) 之前（无条件执行），否则存档位置无效时窗口会宽出屏幕、关不掉');
  assert.ok(/screen\.getPrimaryDisplay\(\)\.workArea/.test(mainSrc), 'x/y 被删时必须退回主显示器工作区钳制尺寸');
  // 8b) keydown 不得对 button 一刀切放行（否则点过按钮后方向键/F11/S/M 全部失效）
  assert.ok(!/'input, button, textarea, select'/.test(renSrc),
    'keydown 不能把 button 一并 return（按钮聚焦会吞掉全部快捷键）');
  assert.ok(/closest\('button'\)\s*&&\s*\(e\.code === 'Space' \|\| e\.code === 'Enter'\)/.test(renSrc),
    'button 只应在 Space/Enter 上让行（避免与按钮自身 click 双重触发）');
  // 8c) 程序化挪窗不得写进窗口状态记忆
  assert.ok(/programmaticMoveTargets/.test(mainSrc), '必须存在 programmaticMoveTargets（区分程序化挪窗与用户挪窗）');
  assert.ok(!/win\.on\('move', scheduleStateSave\)/.test(mainSrc),
    "move 不能无条件 scheduleStateSave（换片自动贴合的位置会覆盖用户偏好）");
  // 8d) 多文件开窗（second-instance / 冷启动）必须同样受窗口上限约束
  const limitUses = (mainSrc.match(/MAX_PLAYER_WINDOWS/g) || []).length;
  assert.ok(limitUses >= 5, `MAX_PLAYER_WINDOWS 至少要在 5 处被引用（定义 1 + openInNewWindow 2 + second-instance 1 + 冷启动 1），实际 ${limitUses}`);
  // 8e) 多余导出已移除（内部仍在使用这些常量，只是不再对外暴露）
  const convSrc = read('converter.js');
  const expIdx = convSrc.indexOf('module.exports = {');
  assert.ok(expIdx > 0, '必须能找到 converter.js 的 module.exports');
  const expBlock = convSrc.slice(expIdx, convSrc.indexOf('};', expIdx));
  for (const sym of ['NATIVE_CONTAINERS', 'OK_VIDEO', 'OK_AUDIO', 'PIPELINE_VERSION']) {
    assert.ok(!expBlock.includes(sym), `${sym} 不应再出现在导出里（无任何消费者）`);
  }
  assert.ok(expBlock.includes('NATIVE_EXTS'), 'NATIVE_EXTS 必须保留导出（verify-converter.js 在用）');
}

console.log(`[OK] 端到端接线对账通过：打包清单 ${REQUIRED_IN_PACKAGE.length} 个必需文件齐全；` +
  `renderer 调用的 ${called.size} 个 API 全部已暴露；` +
  `IPC 通道 ${invoked.size} 发/${listened.size} 收全部对得上；` +
  `HTML 引用 ${htmlRefs.length} 个本地资源均存在；` +
  `窗口钳制/目录截断/控制栏收起关模糊/尺寸钳制无条件/快捷键范围/挪窗记忆/窗口上限/导出收敛 8 条防御性修复到位`);
