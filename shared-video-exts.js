// 媒体扩展名单一事实来源（不带点）。
// 三层含义必须分清——这是"什么能播"的唯一事实来源：
//   video            内核（Chromium）原生就能播的视频容器
//   convertibleVideo 内核打不开、但交给 converter.js 转换后能播（见 docs/FORMAT-EXPANSION-REPORT.md）
//   audio            音频（内核原生可播；纯音频文件加载后 videoWidth/videoHeight 为 0，渲染进程据此切音乐模式）
//   all              = 三者之和 = "本软件能打开的全部媒体"，用于文件关联 / 打开对话框 / 拖拽过滤 / 路径白名单
// 结构：video / convertibleVideo / audio / all / nativeAll。
// 分发：main.js 直接 require 本模块；preload（沙箱无法 require 本地模块）与渲染进程
// 经 IPC app:getVideoExtensions 获取同一份数据。
// package.json 的 build.fileAssociations 为 electron-builder 独立配置，无法引用本模块，
// 一致性由 `node verify-exts.js` 自动对账。
const VIDEO = Object.freeze([
  // 视频：内核真能打开的容器（实测：Electron 34 / Chromium 132）
  'mp4', 'mkv', 'mov', 'webm', 'm4v', '3gp', 'ogv', 'f4v'
]);
const CONVERTIBLE_VIDEO = Object.freeze([
  // 视频：内核不收这些容器/编码，靠内置 ffmpeg 三档转换后播。
  // 这类文件一律走 converter.js：换容器（秒级）／换音频（秒级）／重编码（慢）。
  'avi', 'flv', 'wmv', 'ts', 'rmvb', 'rm', 'mpg', 'mpeg', 'm2ts', 'vob', 'm2v'
]);
const AUDIO = Object.freeze([
  // 音频
  'mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac'
]);
module.exports = Object.freeze({
  video: VIDEO,
  convertibleVideo: CONVERTIBLE_VIDEO,
  audio: AUDIO,
  all: Object.freeze([...VIDEO, ...CONVERTIBLE_VIDEO, ...AUDIO]),
  nativeAll: Object.freeze([...VIDEO, ...AUDIO])
});
