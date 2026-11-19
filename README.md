# BBPlayer

<div align="center">

![Electron](https://img.shields.io/badge/Electron-44.x-47848F?style=for-the-badge&logo=electron&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge)
![Version](https://img.shields.io/badge/Version-1.9.2-ff3b4e?style=for-the-badge)

**A pure, lightweight, high-polish borderless media player for Windows**

[English](./README.md) | [简体中文](./README_CN.md)

[Features](#-features) · [Supported Formats](#-supported-formats) · [Keyboard Shortcuts](#-keyboard-shortcuts) · [Quick Start](#-quick-start) · [Build from Source](#-build-from-source) · [Architecture](#-architecture) · [License](#-license)

</div>

---

## 📖 Overview

**BBPlayer** is a minimal, lightweight local media player built with **Electron + vanilla HTML5/CSS3/JavaScript (ES6+)** — no frontend frameworks, no runtime npm dependencies.

It follows a **"Quiet Glass"** design philosophy: the player UI gets out of the way so the video itself is the hero. Ghost-icon controls, a transparent titlebar, a single rainbow-branded accent, and aggressive GPU/CPU budgeting (only one `backdrop-filter` in the entire UI) deliver an immersive, native-feeling experience.

> **Highlights at a glance** — multi-window playback, 200% volume boost with anti-clipping, a full music mode with spectrum visualization and ambient cover glow, a self-built SRT/VTT/ASS/SSA subtitle engine with GBK encoding detection, and rainbow file-type icons across all 25 associated media formats (legacy ones auto-converted).

---

## ✨ Features

### 🖥️ Player Experience
- **Borderless frameless window** with a fully transparent titlebar — text and buttons stay readable over any video frame thanks to adaptive text shadows.
- **Smart auto-hiding UI**: titlebar and control dock slide in from hotzones and hide instantly when the mouse leaves; a 3-second idle timer kicks in during playback. Empty state keeps window buttons always available.
- **Drag-to-move window** on both the video surface and the titlebar (single click = play/pause, double click = fullscreen; double-click the titlebar = maximize/restore).
- **Aspect-ratio auto-fit**: the window locks to the video's resolution to eliminate black bars; manually resizing unlocks it.
- **Rainbow brand identity**: gradient play-triangle app icon (taskbar, EXE, and all file associations), rainbow progress bar with a fixed color band, and a transparent play/pause button with a gradient glyph.

### 🎬 Playback
- **Multi-window playback**: open any video in its own independent player window — playlist hover button, header button, or double-clicking a file while the app is running.
- **Playlist & watch history**: drag-and-drop or multi-select loading, natural episode ordering (`EP2` before `EP10`), resume-playback memory, three play modes (loop all / shuffle / loop one).
- **Precision speed control**: 0.5x – 3.0x presets with pitch preservation.
- **Rotation & aspect modes**: 90°/180°/270° rotation; auto / 16:9 / 4:3 / stretch-fill.
- **4K-lossless screenshots**: canvas-based capture that respects rotation, saved as PNG.
- **Smart resume**: playback position is remembered and offered via a toast on reopen.

### 🎵 Music Mode (audio-only files)
When an audio file is loaded, the player transforms into a music screen:
- **32-bar spectrum visualization** driven by `AnalyserNode` (pauses to save power).
- **Cover art auto-discovery** (`cover.jpg`, `folder.jpg`, or same-named images).
- **Ambient glow**: the background gradient is sampled from the cover's dominant color, unique per track.

### 🔊 200% Volume Boost
- A Web Audio pipeline (`MediaElementSource → GainNode → DynamicsCompressor → output`) breaks the browser's 100% volume ceiling — slider, scroll wheel, and arrow keys all support 0–200%.
- A built-in compressor acts as an anti-clipping airbag: soft-knee limiting near −3 dB prevents distortion at high gain. The slider turns orange above 100% as a warning.

### 💬 Subtitle Engine
- **Self-built SRT / VTT / ASS / SSA parser** (browser `<track>` can't handle `file://` paths or ASS).
- **Automatic same-name subtitle loading** from the video's directory; subtitles can also be dragged in together with the video.
- **Encoding detection**: BOM sniffing → strict UTF-8 → GBK fallback — legacy ANSI Chinese subtitles display correctly.
- **Full control**: font size (12–48px), global time offset (±60s), show/hide toggle.

### 🎨 Appearance
- **Light / dark themes** with one click; semantic CSS variables keep text and controls readable in both; theme choice is remembered.
- File associations for 25 media formats (11 of them auto-converted by the built-in converter), single-instance lock, window size/position memory (including maximized state).

---

## 📂 Supported Formats

| Type | Formats |
|---|---|
| **Video (native)** | MP4 · MKV · MOV · WebM · M4V · 3GP · OGV · F4V |
| **Video (auto-converted)** | AVI · FLV · WMV · TS · RMVB · RM · MPG · MPEG · M2TS · VOB · M2V |
| **Audio** | MP3 · FLAC · WAV · OGG · M4A · AAC |

All 25 formats open with a double-click. Formats Chromium handles natively play as-is; the second group is handled by the **built-in FFmpeg converter** in three tiers:

| Tier | When it applies | Cost |
|---|---|---|
| Remux | Container unsupported but codecs fine (TS / M2TS / FLV(H.264) / AVI(H.264)) | **under 1 second**, zero quality loss |
| Audio-only fix | Picture fine, audio is AC3 / EAC3 / DTS (a common cause of "no sound" on HD releases) | **under 1 second**, video untouched |
| Full transcode | Legacy codecs: RMVB / WMV / Xvid(DivX) / MPEG-1/2 (VOB, MPG) / Theora / ProRes / H.263 | waits (roughly 2–10× realtime at 1080p), slight quality loss |

- Progress is shown live in the UI ("正在换容器… 45%"), switching files cancels it, and converted output is cached — **the second open is instant**.
- If probing says "playable" but the engine produces no picture or no sound, BBPlayer automatically falls back to transcode / audio-fix (runtime fallback, once per file).
- The bundled converter is a **trimmed, self-compiled LGPL build of FFmpeg** (a single ~14MB static binary; full builds are ~150MB), invoked as a separate process (no linking, no modification); its licence text ships with the app. If it is missing, BBPlayer degrades gracefully — those legacy formats report a clear error, everything else is unaffected.

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `←` / `→` | Seek −5s / +5s |
| `↑` / `↓` | Volume ±5% |
| `F11` / double-click viewport | Toggle fullscreen (`Esc` exits) |
| `M` | Mute / restore |
| `S` | Screenshot |

---

## 🚀 Quick Start

### Download (end users)
Grab the latest release from the [Releases](../../releases) page:
- **`BBPlayer Setup x.x.x.exe`** — standard Windows installer.
- **`BBPlayer x.x.x.exe`** — single-file portable build, no installation required.

### Run from source (developers)
```bash
git clone https://github.com/your-username/bb-player.git
cd bb-player
npm install
npm start
```

> 💡 Tip: you can also drag media files onto `run-test.bat` to launch the dev build and play them immediately.

---

## 🛠️ Build from Source

```bash
npm install        # install dev dependencies (electron + electron-builder only)
npm run verify     # consistency check: shared extension lists ↔ package.json file associations
npm run build      # produce installer + portable exe into release-dist/
```

Build outputs (in `release-dist/`):
- `BBPlayer Setup <version>.exe` — NSIS installer
- `BBPlayer <version>.exe` — portable executable

---

## 🏗️ Architecture

```
BBPlayer/
├── main.js                 # Main process: multi-window factory, IPC trust surface, dialogs, directory scanning
├── preload.js              # Context-isolated bridge (contextBridge → window.electronAPI)
├── renderer.js             # All UI logic: playback state machine, subtitles, gestures, spectrum, themes
├── converter.js            # Media compatibility layer: probe + three tiers + cache + concurrency queue
├── index.html              # Single-file view: DOM + all CSS (semantic variables, dual themes, rainbow tokens)
├── shared-video-exts.js    # Single source of truth: video/audio extension lists
├── shared-subtitle-exts.js # Single source of truth: subtitle extension list
├── verify-exts.js          # Consistency checker: shared lists ↔ package.json file associations
├── verify-converter.js     # Headless self-check: tier rules + real conversion smoke tests
├── verify-renderer.js      # Headless self-check: runs renderer.js in a Node vm + DOM/Electron stubs
├── verify-wiring.js        # End-to-end wiring check: pack list / preload API / IPC channels / HTML refs
├── build/                  # App icons (rainbow gradient play triangle, ico/png)
└── package.json            # Metadata + electron-builder config
```

**Design principles**
- **Zero runtime dependencies** — only `electron` and `electron-builder` as devDependencies.
- **Single-file renderer** — one `renderer.js` (~2,400 lines) per window, fully isolated state.
- **Hardened IPC** — every handler validates the sender against a trusted-window set (`isTrustedSender`); navigation, `window.open`, and non-top-level frames are blocked.
- **Extension single source** — media/subtitle extension lists live in shared modules consumed by both processes via IPC, auto-checked by `npm run verify`.

Deep-dive documentation (state machines, audio pipeline, token-based race protection, version history) lives in **[docs/DEVELOPER.md](./docs/DEVELOPER.md)**.

---

## 🤝 Contributing

Issues and pull requests are welcome. Before submitting:
1. Run `npm run verify` and ensure it passes.
2. Run the app via `run-test.bat` (or `npm start`) and smoke-test your change.
3. Keep the zero-runtime-dependency discipline.

---

## 📄 License

Released under the [MIT License](./LICENSE).
