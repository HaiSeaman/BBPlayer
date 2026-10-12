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

console.log(`[OK] 端到端接线对账通过：打包清单 ${REQUIRED_IN_PACKAGE.length} 个必需文件齐全；` +
  `renderer 调用的 ${called.size} 个 API 全部已暴露；` +
  `IPC 通道 ${invoked.size} 发/${listened.size} 收全部对得上；` +
  `HTML 引用 ${htmlRefs.length} 个本地资源均存在；` +
  `窗口钳制与目录截断标记 2 条防御性修复到位`);
