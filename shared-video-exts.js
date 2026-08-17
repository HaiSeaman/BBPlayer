// 视频扩展名单一来源（不带点），主进程 main.js 使用。
// 注意：preload.js 因沙箱限制改为内联同一列表（见其文件头注释），修改时三处同步：
// 本文件、preload.js、package.json 的 build.fileAssociations。
module.exports = Object.freeze([
  'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'ts',
  'rmvb', 'rm', '3gp', 'mpg', 'mpeg', 'm2ts', 'vob', 'ogv', 'f4v', 'm2v'
]);
