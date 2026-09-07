// 字幕扩展名单一事实来源（不带点）。与 shared-video-exts.js 同构：
// main.js 直接 require 本模块；渲染进程（沙箱无法 require）经 IPC app:getVideoExtensions
// 返回值的 subtitle 字段获取同一份数据。此前 4 处硬编码（主进程 2 处 + 渲染端 2 处）已统一至此。
module.exports = Object.freeze(['srt', 'vtt', 'ass', 'ssa']);
