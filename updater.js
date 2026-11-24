// 启动时静默检查 GitHub 最新 Release：只有确实存在新版本才弹窗打扰用户。
// 断网 / 被限流 / 解析异常一律只写日志，不影响播放，也不弹错误框。
// 不在构建产物里的 latest.yml 生态内，所以不依赖 electron-updater：直接读 Release、
// 下载对应安装包、启动安装器后退出。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const RELEASE_API = 'https://api.github.com/repos/HaiSeaman/BBPlayer/releases/latest';
const REQUEST_HEADERS = { 'User-Agent': 'BBPlayer', Accept: 'application/vnd.github+json' };

// 版本号按数字段比较（1.9.10 > 1.9.9）；忽略 v 前缀与 -beta 之类的后缀
function parseVersion(v) {
  return String(v || '').trim().replace(/^v/i, '').split(/[-+]/)[0]
    .split('.').map((n) => parseInt(n, 10) || 0);
}

function isNewer(remote, current) {
  const a = parseVersion(remote);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

// 便携版取免安装包（BBPlayer.1.9.2.exe），安装版取 Setup；取不到返回 null 由调用方兜底
function pickAsset(assets, portable) {
  const list = Array.isArray(assets) ? assets : [];
  const re = portable ? /^BBPlayer\.[\d.]+\.exe$/i : /Setup.*\.exe$/i;
  return list.find((a) => a && typeof a.name === 'string' && re.test(a.name) && a.browser_download_url) || null;
}

async function fetchLatestRelease() {
  const { net } = require('electron');
  // 超时保护：GitHub 不可达时不要一直挂着
  const res = await net.fetch(RELEASE_API, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  return res.json();
}

// 流式下载（安装包上百 MB，不能整包读进内存）；onProgress 收到 0~1，未知总大小时收到 -1。
// 超时保护：连接半开时 fetch 会一直挂着，进度条停在原地且整个流程永不返回。
// 30 分钟兜底（约 57KB/s 也能下完 100MB），只防死连接、不误伤慢速网络。
async function downloadFile(url, dest, onProgress) {
  const { net } = require('electron');
  const res = await net.fetch(url, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(30 * 60 * 1000)
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (onProgress) onProgress(total ? Math.min(1, received / total) : -1, received);
      cb(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest));
  if (total && received !== total) throw new Error('下载不完整');
  return received;
}

async function checkForUpdates(win) {
  try {
    const { app, dialog, shell } = require('electron');
    const current = app.getVersion();
    const release = await fetchLatestRelease();
    if (!release || !release.tag_name || !isNewer(release.tag_name, current)) return;

    const parent = win && !win.isDestroyed() ? win : undefined;
    const portableFile = process.env.PORTABLE_EXECUTABLE_FILE;
    const { response } = await dialog.showMessageBox(parent, {
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 ${release.tag_name}`,
      detail: `当前版本：${current}\n最新版本：${release.tag_name}\n\n` + (portableFile
        ? '当前是便携版：新版会下载到软件所在文件夹并直接启动，旧文件可以自行删除。'
        : '点击“确定更新”将自动下载安装包并启动安装程序。'),
      buttons: ['确定更新', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (response !== 0) return;

    const asset = pickAsset(release.assets, !!portableFile);
    if (!asset) {
      // 发布方式变了（找不到对应安装包）时退回发布页，至少让用户能自己下载
      shell.openExternal(release.html_url);
      return;
    }

    // 便携版没法在运行时替换自身：下载到旧文件旁边（临时目录里的文件用户根本找不到），
    // 启动后用户看到的就是新版，旧文件自行删除即可。安装版交给 Setup 装回原位置。
    // asset.name 来自网络，取 basename 防止被构造成 ../ 之类的路径
    const dest = path.join(portableFile ? path.dirname(portableFile) : app.getPath('temp'),
      path.basename(asset.name));
    const setProgress = (v) => { if (win && !win.isDestroyed()) win.setProgressBar(v); };
    try {
      setProgress(2); // 先显示不确定进度（总大小要等响应头才知道）
      const received = await downloadFile(asset.browser_download_url, dest, (p) => setProgress(p > 0 ? p : 2));
      // 发布信息里有大小就核对一次，防止代理/断流写出一个能启动但残缺的安装包
      if (asset.size && received !== asset.size) throw new Error('安装包大小与发布信息不一致');
    } catch (e) {
      setProgress(-1);
      try { fs.unlinkSync(dest); } catch (_) { /* 清理残留失败可忽略 */ }
      dialog.showErrorBox('更新下载失败',
        `安装包下载失败：${e.message}\n\n可手动前往 ${release.html_url} 下载最新版本。`);
      return;
    }
    setProgress(-1);

    // 便携版：不能靠 spawn 直接起新 exe —— 新进程会撞上本进程刚持有的单实例锁，
    // 立刻自杀，表现为"更新完毫无反应"。relaunch 会在本进程退出后才启动新版本。
    if (portableFile) {
      app.relaunch({ execPath: dest, args: [] });
      app.quit();
      return;
    }

    // 安装版：启动 Setup 后再退出，安装器才能替换正在占用的文件。
    // 启动失败（被杀软拦截/文件损坏）时必须留在软件里报错，不能把用户"退出又没装上"。
    // 注意：Windows 上 spawn 无效 exe 会**同步抛错**，异步 error 事件只覆盖部分场景，两者都要接。
    const fail = (e) => dialog.showErrorBox('无法启动安装程序',
      `${e.message}\n\n安装包已下载到：${dest}`);
    let child;
    try {
      child = spawn(dest, [], { detached: true, stdio: 'ignore' });
    } catch (e) {
      fail(e);
      return;
    }
    child.once('error', fail);
    child.once('spawn', () => app.quit());
    child.unref();
  } catch (e) {
    // 检查更新只算锦上添花，任何失败都静默跳过
    console.warn('[BBPlayer] 检查更新失败（已忽略）:', e && e.message);
  }
}

module.exports = { checkForUpdates, isNewer, pickAsset };
