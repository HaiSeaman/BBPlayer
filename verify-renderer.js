// renderer.js 无界面自检（零依赖，与 verify-exts.js / verify-converter.js 同风格）
// 用法：node verify-renderer.js
//
// 为什么要有它：renderer.js 是 index.html 底部**同步执行的经典脚本**，2500+ 行、
// 单文件策略，没有任何模块化边界可以单独 require 进来测。一旦顶层脚本求值时抛错
// （例如本项目踩过的暂时性死区 TDZ），整块界面逻辑静默失效，而"打开软件看一眼"
// 这种人工验证既不可靠也没法回归。
//
// 做法：用 Node 的 vm 模块 + 一套 DOM/Electron 桩，**真实执行 renderer.js 的顶层脚本**
// 与后续事件回调，再用断言检查行为。测的是真代码，不是复制出来的副本。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

let passed = 0;
const failures = [];
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log('[通过] ' + name);
  } catch (e) {
    failures.push({ name, err: e });
    console.log('[失败] ' + name + '\n        ' + (e && e.message));
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('[通过] ' + name);
  } catch (e) {
    failures.push({ name, err: e });
    console.log('[失败] ' + name + '\n        ' + (e && e.message));
  }
}

const ROOT = __dirname;
const RENDERER_SRC = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');

// ============ DOM / Electron 桩 ============

// 一个最小可用的元素桩：支持 classList / dataset / style / 事件 / 子元素查询
function makeElement(tag = 'div', id = '') {
  const el = {
    tagName: String(tag).toUpperCase(),
    id,
    children: [],
    parentNode: null,
    dataset: {},
    _classes: new Set(),
    _attrs: {},
    _listeners: {},
    style: {
      _props: {},
      setProperty(k, v) { this._props[k] = v; },
      removeProperty(k) { delete this._props[k]; },
      getPropertyValue(k) { return this._props[k]; }
    },
    _text: '',
    title: '',
    value: '',
    src: '',
    width: 0,
    height: 0,
    clientWidth: 1280,
    clientHeight: 720,
    offsetWidth: 1280,
    offsetHeight: 720,
    // 事件
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = this._listeners[type];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatch(type, ev) {
      const arr = (this._listeners[type] || []).slice();
      const event = Object.assign({
        type,
        target: this,
        preventDefault() {},
        stopPropagation() {},
        clientX: 0, clientY: 0, buttons: 0,
        ctrlKey: false, altKey: false, metaKey: false, shiftKey: false
      }, ev || {});
      for (const fn of arr) fn(event);
      return event;
    },
    // 选择器：只支持本桩用得到的几种形式
    querySelector(sel) { return queryIn(this, sel); },
    querySelectorAll(sel) { return queryAllIn(this, sel); },
    closest(sel) {
      let node = this;
      while (node) {
        if (matches(node, sel)) return node;
        node = node.parentNode;
      }
      return null;
    },
    contains(other) {
      let node = other;
      while (node) {
        if (node === this) return true;
        node = node.parentNode;
      }
      return false;
    },
    appendChild(child) {
      // 语义对齐真实浏览器：DocumentFragment 被挂载时是其子节点平铺进容器（renderPlaylist 依赖）
      if (child && child.tagName === 'FRAGMENT') {
        for (const c of [...child.children]) this.appendChild(c);
        child.children.length = 0;
        return child;
      }
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight };
    },
    getContext() { return makeCanvasCtx(); },
    toBlob(cb) { cb({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }); },
    focus() {},
    click() { this.dispatch('click'); },
    matches(sel) { return matches(this, sel); },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    // innerHTML 语义对齐真实浏览器：任何赋值都替换全部子节点（空列表占位 div / 全量重建都依赖）
    get innerHTML() { return this._innerHTML || ''; },
    set innerHTML(v) {
      this._innerHTML = String(v);
      this.children.length = 0;
      if (this._innerHTML) {
        // 非空 innerHTML：合成一个占位子节点，保持 children 数量语义
        const ph = makeElement('span', '');
        ph._text = this._innerHTML;
        this.children.push(ph);
      }
    },
    set className(v) {
      this._classes = new Set(String(v).split(/\s+/).filter(Boolean));
    },
    get className() { return [...this._classes].join(' '); }
  };
  el.classList = {
    add: (...cs) => cs.forEach(c => el._classes.add(c)),
    remove: (...cs) => cs.forEach(c => el._classes.delete(c)),
    toggle: (c, force) => {
      const want = force === undefined ? !el._classes.has(c) : !!force;
      if (want) el._classes.add(c); else el._classes.delete(c);
      return want;
    },
    contains: (c) => el._classes.has(c)
  };
  return el;
}

function matches(el, sel) {
  if (!el || !sel) return false;
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('.')) return el._classes.has(sel.slice(1));
  return el.tagName === sel.toUpperCase();
}

// 支持 '#id'、'.class'、'tag'，以及逗号分隔的多选择器
function queryAllIn(root, sel) {
  const parts = String(sel).split(',').map(s => s.trim()).filter(Boolean);
  const out = [];
  const walk = (node) => {
    for (const c of node.children) {
      if (parts.some(p => matches(c, p))) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}
function queryIn(root, sel) { return queryAllIn(root, sel)[0] || null; }

function makeCanvasCtx() {
  return {
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    clearRect() {}, fillRect() {}, drawImage() {},
    beginPath() {}, fill() {}, roundRect() {},
    createLinearGradient() { return { addColorStop() {} }; },
    getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4).fill(128) }; },
    fillStyle: '', globalAlpha: 1
  };
}

// video 元素：renderer.js 大量依赖它的属性与事件
function makeVideoElement() {
  const el = makeElement('video', 'main-video');
  const state = {
    paused: true, ended: false, currentTime: 0, duration: 0,
    videoWidth: 0, videoHeight: 0, playbackRate: 1, volume: 1,
    webkitAudioDecodedByteCount: 0
  };
  Object.defineProperties(el, {
    paused: { get: () => state.paused, set: v => { state.paused = v; } },
    ended: { get: () => state.ended, set: v => { state.ended = v; } },
    currentTime: { get: () => state.currentTime, set: v => { state.currentTime = v; } },
    duration: { get: () => state.duration, set: v => { state.duration = v; } },
    videoWidth: { get: () => state.videoWidth, set: v => { state.videoWidth = v; } },
    videoHeight: { get: () => state.videoHeight, set: v => { state.videoHeight = v; } },
    playbackRate: { get: () => state.playbackRate, set: v => { state.playbackRate = v; } },
    volume: { get: () => state.volume, set: v => { state.volume = v; } },
    webkitAudioDecodedByteCount: { get: () => state.webkitAudioDecodedByteCount, set: v => { state.webkitAudioDecodedByteCount = v; } }
  });
  el.play = () => { state.paused = false; el.dispatch('play'); return Promise.resolve(); };
  el.pause = () => { state.paused = true; el.dispatch('pause'); };
  el.load = () => {};
  el._state = state;
  return el;
}

