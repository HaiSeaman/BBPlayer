// 扩展名一致性对账：shared-video-exts.js（事实来源）↔ package.json 的
// build.fileAssociations.ext（electron-builder 独立配置，无法引用 JS 模块）。
// 用法：node verify-exts.js（在项目根目录执行；不通过则退出码非 0）。
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const exts = require('./shared-video-exts');

// 1) 结构自洽：视频 + 音频 = 全部，且无重复
assert.ok(exts.video.length + exts.audio.length === exts.all.length, 'video.length + audio.length 必须等于 all.length');
const seen = new Set();
for (const e of [...exts.video, ...exts.audio]) {
  assert.ok(!seen.has(e), `扩展名重复定义: ${e}`);
  seen.add(e);
}

// 2) 与 package.json 的 fileAssociations 对账（成员一致即可，不看顺序）
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const assoc = pkg.build.fileAssociations[0].ext;
const missing = exts.all.filter(e => !assoc.includes(e));
const extra = assoc.filter(e => !exts.all.includes(e));
assert.deepStrictEqual(missing, [], `fileAssociations 缺少扩展名: ${missing.join(', ')}`);
assert.deepStrictEqual(extra, [], `fileAssociations 含有未定义扩展名: ${extra.join(', ')}`);

console.log(`[OK] 扩展名对账通过：视频 ${exts.video.length} + 音频 ${exts.audio.length} = 全部 ${exts.all.length}，与 package.json fileAssociations 一致`);