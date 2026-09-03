// 媒体扩展名单一事实来源（不带点）。
// 同时支持视频与音频：音频格式（mp3/flac/wav/ogg/m4a/aac）由 Chromium 原生解码，
// 纯音频文件加载后 videoWidth/videoHeight 为 0，渲染进程据此切换音乐播放效果模式。
// 结构：video（视频）/ audio（音频）/ all（两者合并）。
// 分发：main.js 直接 require 本模块；preload（沙箱无法 require 本地模块）与渲染进程
// 经 IPC app:getVideoExtensions 获取同一份数据。
// package.json 的 build.fileAssociations 为 electron-builder 独立配置，无法引用本模块，
// 一致性由 `node verify-exts.js` 自动对账。
const VIDEO = Object.freeze([
  // 视频
  'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'ts',
  'rmvb', 'rm', '3gp', 'mpg', 'mpeg', 'm2ts', 'vob', 'ogv', 'f4v', 'm2v'
]);
const AUDIO = Object.freeze([
  // 音频
  'mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac'
]);
module.exports = Object.freeze({
  video: VIDEO,
  audio: AUDIO,
  all: Object.freeze([...VIDEO, ...AUDIO])
});