// ============ 构建执行环境 ============

function buildEnv(opts = {}) {
  const elements = new Map();
  const byId = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement('div', id));
    return elements.get(id);
  };

  const documentElement = makeElement('html');
  const body = makeElement('body');

  const document = {
    documentElement,
    body,
    _listeners: {},
    getElementById: (id) => (id === 'main-video' ? videoEl : byId(id)),
    createElement: (tag) => (tag === 'video' ? makeVideoElement() : makeElement(tag)),
    createDocumentFragment: () => makeElement('fragment'),
    querySelector: (sel) => {
      if (sel === '#main-video') return videoEl;
      if (sel.startsWith('#')) return byId(sel.slice(1));
      return queryIn(body, sel);
    },
    querySelectorAll: (sel) => (sel.startsWith('#') ? [byId(sel.slice(1))].filter(Boolean) : queryAllIn(body, sel)),
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const arr = this._listeners[type];
      if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
    },
    dispatch(type, ev) {
      for (const fn of (this._listeners[type] || []).slice()) fn(Object.assign({ type, target: body, preventDefault() {}, stopPropagation() {} }, ev || {}));
    }
  };

  const videoEl = makeVideoElement();

  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
    clear: () => storage.clear(),
    _dump: () => Object.fromEntries(storage)
  };

  // IPC 记录器：测试据此断言 renderer 究竟请求了什么
  const ipcCalls = [];
  const ipcHandlers = {
    // 与 shared-video-exts.js / shared-subtitle-exts.js 保持一致
    getVideoExtensions: () => Promise.resolve(opts.extensions || {
      video: ['mp4', 'mkv', 'mov', 'webm', 'm4v', '3gp', 'ogv', 'f4v'],
      convertibleVideo: ['avi', 'flv', 'wmv', 'ts', 'rmvb', 'rm', 'mpg', 'mpeg', 'm2ts', 'vob', 'm2v'],
      audio: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac'],
      all: ['mp4', 'mkv', 'mov', 'webm', 'm4v', '3gp', 'ogv', 'f4v', 'avi', 'flv', 'wmv', 'ts', 'rmvb', 'rm', 'mpg', 'mpeg', 'm2ts', 'vob', 'm2v', 'mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac'],
      subtitle: ['srt', 'vtt', 'ass', 'ssa']
    }),
    prepareMedia: (p, f) => { ipcCalls.push(['prepareMedia', p, f]); return Promise.resolve(opts.prepareMedia ? opts.prepareMedia(p, f) : 'file:///D:/v/a.mp4'); },
    probeMedia: (p) => { ipcCalls.push(['probeMedia', p]); return Promise.resolve(opts.probeMedia ? opts.probeMedia(p) : null); },
    findCover: (p) => { ipcCalls.push(['findCover', p]); return Promise.resolve(null); },
    readTextFile: (p) => { ipcCalls.push(['readTextFile', p]); return Promise.resolve(opts.readTextFile ? opts.readTextFile(p) : null); },
    decodeSubtitleBuffer: (b) => { ipcCalls.push(['decodeSubtitleBuffer']); return Promise.resolve(opts.decodeSubtitleBuffer ? opts.decodeSubtitleBuffer(b) : ''); },
    openFileDialog: () => Promise.resolve(opts.openFileDialog ? opts.openFileDialog() : null),
    openSubtitleDialog: () => { ipcCalls.push(['openSubtitleDialog']); return Promise.resolve(opts.openSubtitleDialog ? opts.openSubtitleDialog() : null); },
    openFolderDialog: () => Promise.resolve(opts.openFolderDialog ? opts.openFolderDialog() : null),
    saveScreenshot: () => Promise.resolve(true),
    isFullScreen: () => Promise.resolve(false),
    resizeToVideo: () => Promise.resolve(true),
    minimizeWindow() {}, maximizeWindow() {}, closeWindow() {}, fullscreenWindow() {},
    openInNewWindow: (p) => { ipcCalls.push(['openInNewWindow', p]); },
    moveWindow() {},
    getFilePath: (f) => (opts.getFilePath ? opts.getFilePath(f) : (f && f._path) || ''),
    onOpenFile: (cb) => { subscribers.openFile = cb; },
    onConvertProgress: (cb) => { subscribers.convertProgress = cb; },
    onConvertFailed: (cb) => { subscribers.convertFailed = cb; },
    onWindowMinimized: (cb) => { subscribers.windowMinimized = cb; },
    onWindowRestored: (cb) => { subscribers.windowRestored = cb; }
  };
  const subscribers = {};

  const electronAPI = new Proxy({}, {
    get(_, prop) {
      if (prop in ipcHandlers) return ipcHandlers[prop];
      return () => Promise.resolve(null);
    }
  });

  const timers = { timeouts: new Map(), intervals: new Map(), nextId: 1 };
  const windowListeners = {};
  let rafId = 1;

  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    document,
    localStorage,
    setTimeout: (fn, ms) => { const id = timers.nextId++; timers.timeouts.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.timeouts.delete(id); },
    setInterval: (fn, ms) => { const id = timers.nextId++; timers.intervals.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { timers.intervals.delete(id); },
    requestAnimationFrame: (fn) => { const id = rafId++; Promise.resolve().then(() => fn()); return id; },
    cancelAnimationFrame: () => {},
    requestIdleCallback: (fn) => { Promise.resolve().then(() => fn({ timeRemaining: () => 10 })); return rafId++; },
    cancelIdleCallback: () => {},
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL() {} },
    Blob: class Blob { constructor(parts, o) { this.parts = parts; this.type = o && o.type; } },
    File: class File {
      constructor(parts, name) { this.name = name; this.size = 1; this.type = ''; this._parts = parts; }
      arrayBuffer() { return Promise.resolve(new ArrayBuffer(4)); }
    },
    TextDecoder: require('util').TextDecoder,
    Uint8Array, Uint8ClampedArray, ArrayBuffer, Set, Map, Promise, Math, Date, JSON, Number, String, Boolean, Object, Array, Error, parseInt, parseFloat, isFinite, isNaN,
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 720,
    screenX: 0,
    screenY: 0,
    AudioContext: undefined, // 默认不给 Web Audio：验证降级路径
    addEventListener(type, fn) { (windowListeners[type] = windowListeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const arr = windowListeners[type];
      if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
    },
    _windowListeners: windowListeners,
    _dispatch(type, ev) {
      for (const fn of (windowListeners[type] || []).slice()) fn(Object.assign({ type, target: body, preventDefault() {}, stopPropagation() {} }, ev || {}));
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.electronAPI = electronAPI;
  sandbox.window.electronAPI = electronAPI;

  return { sandbox, elements, byId, videoEl, ipcCalls, subscribers, timers, storage, windowListeners, document };
}

// 执行 renderer.js 顶层脚本，返回环境
function loadRenderer(opts = {}) {
  const env = buildEnv(opts);
  const context = vm.createContext(env.sandbox);
  env.context = context;
  try {
    vm.runInContext(RENDERER_SRC, context, { filename: 'renderer.js' });
  } catch (e) {
    env.topLevelError = e;
  }
  return env;
}

// 读取 renderer.js 顶层 let/const 变量的当前值（vm 的全局词法作用域访问方式）
function readVar(env, name) {
  return vm.runInContext(name, env.context);
}
function callFn(env, expr) {
  return vm.runInContext(expr, env.context);
}
// 执行到期的 setTimeout 回调（桩里的定时器不会自己跑，测试据此驱动异步分支）
function runTimers(env, maxDelay = Infinity) {
  let ran = 0;
  const entries = [...env.timers.timeouts.entries()].sort((a, b) => a[1].ms - b[1].ms);
  for (const [id, t] of entries) {
    if (t.ms <= maxDelay) {
      env.timers.timeouts.delete(id);
      t.fn();
      ran++;
    }
  }
  return ran;
}
function hasTimer(env, ms) {
  for (const t of env.timers.timeouts.values()) if (t.ms === ms) return true;
  return false;
}
function dispatchWindow(env, type, ev) {
  for (const fn of (env.windowListeners[type] || []).slice()) {
    fn(Object.assign({ type, target: env.sandbox.document.body, preventDefault() {}, stopPropagation() {} }, ev || {}));
  }
}

// ============ 第一组：顶层脚本必须无错执行（TDZ / ReferenceError 门禁） ============

console.log('=== renderer.js 顶层脚本执行 ===');

const bootEnv = loadRenderer();
ok('顶层脚本求值全程无异常（挡住暂时性死区 TDZ 这类静默失效）', () => {
  if (bootEnv.topLevelError) {
    throw new Error(`${bootEnv.topLevelError.constructor.name}: ${bootEnv.topLevelError.message}`);
  }
});

// restoreSettings 是最容易踩 TDZ 的地方：它在脚本求值阶段同步执行，
// 一旦它抛错就被自身 try/catch 吞掉，导致其后所有设置恢复静默失效。
ok('设置恢复链路真的跑完了（音量/倍速/字号都从存档恢复，而不是中途抛错中断）', () => {
  const storage = new Map();
  storage.set('bb_player_settings', JSON.stringify({
    volume: 1.5, speed: 1.25, subtitleOffset: 2, subtitleFontSize: 30,
    subtitleVisible: false, playMode: 'random', appearance: 'light'
  }));
  const env = buildEnv();
  env.sandbox.localStorage.getItem = (k) => (storage.has(k) ? storage.get(k) : null);
  const context = vm.createContext(env.sandbox);
  let err = null;
  try { vm.runInContext(RENDERER_SRC, context, { filename: 'renderer.js' }); } catch (e) { err = e; }
  if (err) throw new Error('顶层执行抛错: ' + err.message);

  // 逐个断言"恢复点之后"的状态，任一处中断都会被这条抓住
  assert.strictEqual(vm.runInContext('masterVolume', context), 1.5, '音量未恢复（恢复链路后半段被异常中断）');
  assert.strictEqual(vm.runInContext('currentSpeed', context), 1.25, '倍速未恢复');
  assert.strictEqual(vm.runInContext('subtitleOffset', context), 2, '字幕偏移未恢复');
  assert.strictEqual(vm.runInContext('currentSubtitleFontSize', context), 30, '字幕字号未恢复');
  assert.strictEqual(vm.runInContext('isSubtitleVisible', context), false, '字幕显隐未恢复');
  assert.strictEqual(vm.runInContext('playMode', context), 'random', '播放模式未恢复');
  assert.strictEqual(env.sandbox.document.documentElement.dataset.theme, 'light', '外观主题未恢复');
  // 菜单文案同步（位于 applyMasterVolume 之后，最能说明"整条链路跑完"）
  assert.strictEqual(env.byId('btn-toggle-sub').textContent, '显示字幕', '字幕开关文案未同步');
  assert.strictEqual(env.byId('btn-speed').textContent, '1.25x', '倍速按钮文案未同步');
});

ok('存档数据损坏时不会抛错，且非法值被钳制回安全范围', () => {
  const storage = new Map();
  storage.set('bb_player_settings', JSON.stringify({ volume: 999, speed: -5, subtitleFontSize: 9999, subtitleOffset: 9999 }));
  const env = buildEnv();
  env.sandbox.localStorage.getItem = (k) => (storage.has(k) ? storage.get(k) : null);
  const context = vm.createContext(env.sandbox);
  vm.runInContext(RENDERER_SRC, context, { filename: 'renderer.js' });
  assert.strictEqual(vm.runInContext('masterVolume', context), 2, '音量上限应钳到 2');
  assert.strictEqual(vm.runInContext('currentSpeed', context), 1, '非法倍速应保持默认 1');
  assert.strictEqual(vm.runInContext('currentSubtitleFontSize', context), 48, '字号上限应钳到 48');
  assert.strictEqual(vm.runInContext('subtitleOffset', context), 60, '偏移上限应钳到 60');
});

// ============ 第二组：纯逻辑函数 ============

console.log('\n=== 纯逻辑 ===');

ok('formatTime：Infinity / NaN / 负数都兜底，不产生 "Infinity:NaN:NaN"', () => {
  const f = callFn(bootEnv, 'formatTime');
  assert.strictEqual(f(Infinity), '00:00');
  assert.strictEqual(f(NaN), '00:00');
  assert.strictEqual(f(-5), '00:00');
  assert.strictEqual(f(0), '00:00');
  assert.strictEqual(f(65), '01:05');
  assert.strictEqual(f(3661), '01:01:01');
});

ok('formatSpeed：1.25x 不被四舍五入成 1.3x', () => {
  const f = callFn(bootEnv, 'formatSpeed');
  assert.strictEqual(f(1), '1.0x');
  assert.strictEqual(f(1.25), '1.25x');
  assert.strictEqual(f(0.5), '0.5x');
  assert.strictEqual(f(3), '3.0x');
});

ok('parseSubtitleTime：常见与畸形时间轴都能解析或明确判废', () => {
  const f = callFn(bootEnv, 'parseSubtitleTime');
  assert.strictEqual(f('00:00:01,500'), 1.5);
  assert.strictEqual(f('00:00:01.500'), 1.5);
  assert.strictEqual(f('01:02:03'), 3723);
  assert.strictEqual(f('01:30'), 90, 'mm:ss 应补齐为 0:01:30');
  assert.strictEqual(f('00:00:05.5'), 5.5, '毫秒不足三位应右侧补零');
  assert.ok(Number.isNaN(f('')), '空串应判废');
  assert.ok(Number.isNaN(f('abc')), '非数字应判废');
  assert.ok(Number.isNaN(f('00:xx:01,000')), '分钟非数字应判废');
  // VTT 时间轴常带位置参数，取第一段
  assert.strictEqual(f('00:00:02.000 align:start position:0%'), 2);
});

ok('stripInlineTags：剥离 SRT/VTT 内联标签，但不误伤正文比较符号', () => {
  const f = callFn(bootEnv, 'stripInlineTags');
  assert.strictEqual(f('<i>斜体</i>'), '斜体');
  assert.strictEqual(f('<font color="#fff">彩色</font>'), '彩色');
  assert.strictEqual(f('a < b 且 c > d'), 'a < b 且 c > d', '数学比较符号必须保留');
});

ok('stripAssTags：剥离 ASS 覆盖标签并把 \\N 换成换行', () => {
  const f = callFn(bootEnv, 'stripAssTags');
  assert.strictEqual(f('{\\pos(1,2)}你好'), '你好');
  assert.strictEqual(f('第一行\\N第二行'), '第一行\n第二行');
});

ok('randomIndexExcluding：列表只有 1 项时返回 0，不会返回 undefined', () => {
  const env = loadRenderer();
  vm.runInContext('playlist = [{key:"a",name:"a",target:"a"}]', env.context);
  assert.strictEqual(callFn(env, 'randomIndexExcluding(0)'), 0);
  vm.runInContext('playlist = [{key:"a"},{key:"b"},{key:"c"}]', env.context);
  for (let i = 0; i < 30; i++) {
    const r = callFn(env, 'randomIndexExcluding(1)');
    assert.ok(r === 0 || r === 2, '随机结果必须排除传入的索引，实际得到 ' + r);
  }
});

ok('findActiveSubtitle：二分命中与重叠时间轴向前回扫', () => {
  const env = loadRenderer();
  vm.runInContext(`
    currentSubtitleData = [
      { start: 0, end: 10, text: '长字幕跨全段' },
      { start: 1, end: 2, text: 'A' },
      { start: 3, end: 4, text: 'B' },
      { start: 20, end: 21, text: 'C' }
    ];
  `, env.context);
  const find = callFn(env, 'findActiveSubtitle');
  // 重叠场景：起点回扫必须能找到那条"长字幕"
  assert.strictEqual(find(1.5).text, 'A', '短字幕应优先命中（回扫取最近起点）');
  assert.strictEqual(find(3.5).text, 'B');
  assert.strictEqual(find(5).text, '长字幕跨全段', '只有长字幕覆盖该时刻时必须回扫命中');
  assert.strictEqual(find(20.5).text, 'C');
  assert.strictEqual(find(100), null, '无字幕覆盖时应返回 null');
});

// 注：isAudioExt 依赖经 IPC 异步下发的扩展名清单，必须等它落地后才能测（见下方异步段）

ok('canOpenInNewWindow：只认盘符与 UNC 路径', () => {
  const f = callFn(bootEnv, 'canOpenInNewWindow');
  assert.strictEqual(f('D:\\v\\a.mp4'), true);
  assert.strictEqual(f('\\\\nas\\share\\a.mp4'), true);
  assert.strictEqual(f('a.mp4'), false, '相对路径不能在新窗口打开');
  assert.strictEqual(f(''), false);
});

// ============ 第三组：字幕加载（manualSubtitleFor 拦截） ============

console.log('\n=== 字幕加载 ===');

const SUB_SRT = '1\n00:00:01,000 --> 00:00:03,000\n第一句\n\n2\n00:00:04,000 --> 00:00:06,000\n第二句\n';

// 等到扩展名清单（IPC 异步下发）真的落地，否则概率性地测到空清单
async function waitForExtensions(env) {
  for (let i = 0; i < 50; i++) {
    const list = readVar(env, 'mediaExtensions');
    if (list && Array.isArray(list.audio) && list.audio.length > 0 && Array.isArray(list.subtitle) && list.subtitle.length > 0) return list;
    await new Promise(r => setTimeout(r, 2));
  }
  throw new Error('扩展名清单未下发（桩环境异常），无法继续');
}

async function audioExtTest() {
  const env = loadRenderer();
  await waitForExtensions(env);
  ok('isAudioExt / mediaExtOf：音频扩展名判断不受路径中的点干扰', () => {
    const isAudio = callFn(env, 'isAudioExt');
    assert.strictEqual(isAudio('D:\\music\\song.mp3'), true);
    assert.strictEqual(isAudio('D:\\music\\song.MP3'), true, '大写扩展名也要认出');
    assert.strictEqual(isAudio('D:\\v\\clip.mp4'), false);
    assert.strictEqual(isAudio(''), false);
    assert.strictEqual(isAudio(null), false);
    const extOf = callFn(env, 'mediaExtOf');
    assert.strictEqual(extOf('D:\\a.b\\movie'), '', '目录名含点不算扩展名');
    assert.strictEqual(extOf('D:\\a\\movie.MKV'), 'mkv');
  });
}

async function subtitleTest() {
  // 场景：先拖入一个字幕（manualSubtitleFor 被设为当前视频），
  // 再从菜单里手动选择另一个字幕文件 —— 用户主动操作必须生效。
  const env = loadRenderer({
    readTextFile: () => SUB_SRT,
    openSubtitleDialog: () => 'D:\\v\\another.srt'
  });
  await waitForExtensions(env);

  // 建立"当前正在播放的视频"
  vm.runInContext(`
    currentFilePath = 'D:\\\\v\\\\movie.mp4';
    hasRealPath = true;
    isVideoLoaded = true;
  `, env.context);
  // 模拟"用户拖入过字幕"：manualSubtitleFor 已指向当前视频
  vm.runInContext(`manualSubtitleFor = currentFilePath;`, env.context);

  // 走菜单加载路径
  env.byId('btn-load-sub').dispatch('click');
  await new Promise(r => setTimeout(r, 30));

  const data = readVar(env, 'currentSubtitleData');
  assert.ok(Array.isArray(data) && data.length === 2,
    '菜单里手动选择的字幕必须能被加载（实际加载到 ' + (data ? data.length : 0) + ' 条）—— ' +
    '被 manualSubtitleFor 的"同名字幕自动加载"拦截误伤了');

  // 反面：该标记仍然要保护"手动配好的字幕不被同名字幕自动加载顶掉"
  const env2 = loadRenderer({ readTextFile: () => SUB_SRT });
  await waitForExtensions(env2);
  vm.runInContext(`
    currentFilePath = 'D:\\\\v\\\\movie.mp4';
    hasRealPath = true;
    isVideoLoaded = true;
    manualSubtitleFor = currentFilePath;
  `, env2.context);
  await callFn(env2, 'checkAndAutoLoadSubtitles')('D:\\v\\movie');
  assert.strictEqual(readVar(env2, 'currentSubtitleData').length, 0,
    '手动配过字幕的视频，同名字幕自动加载必须让位（手动优先契约）');

  return env;
}

// ============ 第四组：播放列表与失败熔断 ============

console.log('\n=== 播放列表 ===');

async function playlistTest() {
  const env = loadRenderer({ prepareMedia: () => 'file:///D:/v/a.mp4' });
  await new Promise(r => setTimeout(r, 10));

  ok('addFilesToPlaylist：同批次重复与跨批次重复都被去重', () => {
    vm.runInContext('playlist = []; currentPlaylistIndex = -1; isVideoLoaded = false;', env.context);
    const add = callFn(env, 'addFilesToPlaylist');
    assert.strictEqual(add(['D:\\v\\a.mp4', 'D:\\v\\a.mp4', 'D:\\v\\b.mp4']), 2, '同一批次内的重复必须拦掉');
    assert.strictEqual(add(['D:\\v\\a.mp4']), 0, '已在列表中的必须拦掉');
    assert.strictEqual(readVar(env, 'playlist').length, 2);
  });

  ok('removePlaylistItem：删除当前项之前的条目后，当前索引正确左移', () => {
    vm.runInContext(`
      playlist = [{key:'a',name:'a',target:'a'},{key:'b',name:'b',target:'b'},{key:'c',name:'c',target:'c'}];
      currentPlaylistIndex = 2;
    `, env.context);
    callFn(env, 'removePlaylistItem')(0);
    assert.strictEqual(readVar(env, 'currentPlaylistIndex'), 1, '删掉前面的条目后，当前索引必须减 1，否则高亮会指错条目');
    assert.strictEqual(readVar(env, 'playlist').length, 2);
    assert.strictEqual(callFn(env, 'playlistItemsContainer.children.length'), 2,
      '删除条目后 DOM 必须同步缩到 2 条（增量渲染改造后删除走全量重建路径）');
  });

  ok('removePlaylistItem：删掉最后一条后进入空状态，不残留索引', () => {
    vm.runInContext(`
      playlist = [{key:'a',name:'a',target:'a'}];
      currentPlaylistIndex = 0;
    `, env.context);
    callFn(env, 'removePlaylistItem')(0);
    assert.strictEqual(readVar(env, 'playlist').length, 0);
    assert.strictEqual(readVar(env, 'currentPlaylistIndex'), -1, '列表空了索引必须复位为 -1');
  });

  ok('removePlaylistItem：删除失败过的条目会解除拉黑，重新添加可正常播放', () => {
    vm.runInContext(`
      playlist = [{key:'a',name:'a',target:'a'},{key:'b',name:'b',target:'b'}];
      currentPlaylistIndex = 0;
      failedPlaylistKeys.clear(); failedPlaylistKeys.add('b');
    `, env.context);
    callFn(env, 'removePlaylistItem')(1);
    assert.strictEqual(readVar(env, 'failedPlaylistKeys').has('b'), false, '删掉的条目必须解除失败标记');
  });

  ok('均衡器暂停指示只标在当前条目上（不把整个列表容器标成暂停）', () => {
    // 造一个真实的两条列表 DOM
    const container = env.byId('playlist-items');
    container.children.length = 0;
    const mk = (active) => {
      const el = makeElement('div', '');
      el._classes.add('playlist-item');
      if (active) el._classes.add('active');
      container.appendChild(el);
      return el;
    };
    const first = mk(true);
    const second = mk(false);
    vm.runInContext(`
      playlist = [{key:'a',name:'a',target:'a'},{key:'b',name:'b',target:'b'}];
      currentPlaylistIndex = 0;
    `, env.context);

    env.videoEl._state.paused = true;
    callFn(env, 'syncPlaylistPauseIndicator')();
    assert.strictEqual(container.classList.contains('is-paused'), false,
      'is-paused 不能挂在列表容器上——那会让全列表每条（500 条=1500 个元素）的动画样式全部重算');
    assert.strictEqual(first.classList.contains('is-paused'), true, '暂停时当前条目应标记暂停');
    assert.strictEqual(second.classList.contains('is-paused'), false, '非当前条目不该带暂停标记');

    env.videoEl._state.paused = false;
    callFn(env, 'syncPlaylistPauseIndicator')();
    assert.strictEqual(first.classList.contains('is-paused'), false, '播放中当前条目应恢复跳动');
  });

  ok('syncPlaylistPauseIndicator：列表重建后暂停状态能重新挂上（新条目不能丢标记）', () => {
    // 模拟"暂停状态下切换了条目"：新 active 条目上必须重新出现暂停标记
    const container = env.byId('playlist-items');
    container.children.length = 0;
    const a = makeElement('div', ''); a._classes.add('playlist-item');
    const b = makeElement('div', ''); b._classes.add('playlist-item'); b._classes.add('active');
    container.appendChild(a); container.appendChild(b);
    env.videoEl._state.paused = true;
    callFn(env, 'syncPlaylistPauseIndicator')();
    assert.strictEqual(b.classList.contains('is-paused'), true, '重建/切换后新条目必须带上暂停标记，否则暂停时均衡器仍在空转');
    assert.strictEqual(a.classList.contains('is-paused'), false, '旧条目必须清掉标记');
  });

  ok('skipPlaylist：未播放任何条目时按"上一个"不会跳到错误的条目', () => {
    vm.runInContext(`
      playlist = [{key:'a',name:'a',target:'a'},{key:'b',name:'b',target:'b'}];
      currentPlaylistIndex = -1;
      playMode = 'list-loop';
    `, env.context);
    let called = -1;
    vm.runInContext('_testPlayHook = (i) => { _testPlayedIndex = i; };', env.context);
    // 用真实函数跑：playPlaylistItem 会调用 loadAndPlayVideo（异步），这里只检查索引参数
    vm.runInContext(`
      _testPlayedIndex = null;
      loadAndPlayVideo = async (t) => { _testPlayedIndex = t; };
    `, env.context);
    callFn(env, 'skipPlaylist')(-1);
    const idx = readVar(env, '_testPlayedIndex');
    assert.strictEqual(idx, 'b', 'currentPlaylistIndex=-1 时按"上一个"应落到末尾条目，实际 ' + idx);
  });

  return env;
}

// ============ 第五组：运行时兜底与状态机 ============

console.log('\n=== 运行时兜底 ===');

async function fallbackTest() {
  ok('tryConvertFallback：同一个文件只兜底一次（避免转完还是不行→来回折腾）', async () => {
    const env = loadRenderer();
    await new Promise(r => setTimeout(r, 10));
    vm.runInContext(`
      currentFilePath = 'D:\\\\v\\\\bad.mp4';
      hasRealPath = true;
      isVideoLoaded = true;
      convertFallbackTried.clear();
    `, env.context);
    const fn = callFn(env, 'tryConvertFallback');
    await fn('transcode');
    const afterFirst = env.ipcCalls.filter(c => c[0] === 'prepareMedia').length;
    await fn('transcode');
    const afterSecond = env.ipcCalls.filter(c => c[0] === 'prepareMedia').length;
    assert.strictEqual(afterFirst, 1, '第一次应发起一次兜底转换');
    assert.strictEqual(afterSecond, 1, '第二次必须被拦下（每文件只兜一次）');
  });

  ok('tryConvertFallback：清空播放器后慢兜底结果回来，不得把已清空的播放器重新绑上旧文件', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const env = loadRenderer({
      prepareMedia: () => gate.then(() => 'file:///D:/v/converted.mp4')
    });
    await new Promise(r => setTimeout(r, 10));
    vm.runInContext(`
      currentFilePath = 'D:\\\\v\\\\slow.mp4';
      hasRealPath = true;
      isVideoLoaded = true;
      convertFallbackTried.clear();
      loadSequence = 5;
    `, env.context);
    const promise = callFn(env, 'tryConvertFallback')('transcode');
    // 转换还没回来时，用户清空了播放器
    callFn(env, 'resetPlayerToEmpty')();
    release();
    await promise;
    assert.strictEqual(env.videoEl.src, '', '兜底结果回来时播放器已被清空，绝不能把旧文件重新绑上去');
  });

  return null;
}

