HQ Video Compressor V15 — Fast Purple Edition
=================================================

Speed improvements
------------------
V15 first performs a fast HTTP byte-range scan instead of immediately
downloading the complete TikTok video:

1. Read only the first 4 MB.
2. If needed, read only the last 12 MB.
3. Extract the MP4 `moov` box.
4. Read `stts` directly and calculate declared FPS.
5. Avoid the complete video download whenever this fast path succeeds.

Additional speed changes:
- FFmpeg remote probing reduced from six streams to two.
- FFmpeg probe reduced from 240 frames to 90 frames.
- Remote FFmpeg timeout reduced.
- Successful results cached for 10 minutes.
- Full download remains only as the final fallback.

Purple redesign
---------------
- Purple glass background and navigation.
- Violet gradient buttons.
- Lavender Statistics card.
- Purple inputs, result cards, progress bar and status effects.
- Responsive mobile layout retained.

Run
---
1. Extract the ZIP.
2. Double-click START_V15.bat.
3. Open only:

   http://localhost:8015

The page and API must both show V15.
