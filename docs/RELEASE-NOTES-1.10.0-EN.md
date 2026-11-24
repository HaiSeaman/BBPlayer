# BBPlayer 1.10.0

> 中文版: [RELEASE-NOTES-1.10.0.md](./RELEASE-NOTES-1.10.0.md)

**In one line**: this release adds an **automatic update check on startup** (completely silent when there is nothing new, and only asks you when there is), fixes the **UI misalignment where the bottom dock's buttons overflowed once the window got narrow**, and ships a full-repo review that fixed **11 real defects**, removed dead code, and grew the automated test suite to **48 items**.

---

## 🆕 New: automatic update check on startup

Previously the only way to update was to visit the Releases page yourself. Now:

1. About 3 seconds after launch, BBPlayer quietly asks GitHub for the latest version in the background;
2. **No update: nothing pops up** — you will not notice anything (offline, timeouts and API errors are just as silent);
3. **Update available: a native dialog** shows "current version → latest version" with **Update / Cancel** buttons;
4. **Update**: it downloads the matching installer (progress on the taskbar icon), launches the installer automatically and then exits;
5. **Cancel**: nothing happens, keep watching.

**Installer and portable builds are handled separately**:

- **Installer build**: downloads the Setup package and lets it overwrite the installation;
- **Portable build**: downloads the portable package next to the app and relaunches the new version. A portable app cannot replace itself while running, so the old file can simply be deleted manually.

**Why not electron-updater**: this project's releases carry no `latest.yml`; adopting electron-updater would also change the release workflow and add a pile of runtime dependencies, which conflicts with the "zero runtime dependencies" rule. The whole feature is one small file, `updater.js`, using Electron's built-in networking.

---

## 🩹 Fixed: bottom dock misaligned in a narrow window

**What you saw**: when you narrowed the player window, the buttons in the floating bottom dock did not shrink with it. The narrower the window, the further right they were pushed, until they spilled out of the rounded panel and were clipped by the window edge.

**Cause (plain English)**: the dock's **outer width** followed the window, but the row of buttons inside had **fixed sizes and was not allowed to wrap**. That row needs roughly **787px** fully expanded, so buttons started squeezing each other below ~870px; at the 480px minimum window the right-hand group was **305px wider than the panel**, with **281px of it outside the window** and clipped.

**After the fix**:

- buttons and the time display never get squashed — they keep their real size;
- as the window narrows, spacing and control sizes tighten automatically;
- when one row genuinely cannot fit, the dock switches to **two centered rows** — every control is still there, nothing is dropped;
- because the dock is taller then, subtitles and the "resume playback" prompt move up so the dock never covers them.

**Measured** (headless, 16 window widths):

| Window width | 1280 | 900 | 640 | 480 |
|---|---|---|---|---|
| Before: overflow | 0 | 0 | 145px | **305px** (281px outside the window) |
| After: overflow | 0 | 0 | **0** | **0** |

---

## 🔧 11 defects found by the full review

| # | Problem | Fix |
|---|---|---|
| 1 | After a successful legacy-format fallback transcode the picture **froze** while the icon still showed "playing" | Changing the source resets the element to paused and fires no "pause" event; playback now resumes according to the previous state |
| 2 | With the app already open, **double-clicking another video did nothing** | The old logic only switched when the file was already in the playlist; every explicit open now plays immediately |
| 3 | After clearing the playlist, the **title bar auto-hid in the empty window** | An empty source is resolved to the document URL, breaking the old "is it empty" test; now uses the real loaded state |
| 4 | **Right-clicking the progress bar also seeked** | Left button only |
| 5 | **Cover shadow / glow vanished** in music mode | The shadow variable was concatenated twice, making the whole declaration invalid; corrected |
| 6 | A second instance could **flash a black window** and re-run cache cleanup and the update check | A process that lost the single-instance lock now returns immediately |
| 7 | **Portable build did nothing after clicking "Update"** | The new exe hit the running process's single-instance lock and quit; now uses a system-level "relaunch after exit" |
| 8 | The update download **hung forever** on a half-open connection | 30-minute timeout (100MB still completes at ~57KB/s) |
| 9 | Installer path and integrity could be abused via release metadata | Use only the basename (no path traversal) and verify against the release's declared size |
| 10 | Screenshot default name could contain Windows-illegal characters such as `:` | Replace illegal characters, strip trailing dots/spaces |
| 11 | The transcode cache could **delete the file being played** (seeking then failed) | Products used within the last 10 minutes are never evicted |

---

## 🧹 Dead code and duplication removed

- Removed two keyboard-focus rules that could **never match** (`div`/`span` are not focusable; measured `tabIndex === -1`);
- Removed window-show logic duplicated by `show: true`, a redundant `row-gap`, and a duplicated file-size check;
- Merged two byte-identical "open folder" button handlers;
- Removed internal exports with no consumers (`availableEncoders` and two others);
- Corrected a wrong extension-key list in the developer docs.

---

## 🧪 Verification

- `npm run verify` is **all green**: extension reconciliation, converter **35 items**, renderer **48 items** (45 existing + 3 new regression locks), and wiring reconciliation (9 packaged files / 24 APIs / 18 sent + 5 received IPC channels);
- Every key conclusion was measured **headlessly before** changing code: an empty source resolves to the document URL, changing the source does not fire a pause event, and Windows throws synchronously when spawning an invalid exe;
- Also fixed a flaw in the test harness itself: two cases passed async functions to a synchronous assertion wrapper, so **failures were swallowed and reported as "passed"** — they are now truly awaited.

---

## 📥 Install

- **BBPlayer Setup 1.10.0.exe** — installer (file associations + desktop shortcut)
- **BBPlayer 1.10.0.exe** — portable (no install, just run)

Upgrading from 1.9.x is a **straight overwrite** — your **settings, playlist and watch history are kept**.

---

## ⚠️ Honest notes

- The downloaded installer is **not code-signed**, so Windows may show a SmartScreen prompt once — choose "Run anyway";
- Auto-update trusts only the fixed GitHub repository and performs **no signature verification** (account compromise remains a risk);
- The download has no "Cancel" button (close the app on a very slow link) and no resume support;
- A portable build cannot replace itself while running: the new version lands next to the old file and you delete the old one; otherwise the old file will prompt again next time;
- Future releases **must bump `package.json`'s version** before building (this release is 1.10.0).

---

## 📋 Full changelog

- **Added**: `updater.js` (startup check + download + launch installer), the startup call in `main.js`, `updater.js` in the packaging list
- **Fixed**: bottom dock overflow in narrow windows (920px / 600px responsive tiers, subtitle and resume-prompt offsets, speed-menu edge compensation)
- **Fixed**: the 11 defects above
- **Cleanup**: dead CSS, redundant logic, unused exports, duplicated handlers
- **Engineering**: `verify-renderer.js` 45 → 48 items; `verify-exts.js` gains a `nativeAll` check; `verify-wiring.js` gains 2 updater contracts; test stubs now use the shared extension module
- **Docs**: `docs/DEVELOPER.md` gains section 21 and a v1.10.0 change log; `README.md` / `README_CN.md` version badges bumped to 1.10.0 with auto-update and narrow-window notes