// ============ 第二组之二：字幕解析（真实世界的畸形写法） ============

async function subtitleParseTest() {
  const env = loadRenderer();
  await new Promise(r => setTimeout(r, 5));
  const parse = callFn(env, 'parseAndApplySubtitle');
  const read = () => readVar(env, 'currentSubtitleData');

  const cases = [
    ['标准 SRT', '1\n00:00:01,000 --> 00:00:03,000\n你好\n', 1],
    ['无序号 SRT', '00:00:01,000 --> 00:00:03,000\n没有序号\n', 1],
    ['VTT 时间轴带位置参数', '1\n00:00:01.000 --> 00:00:03.000 align:start position:50%\n带参数\n', 1],
    ['SRT 用点分隔毫秒', '1\n00:00:01.000 --> 00:00:03.000\n点分隔\n', 1],
    ['CRLF 换行', '1\r\n00:00:01,000 --> 00:00:03,000\r\n回车换行\r\n', 1],
    ['带 UTF-8 BOM', '\uFEFF1\n00:00:01,000 --> 00:00:03,000\n带BOM\n', 1],
    ['多行文本', '1\n00:00:01,000 --> 00:00:03,000\n第一行\n第二行\n', 1],
    ['标准 ASS', 'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,你好\n', 1],
    ['小写 dialogue（v1.7.0 修过的坑）', 'dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,小写\n', 1],
    ['ASS 文本内含逗号', 'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,你好,世界\n', 1]
  ];

  for (const [label, text, expect] of cases) {
    vm.runInContext('currentSubtitleData = [];', env.context);
    parse(text);
    const data = read();
    assert.strictEqual(data.length, expect, `${label}：应解析出 ${expect} 条，实际 ${data.length} 条`);
  }

  // 多行文本必须原样保留两行（不能只留一行）
  vm.runInContext('currentSubtitleData = [];', env.context);
  parse('1\n00:00:01,000 --> 00:00:03,000\n第一行\n第二行\n');
  const multi = read()[0];
  assert.ok(multi.text.includes('第一行') && multi.text.includes('第二行'), '多行字幕必须保留全部行，实际 ' + JSON.stringify(multi.text));

  // ASS 文本里的逗号不能被当字段分隔符截断
  vm.runInContext('currentSubtitleData = [];', env.context);
  parse('Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,你好,世界\n');
  assert.strictEqual(read()[0].text, '你好,世界', 'ASS 第 10 个字段起的逗号属于正文，不能被截断');

  // 坏时间轴必须被丢弃，不能被当成 0 秒显示
  vm.runInContext('currentSubtitleData = [];', env.context);
  parse('1\n坏时间轴 --> 也是坏的\n正文\n');
  assert.strictEqual(read().length, 0, '坏时间轴的条目必须丢弃（否则会以 0 秒显示在开头）');
}

