// 扩展名一致性对账：shared-video-exts.js（事实来源）↔ package.json 的
// build.fileAssociations.ext（electron-builder 独立配置，无法引用 JS 模块）。
// 用法：node verify-exts.js（在项目根目录执行；不通过则退出码非 0）。
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const exts = require('./shared-video-exts');

// 1) 结构自洽：三层清单相加 = 全部，且三层之间不得重复
const groups = { video: exts.video, convertibleVideo: exts.convertibleVideo, audio: exts.audio };
assert.ok(Array.isArray(exts.convertibleVideo) && exts.convertibleVideo.length > 0, 'convertibleVideo 必须存在');
assert.ok(
  exts.video.length + exts.convertibleVideo.length + exts.audio.length === exts.all.length,
  'video + convertibleVideo + audio 必须等于 all'
);
const seen = new Set();
for (const [group, list] of Object.entries(groups)) {
  for (const e of list) {
    assert.ok(!seen.has(e), `扩展名重复定义: ${e}（在 ${group} 里）`);
    seen.add(e);
  }
}

// 2) 与 package.json 的 fileAssociations 对账（成员一致即可，不看顺序）
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const assoc = pkg.build.fileAssociations[0].ext;
const missing = exts.all.filter(e => !assoc.includes(e));
const extra = assoc.filter(e => !exts.all.includes(e));
assert.deepStrictEqual(missing, [], `fileAssociations 缺少扩展名: ${missing.join(', ')}`);
assert.deepStrictEqual(extra, [], `fileAssociations 含有未定义扩展名: ${extra.join(', ')}`);

console.log(`[OK] 扩展名对账通过：原生视频 ${exts.video.length} + 需转换视频 ${exts.convertibleVideo.length} + 音频 ${exts.audio.length} = 全部 ${exts.all.length}，与 package.json fileAssociations 一致`);