# BBPlayer 1.10.1

> 中文版: [RELEASE-NOTES-1.10.1.md](./RELEASE-NOTES-1.10.1.md)

**In one line**: this release delivers an **across-the-board performance, memory, and stability pass** — legacy formats now **reopen instantly without re-probing FFmpeg**, the playlist drawer and progress bar use **zero-reflow GPU animations**, idle audio hardware **auto-suspends 8 seconds after pause**, main-process file/cache operations are **fully async**, the updater enforces **strict HTTPS checks**, and headless verification grows to **36 converter checks + 51 renderer checks + repo-wide anti-regression contracts**.

---

## ⚡ Performance, Memory & Smoothness

1. **Instant reopen for converted legacy formats**: AVI / FLV / WMV / TS / RMVB / VOB files now check the three-tier disk cache directly *before* checking or spawning `ffmpeg.exe`, making repeat opens instant without spawning a probe process.
2. **Zero-reflow UI & smoother long playlists**:
   - `#playlist-panel` switches to a GPU-composited `translateX` slide-in animation;
   - `#progress-container` keeps a fixed hit area and scales with `scaleY(1.8)` on hover (zero layout reflow);
   - `.playlist-item` enables `content-visibility: auto` to skip off-screen layout and paint on large playlists;
   - Subtitle/logo/popover shadows, spectrum colors, and danger text are consolidated into `:root` and light-theme CSS variables.
3. **Lower idle power & canvas reuse**:
   - Added `audioCtxIdleTimer`: 8 seconds after pausing, `AudioContext.suspend()` releases the audio thread/hardware (and resumes instantly on play or suspends immediately on empty reset);
   - `applyCoverGlow()` reuses a single module-level 24×24 canvas instead of allocating a new canvas on every track change; `setupSpectrumCanvas()` skips resetting when buffer dimensions are unchanged.
4. **Concurrent subtitle probing & lean history view**:
   - `checkAndAutoLoadSubtitles()` now probes all 4 subtitle extensions in parallel via `Promise.all` and picks the first hit in priority order;
   - Watch history drops up to 200 individual per-row closure listeners in favor of a single delegated listener (`dataset.historyPath`), and removing a history entry updates the DOM in place instead of rebuilding the whole list;
   - Volume slider dragging and wheel scrolling debounce writes to `localStorage` (`250ms` + `beforeunload` flush); history only sorts/trims when exceeding `HISTORY_MAX` (200).
5. **Async main-process I/O & display cache**:
   - `file:findCover` uses a single async `fs.promises.readdir` scan with a lowercase map instead of up to 12 sequential `stat` calls;
   - Debounced window-state writes, `second-instance` path resolution, and converter cache `cleanup()` (16-concurrency `fsp.stat`) are all async; multi-display union bounds are lazily cached until display topology changes.

---

## 🩹 Bug Fixes & Security Hardening

| # | Change | Impact |
|---|---|---|
| 1 | Exact one-shot target exemption for programmatic window resize/move | `WeakMap` target matching (±2px, cleared on maximize/unmaximize) stops swallowing immediate manual user drags; adds `minHeight = 320` guard for portrait videos |
| 2 | Strict HTTPS check in `updater.js` (`isSafeHttpsUrl`) | Both installer downloads and `shell.openExternal` fallback block any non-`https:` URL; portable asset regex broadened for hyphen/dot/`v` naming |
| 3 | Async updater `.part` cleanup & progress throttling | Failed downloads clean up `.part` asynchronously; taskbar progress updates throttle at 120ms |
| 4 | Block-aligned FFmpeg progress parsing & probe cancellation | `runFfmpegOnce()` accumulates output by `progress=` block boundaries so percentages don't drop across chunks; track switches cancel active probes via `activeProbes`; `activeParts.delete(part)` runs in the outer `finally` after atomic rename |
| 5 | Clear probe cache on `ffmpegPath` change | `configure()` resets cached probe results when switching binaries |
| 6 | Skip false `"prepare"` UI flash on cache/native hits | Emits `stage: 'prepare'` only when FFmpeg probing actually begins |
| 7 | Corrupt settings & invalid drop guards | `restoreSettings()` rejects non-finite (`Infinity`/`NaN`) subtitle offset/size; drag-and-drop filters out 0-byte files and extensionless directories |
| 8 | Complete empty-state reset & single-pass item removal | `resetPlayerToEmpty()` resets `titlebarIdleTimer`, titlebar visibility/text, time labels, `--progress`, and `.hidden` subtitle class; removing the currently playing item skips double DOM rebuild when advancing |

---

## 🧪 Verification

- `npm run verify` passes completely:
  - Extension reconciliation: 8 native video + 11 convertible video + 6 audio = **25 formats**;
  - Converter checks (35 → **36 items**): adds direct disk-cache hit verification on non-native reopen;
  - Renderer checks (48 → **51 items**): adds regression locks for history delegation/in-place removal, `Infinity` settings defense, and concurrent same-name subtitle discovery;
  - Wiring & contract audit (`verify-wiring.js`): adds Section 10 covering HTTPS enforcement, async `.part` cleanup, zero-reflow CSS, `AudioContext` auto-suspend, history delegation, and async file writes.

---

## 📥 Install

- **BBPlayer Setup 1.10.1.exe** — Windows installer (file associations + desktop shortcut)
- **BBPlayer 1.10.1.exe** — single-file portable build (no install required)

Upgrading from 1.10.0 or 1.9.x is a **direct overwrite** — your **settings, playlist, and watch history are preserved**.

---

## ⚠️ Honest Notes

- The binaries remain **unsigned**, so Windows SmartScreen may prompt once on first launch — click **"Run anyway"** to proceed;
- For the portable build, Windows prevents a running executable from overwriting itself, so the updater places the new `.exe` alongside the old one and launches it; you can delete the old file manually afterward.