// ============ 第五组之二：失败熔断与自动跳集 ============

async function failureFallbackTest() {
  const env = loadRenderer({ prepareMedia: () => 'file:///D:/v/a.mp4' });
  await waitForExtensions(env);

  ok('播放失败自动跳集：全部条目都失败过就停下，不会无限循环切换', () => {
    vm.runInContext(`
      playlist = [
        {key:'a.mp4',name:'a.mp4',target:'a.mp4'},
        {key:'b.mp4',name:'b.mp4',target:'b.mp4'}
      ];
      currentPlaylistIndex = 0;
      currentFilePath = 'a.mp4';
      isVideoLoaded = true;
      playMode = 'list-loop';
      failedPlaylistKeys.clear();
      clearAutoNextTimer();
    `, env.context);

    // 第一个文件失败 → 应挂起"1.5 秒后跳下一个"
    env.videoEl.dispatch('error');
    assert.ok(hasTimer(env, 1500), '单个文件失败后应挂起自动跳集定时器');
    assert.strictEqual(readVar(env, 'failedPlaylistKeys').has('a.mp4'), true, '失败的文件必须被记入拉黑集合');

    // 跳到第二个，它也失败 → 此时两条都已失败，必须停止（不再挂定时器）
    vm.runInContext(`
      clearAutoNextTimer();
      currentPlaylistIndex = 1;
      currentFilePath = 'b.mp4';
    `, env.context);
    env.videoEl.dispatch('error');
    assert.strictEqual(hasTimer(env, 1500), false,
      '列表中所有条目都失败过之后必须停止自动跳转，否则会 1.5 秒一轮无限切换');
  });

  ok('单个循环模式下播放失败不自动跳集（用户明确要求只播这一个）', () => {
    vm.runInContext(`
      playlist = [{key:'a.mp4',name:'a.mp4',target:'a.mp4'},{key:'b.mp4',name:'b.mp4',target:'b.mp4'}];
      currentPlaylistIndex = 0;
      currentFilePath = 'a.mp4';
      isVideoLoaded = true;
      playMode = 'single-loop';
      failedPlaylistKeys.clear();
      clearAutoNextTimer();
    `, env.context);
    env.videoEl.dispatch('error');
    assert.strictEqual(hasTimer(env, 1500), false, '单个循环模式下不该自动跳到别的视频');
  });

  ok('换片成功加载元数据后解除该文件的失败标记（失败过的文件重开能正常播）', () => {
    vm.runInContext(`
      currentFilePath = 'a.mp4';
      isVideoLoaded = true;
      failedPlaylistKeys.clear(); failedPlaylistKeys.add('a.mp4'); failedPlaylistKeys.add('b.mp4');
    `, env.context);
    env.videoEl.dispatch('loadedmetadata');
    assert.strictEqual(readVar(env, 'failedPlaylistKeys').has('a.mp4'), false, '当前文件的失败标记必须解除');
    assert.strictEqual(readVar(env, 'failedPlaylistKeys').has('b.mp4'), true,
      '不能清空整个集合——否则两个"能读时长但解码报错"的坏文件会互相清除标记，熔断永远达不到');
  });
}

