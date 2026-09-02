// 媒体扩展名单一来源（不带点），主进程 main.js 使用。
// 同时支持视频与音频：音频格式（mp3/flac/wav/ogg/m4a/aac）由 Chromium 原生解码，
// 纯音频文件加载后 videoWidth/videoHeight 为 0，渲染进程据此切换音乐播放效果模式。
// 注意：preload.js 因沙箱限制改为内联同一列表（见其文件头注释），修改时三处同步：
// 本文件、preload.js、package.json 的 build.fileAssociations。
module.exports = Object.freeze([
  // 视频
  'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'ts',
  'rmvb', 'rm', '3gp', 'mpg', 'mpeg', 'm2ts', 'vob', 'ogv', 'f4v', 'm2v',
  // 音频
  'mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac'
]);
