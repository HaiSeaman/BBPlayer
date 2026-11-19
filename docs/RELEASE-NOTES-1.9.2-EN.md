# BBPlayer 1.9.2

> 中文版: [RELEASE-NOTES-1.9.2.md](./RELEASE-NOTES-1.9.2.md)

**In one line**: a fix-only patch release — it removes the persistent black band along the right edge of the window and makes the "resume playback" prompt auto-hide after **10 seconds** of no interaction. **No new features**, just these two visible annoyances fixed.

---

## 🩹 Fix 1: black shadow on the right window edge (gone)

**What you saw**: with any video playing, there was always a dark, fading vertical band just inside the **right** edge of the window. The left, top and bottom edges were clean. Switching videos made no difference.

**Cause (plain English)**: the playlist drawer on the right normally hides by sliding 320px outside the window. It carries a drop shadow so it separates from the picture when opened. A shadow **does not disappear when its element moves off-screen** — it still bled about 40px back into the window, and the window's clipping trimmed the outside part, leaving a black band stuck to the right border. Since the drawer starts below the title bar, it looked like "only the right edge has a shadow".

**After the fix**:

- while the drawer is **closed**, its shadow is **fully transparent** — nothing leaks;
- while the drawer is **open**, the shadow appears exactly as before;
- opening/closing fades the shadow over 0.25s, so there is **no sudden pop**.

**Measured** (white frame simulating video; right-edge pixel brightness, 0 = black / 255 = white):

| Right-edge column | 740 | 750 | 760 | 770 | 780 |
|---|---|---|---|---|---|
| Before | 253 | 245 | 225 | 192 | 154 (darker toward the edge) |
| After | 255 | 255 | 255 | 255 | 255 (pure white — band gone) |

---

## ⏱️ Fix 2: resume prompt auto-hides after 10 seconds

**What you saw**: reopening a previously watched video popped up the "Last time you were at xx:xx / Resume ✕" strip at the bottom left. If you ignored it, it **stayed on screen forever**.

**Cause (plain English)**: the code only ever showed the strip — **nothing ever hid it**.

**After the fix**:

- it **hides by itself after 10 seconds** without interaction;
- **hovering** over it pauses the countdown (so it won't vanish while you are reading it); moving the mouse away **restarts** the 10-second countdown;
- clicking "Resume" or "✕" hides it immediately;
- switching videos or clearing the player also dismisses it, so it never carries over to the next video.

---

## 🧪 Verification

- Both fixes were verified **headlessly, with no window popping up**: the black band was checked pixel-by-pixel on the real page, and the prompt was driven through its full show/hide lifecycle by an automated script;
- `npm run verify` is **all green**: renderer self-check **45 items** (including a new auto-hide case), converter self-check **35 items**, extension and wiring reconciliation all pass;
- each fix has an **automated assertion** so it cannot silently regress.

---

## 📥 Install

- **BBPlayer Setup 1.9.2.exe** — installer (file associations + desktop shortcut)
- **BBPlayer 1.9.2.exe** — portable (no install, just run)

Upgrading from 1.9.x is a **straight overwrite** — your **settings, playlist and watch history are kept**.

---

## ⚠️ Honest notes

- **No new features** in this release — only the two UI fixes above.
- **No storage or data-format changes**, so upgrading loses nothing.
- **Known leftovers** (unchanged on purpose, same as 1.9.1): settings/history can still overwrite each other across multiple windows; conversion failures only explain the reason with no "open in another player" button; convert-while-playing, multi-audio-track selection and burned-in subtitle transcoding are still not implemented.

---

## 📋 Full changelog

- **Fixed**: closed playlist drawer's shadow leaked into the window, producing a black band along the right edge → shadow now only exists while the drawer is open
- **Fixed**: resume prompt never disappeared → now auto-hides after 10s idle, pauses on hover and restarts on mouse leave
- **Engineering**: `verify-renderer.js` 44 → 45 items, new behavior lock for the resume-prompt auto-hide; `npm run verify` all green
- **Docs**: `docs/DEVELOPER.md` gained a v1.9.2 change-log section; `README.md` / `README_CN.md` version badges bumped to 1.9.2