// ============ 第五组之三：纯音频音乐模式与时长兜底 ============

async function musicAndDurationTest() {
  // 纯音频判定走的是 loadedmetadata → enterMusicMode（async，内部会 await 找封面），
  // 必须给它一个 tick 让异步分支落地后再断言
  await okAsync('纯音频判定：音频扩展名 + 无画面尺寸 → 进入音乐模式', async () => {
    const env = loadRenderer();
    await waitForExtensions(env);
    vm.runInContext(`
      currentFilePath = 'D:\\\\music\\\\song.mp3';
      hasRealPath = true;
      isVideoLoaded = true;
      isMusicMode = false;
    `, env.context);
    // 音频文件：duration 有值，但画面尺寸为 0
    env.videoEl._state.duration = 200;
    env.videoEl._state.videoWidth = 0;
    env.videoEl._state.videoHeight = 0;
    env.videoEl.dispatch('loadedmetadata');
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(readVar(env, 'isMusicMode'), true, '无画面的音频文件必须进入音乐模式');
  });

  ok('音乐模式误判自愈：loadeddata 拿到画面尺寸后立即退出音乐模式', () => {
    const env = loadRenderer();
    vm.runInContext(`
      currentFilePath = 'D:\\\\v\\\\movie.mkv';
      hasRealPath = true;
      isVideoLoaded = true;
      isMusicMode = true;
    `, env.context);
    env.videoEl._state.videoWidth = 1920;
    env.videoEl._state.videoHeight = 1080;
    env.videoEl.dispatch('loadeddata');
    assert.strictEqual(readVar(env, 'isMusicMode'), false,
      'loadeddata 发现有画面就必须退出音乐模式，否则界面会被效果层永久盖住、字幕截图按钮也回不来');
  });

  ok('时长不可用（Infinity/0/NaN）时进度与 seek 一律不动，不写入无效值', () => {
    const env = loadRenderer();
    const progress = env.byId('progress-container');
    const hasSeekable = callFn(env, 'hasSeekableDuration');
    for (const bad of [Infinity, NaN, 0, -1]) {
      env.videoEl._state.duration = bad;
      assert.strictEqual(hasSeekable(), false, `时长 ${bad} 不该被当成可 seek`);
      env.videoEl._state.currentTime = 5;
      env.videoEl.dispatch('timeupdate');
      const written = progress.style.getPropertyValue('--progress');
      assert.ok(written === undefined || written === '',
        `时长 ${bad} 时不能把无效值写进 --progress（实际写入 ${JSON.stringify(written)}）`);
    }
    env.videoEl._state.duration = 100;
    assert.strictEqual(hasSeekable(), true, '正常时长必须可 seek');
  });
}

