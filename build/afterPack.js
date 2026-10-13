// electron-builder 打包后钩子（afterPack）：清掉 BBPlayer 用不到的大体积内核文件。
//
// 背景：Electron 的 Windows 发行包里带着 dxcompiler.dll + dxil.dll（合计约 26MB），
// 它们是 WebGPU（网页 3D 图形接口）编译 GPU 着色器用的。BBPlayer 只用 <video> 播视频，
// 完全不使用 WebGPU —— Electron 官方 28.0.0 的 PR #41120 也曾主动从发行包里移除这两个文件。
// 删掉它们：装完后目录小 26MB，安装包小约 6.2MB（LZMA 压缩后实测）。
//
// 注意：这两个 DLL 不是 exe 的静态导入项（不在导入表里），只由 WebGPU 运行时按需动态加载，
// 所以删除不会导致程序启动失败。
'use strict';
const fs = require('fs');
const path = require('path');

// 仅在这些文件名存在时才删（不存在就静默跳过，绝不让打包失败）
const UNNEEDED_FILES = [
  'dxcompiler.dll', // WebGPU 的 DirectX 着色器编译器
  'dxil.dll'        // 上面那个的配套运行时
];

/** @param {import('electron-builder').AfterPackContext} context */
exports.default = async function afterPack(context) {
  // 只处理 Windows：macOS/Linux 没有这两个文件，也不适用
  if (context.electronPlatformName !== 'win32') return;

  const removed = [];
  for (const name of UNNEEDED_FILES) {
    const target = path.join(context.appOutDir, name);
    try {
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        removed.push(name);
      }
    } catch (err) {
      // 删除失败不阻断打包（比如被安全软件临时锁住）：如实打印，交给主人决定
      console.warn(`[afterPack] 删除 ${name} 失败（不影响打包）：`, err && err.message);
    }
  }
  if (removed.length > 0) {
    console.log(`[afterPack] 已移除无用的 WebGPU 着色器编译器：${removed.join(', ')}`);
  }
};