// 拖入字幕的令牌校验：解码是两次 await 的异步链，期间用户可能已切到别的视频。
// 拖入时记下当时的视频路径，应用前不一致必须丢弃，且不得污染 manualSubtitleFor
// （否则新片的同名自动字幕会被永久压制）。
async function dragSubtitleRaceTest() {
  // 桩返回真实字幕文本，确保走进"仅拖字幕 → 直接应用"分支
  const env = loadRenderer({ decodeSubtitleBuffer: () => '1\n00:00:01,000 --> 00:00:02,000\n旧视频的字幕' });
  assert.ok(!env.topLevelError, '顶层脚本必须无错');

  let parsedText = null;
  await callFn(env, `
    (async () => {
      currentFilePath = 'D:/media/videoA.mkv';
      isVideoLoaded = true;
      const savedParse = parseAndApplySubtitle;
      parseAndApplySubtitle = (t) => { parsedText = t; };
      try {
        const p = loadDraggedSubtitle({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }, null);
        currentFilePath = 'D:/media/videoB.mkv';   // 解码期间换片
        await p;
      } finally { parseAndApplySubtitle = savedParse; }
    })()
  `);
  const manualFor = readVar(env, 'manualSubtitleFor');
  assert.strictEqual(parsedText, null,
    `换片后旧字幕文本仍被应用（实际应用了 ${JSON.stringify(parsedText)}）`);
  assert.ok(manualFor !== 'D:/media/videoB.mkv',
    `换片后 manualSubtitleFor 被污染为新片路径 ${JSON.stringify(manualFor)}`);
}


// renderer.js 全靠 getElementById 抓元素，一旦 index.html 里的 id 被改名/删掉，
// 对应的功能就会静默失效（拿不到元素 → 那段逻辑静默跳过，没有任何报错）。
// 这条把"renderer.js 引用了哪些 id"和"index.html 实际有哪些 id"对账。
function checkDomContract() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const src = RENDERER_SRC;
  // renderer.js 里所有 getElementById('xxx') 的引用
  const used = new Set([...src.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map(m => m[1]));
  const missing = [...used].filter(id => !htmlIds.has(id));
  assert.deepStrictEqual(missing, [],
    'renderer.js 引用了 index.html 里不存在的元素 id（功能会静默失效）: ' + missing.join(', '));
  assert.ok(htmlIds.size > 20, 'index.html 的 id 数量异常（只找到 ' + htmlIds.size + ' 个），文件可能被破坏');
}

// scheduleAudioCheck 的序号校验：同一路径被重新加载（失败自动跳转回来 / 清空后重开）时，
// 仅比较 currentFilePath 不足以识别"新的一次加载"，3 秒后的探测会落在新的加载序列上。
// 必须像兄弟函数 scheduleNoPictureCheck 一样核对 loadSequence。
async function audioCheckSequenceTest() {
  const env = loadRenderer({ probeMedia: () => ({ container: 'mp4', video: 'h264', audio: 'aac', duration: 100, hasAudio: true }) });
  assert.ok(!env.topLevelError, '顶层脚本必须无错');

  await callFn(env, `
    (async () => {
      currentFilePath = 'D:/media/same.mp4';
      isVideoLoaded = true;
      video._state.paused = false;
      video._state.currentTime = 5;
      video._state.videoWidth = 1920;      // 画面正常
      video._state.webkitAudioDecodedByteCount = 0;  // 但音频 0 字节
      loadSequence = 7;                    // 第一代加载
      scheduleAudioCheck();
    })()
  `);
  // 探测前：同一路径但已是新的一次加载（loadSequence 变了）
  await callFn(env, `loadSequence = 8;`);
  runTimers(env, 3000);   // 触发 3 秒后的检查
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();  // 排空探测微任务
  const calls = env.ipcCalls.filter(c => c[0] === 'probeMedia');
  assert.strictEqual(calls.length, 0,
    `loadSequence 已变（同路径重新加载）时不应再发 probeMedia（实际发了 ${calls.length} 次）`);
}

// loadAndPlayVideo 的临时监听器泄漏：hasRealPath 分支每次加载注册一对
// loadedmetadata/error 监听器，靠这两个事件触发 cleanup。但"旧加载被新加载打断"时
// （真实浏览器换 src 只触发 abort/emptied，不触发 loadedmetadata/error），
// 旧的那对监听器永远等不到自己的事件，残留累积：快速连切 N 个视频后每次
// loadedmetadata 都有 N 对回调空跑（绝大多数 token 比对失败白跑一遍）。
async function loadListenerLeakTest() {
  const env = loadRenderer();
  assert.ok(!env.topLevelError, '顶层脚本必须无错');

  const count = (t) => (env.videoEl._listeners[t] || []).length;
  const before = count('loadedmetadata') + count('error');

  // loadAndPlayVideo 是 async：监听器注册在 await prepareMedia 之后，
  // 必须等每次调用走完同步段再发起下一次（真实用户切台就是这样的时序）
  await callFn(env, `
    (async () => {
      for (let i = 0; i < 20; i++) {
        const p = loadAndPlayVideo('D:/media/quick' + i + '.mp4');
        await p.catch(() => {});
        // 不触发 loadedmetadata/error：模拟"下一次加载打断上一次"
      }
    })()
  `);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

  const after = count('loadedmetadata') + count('error');
  const leaked = after - before - 2;   // 最后一次加载自己的 1 对（loadedmetadata+error）是合法在挂
  console.log('        [诊断] 加载前监听器: ' + before + '，20 次完整注册+打断后: ' + after + '（净泄漏 ' + leaked + ' 个，允许 0）');
  assert.ok(leaked <= 0,
    `20 次被中断的加载后监听器应零残留（最后 1 对属当前加载，实际净泄漏 ${leaked} 个）`);
}


// 单例修复的行为锁：泄漏修复不得把续播功能修坏——
// 正常加载（未被中断）触发 loadedmetadata 时，最后一对的 onMeta 必须仍能走到 checkHistoryResume。
async function resumeStillWorksTest() {
  const env = loadRenderer();
  assert.ok(!env.topLevelError, '顶层脚本必须无错');
  // 预置历史：video 存过 120s 位置（键名与 renderer.js 的 HISTORY_KEY 一致）
  env.storage.set('bb_player_history', JSON.stringify({ 'D:/media/resume.mp4': { t: 120, d: 600 } }));
  await callFn(env, `
    (async () => {
      await loadAndPlayVideo('D:/media/resume.mp4').catch(() => {});
    })()
  `);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  // 触发 loadedmetadata（此时 duration 已可用：设置 duration 再派发）
  await callFn(env, `
    (async () => {
      video._state.duration = 600;
      video.dispatch('loadedmetadata');
    })()
  `);
  const pendingResume = readVar(env, 'pendingResumeTime');
  assert.strictEqual(pendingResume, 120,
    `有历史记录的视频在 loadedmetadata 后应触发续播提示（pendingResumeTime 应为 120，实际 ${pendingResume}）`);
}

// renderPlaylist 的增量渲染：向已有列表追加新条目时，已有条目的 DOM 节点必须原样保留
// （节点身份不变），只有新条目被 append。全量 innerHTML='' 重建会：
// 1) 大列表拖入秒级卡顿（每条目 10 个节点 + 3 段 SVG 字符串重复解析）；
// 2) 已挂的 active/is-paused 标记全靠重挂，多一次全列表样式重算。
async function playlistIncrementalRenderTest() {
  const env = loadRenderer();
  assert.ok(!env.topLevelError, '顶层脚本必须无错');

  callFn(env, `
    (function () {
      playlist = [];
      currentPlaylistIndex = -1;
      isVideoLoaded = false;
      _t_children = () => playlistItemsContainer.children.length;
      _t_add = addFilesToPlaylist;
    })()
  `);
  callFn(env, `_t_add(['D:/media/a.mp4', 'D:/media/b.mp4', 'D:/media/c.mp4'])`);
  const step1 = readVar(env, '_t_children')();
  callFn(env, 'video.pause()');
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

  const firstCount = readVar(env, '_t_children')();
  const playlistLen = callFn(env, `playlist.length`);
  const curIdx = readVar(env, `currentPlaylistIndex`);
  console.log('        [诊断] 同步返回时 children=' + step1 + '；稳定后 playlist.length=' + playlistLen + '，children=' + firstCount + '，currentIdx=' + curIdx);
  const nodeA = callFn(env, `playlistItemsContainer.children[0]`);
  const nodeB = callFn(env, `playlistItemsContainer.children[1]`);
  const nodeC = callFn(env, `playlistItemsContainer.children[2]`);
  assert.strictEqual(firstCount, 3, `初始应渲染 3 条（实际 ${firstCount}）`);
  assert.ok(nodeA && nodeB && nodeC, '初始 3 个节点都应存在');

  // 追加 2 条（不触发自动播放：当前已在播）
  await callFn(env, `isVideoLoaded = true; addFilesToPlaylist(['D:/media/d.mp4', 'D:/media/e.mp4']);`);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

  const afterCount = callFn(env, `playlistItemsContainer.children.length`);
  const nodeA2 = callFn(env, `playlistItemsContainer.children[0]`);
  const nodeB2 = callFn(env, `playlistItemsContainer.children[1]`);
  const nodeC2 = callFn(env, `playlistItemsContainer.children[2]`);
  assert.strictEqual(afterCount, 5, `追加后应为 5 条（实际 ${afterCount}）`);
  assert.strictEqual(nodeA, nodeA2, '追加后第 1 条的 DOM 节点必须原样保留（不得重建）');
  assert.strictEqual(nodeB, nodeB2, '追加后第 2 条的 DOM 节点必须原样保留（不得重建）');
  assert.strictEqual(nodeC, nodeC2, '追加后第 3 条的 DOM 节点必须原样保留（不得重建）');
}

// ============ 主流程 ============

(async () => {
  ok('界面结构契约：renderer.js 引用的元素 id 在 index.html 里都存在', checkDomContract);
  await okAsync('播放列表增量渲染：追加条目不重建已有 DOM 节点', playlistIncrementalRenderTest);
  await audioExtTest();
  await okAsync('字幕解析：真实世界的写法（VTT 位置参数 / 点分隔 / CRLF / BOM / ASS 大小写与逗号）', subtitleParseTest);
  await okAsync('菜单手动加载字幕不被"手动优先"标记误拦', subtitleTest);
  await playlistTest();
  await okAsync('播放失败熔断：全部失败即停止自动跳集，单循环不跳集，换片解除单条拉黑', failureFallbackTest);
  await okAsync('纯音频音乐模式判定与误判自愈', musicAndDurationTest);
  await fallbackTest();
  await okAsync('拖入字幕解码期间换片：旧字幕不得挂上新视频、不得污染手动优先标记', dragSubtitleRaceTest);
  await okAsync('scheduleAudioCheck：同路径重新加载（loadSequence 已变）后不得再触发探测', audioCheckSequenceTest);
  await okAsync('快速连切视频：被打断的加载不得残留 loadedmetadata/error 监听器', loadListenerLeakTest);
  await okAsync('监听器单例化后续播功能不坏：有历史的视频 loadedmetadata 仍触发续播提示', resumeStillWorksTest);

  console.log('');
  if (failures.length > 0) {
    console.error(`[失败] renderer 自检未通过：${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
    for (const f of failures) console.error('  · ' + f.name + '\n    ' + (f.err && f.err.stack || f.err));
    process.exit(1);
  }
  console.log(`[OK] renderer 自检全部通过（${passed} 项）`);
})();
