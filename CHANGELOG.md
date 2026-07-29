# Changelog

All notable changes to the NoBlur project are documented in this file.

## [3.0.0] - 2026-07-28

- Added a fourth bottom-navigation tab named Check
- Added TikTok link inspection for resolution, bitrate, FPS, duration, and file size
- Added secure server-side TikTok URL and redirect validation
- Added official oEmbed and official player-page fallback metadata sources
- Added partial MP4 range probing without saving the video
- Added mobile-responsive video-check results and error states

## [2.6.1] - 2026-07-27

- Made FREE 3-day trial activation idempotent and recoverable after interrupted responses
- Removed dependency on a pre-existing unique constraint for free_trials activation
- Replaced advisory locking with a PostgreSQL users-row lock
- Preserved successful subscription state during temporary session refresh failures
- Added clearer API diagnostic codes and frontend recovery handling

## [2.6.0] - 2026-07-12

- VFI simplified to single-pass; segment/concat removed
- Added binary pipeline tests with real MP4/MOV fixtures
- Codec detection refactored into mp4-boxes — deduplicated
- GitHub Pages: assets moved to repo root with .nojekyll
- Worker/core URLs absolute same-origin (fix esm.sh resolution)
- COI service worker injects COEP on worker requests
- Removed unused icon deps (@remixicon/react, lucide, remixicon)
- Bumped version to 2.6.0

## [2.5.0] - 2026-07-12

- VFI interpolation cap raised from 480p to 1080p on all devices
- VFI processing split into 5s segments (every video) to keep memory stable
- Segment concat rewritten via filter_complex; audio copied from source
- Thread count set to half of hardware concurrency
- Output upscaling uses lanczos resampling
- "Large video" log now only shown for videos longer than 30s

## [2.4.0] - 2026-06-18

**Pipeline Simplification — Single-Pass Frame Density Inflation**

- Confirmed: Frame Density Inflation alone bypasses TikTok recompression
- Non-Interpolation path reduced from 7 passes to 1 (container normalize + inflate)
- Removed: ZeroLoss Track Bypass (`rebuildWithElstBypass`), Quantum Matrix (`patchMvhdMatrix`), Udta Strip (`stripUdtaAtom`), Tkhd Matrix Reset (`stripTkhdMatrix`), Comment Udta Injection (`injectCommentUdta`)
- Deleted `src/mp4-strip.mjs` (3 unused exports) and `src/mp4-patches.mjs` (3 unused exports including internal `buildEdtsAtom`)
- Pipeline is now: `normalizeContainer` → `inflateSampleTableVideo(10x)` → download

## [2.3.0] - 2026-06-17

- VFI audio now uses `-c:a copy` (preserves original, faster processing)
- Default density multiplier changed from 5x to 10x
- `stripUdtaAtom()` force-applies (creates empty udta if missing for consistency)

## [2.2.0] - 2026-06-17

**Major Refactor — No FFmpeg Re-encode in Main Pipeline**

- Main path now uses pure binary patching only (preserves 100% video quality, 10-100x faster)
- FFmpeg lazy-loaded only when VFI enabled
- Fixed critical chunk offset corruption in `normalizeContainer()` for streaming-optimized MP4s
- Added VFR, co64, and codec-aware support to frame density inflation
- Added rotation preservation, timescale-aware ELST, and container normalization
- Moved resolution selector to VFI panel, updated modal text dynamically
- Removed dead code (transform-utils.mjs, static FFmpeg imports, unused variables)
- Infrastructure: Playwright → devDependencies, FFmpeg → dependencies, Biome pinned

## [2.1.0] - 2026-06-17

### Added
- **Hybrid Interpolation Pipeline:** When interpolation is enabled, the VFI engine runs first to produce a 60fps video, then the output is fed into the full 7-pass non-interpolation pipeline (CBR re-encode + binary patches). This ensures VFI output gets the same TikTok bypass treatment as the standard path.
- **FFmpeg Instance Reset:** After VFI completes, the FFmpeg instance is destroyed and recreated for the re-encode pipeline to prevent stale WASM state errors.

### Changed
- **Interpolation Resolution:** VFI now uses the output resolution selector (1080p / 2K) directly, eliminating the need for metadata extraction.
- **Container Dimension Parser:** Interpolation path now uses `getDimensionsFromMp4Container()` to read width/height from the MP4 container instead of `getVideoDurationAndResolution()`, reducing overhead.
- **Removed Duration Guard:** The 30-second video duration limit has been removed. Videos of any length are now processed.
- **Simplified VFI Encoding:** Removed codec detection logic. VFI now hardcodes libx264 encoder, matching the 7-pass pipeline.

### Removed
- **Dead Code Cleanup:** Removed unused functions `CODEC_ENCODER_MAP`, `probeSourceFps()`, `probeInputCodec()`, and `execWithEncoder()`.

### Fixed
- **Stale FFmpeg Instance:** Fixed intermittent errors when running re-encode after VFI by resetting the FFmpeg instance between stages.
- **Modal Scroll Lock:** All modals (TikTok, VFI) now properly lock background scroll on mobile and desktop.
- **TikTok Modal Button Alignment:** Fixed "Open TikTok Studio" button text centering on mobile.
- **Changelog Scroll Isolation:** Added `overscroll-behavior: contain` to prevent scroll-through in the changelog panel.

### UI/UX
- **Custom Scrollbar:** Global scrollbar styled to 2px width with theme-colored thumb.
- **Changelog Panel Position:** Moved to bottom-right corner with slide-in animation from right to left.

## [2.0.0] - 2026-06-16

### Added
- **TikTok Frame Density Bypass:** Non-Interpolation path inflates the MP4 sample table — a clip is rewritten to declare more virtual frames (real samples kept + dummy 8-byte samples whose chunk offsets point to a safe padding region at EOF). TikTok detects this as high-density content and skips heavy recompression, preserving original visual quality.
- **Selectable Density Multiplier (5x default):** The inflation multiplier is configurable. 5x is the confirmed sweetspot — it passes TikTok compression while keeping the dummy-frame tail (and the brief end-of-video freeze) short. 10x also works but produces a longer freeze.
- **Output Resolution Selector (1080p / 2K):** Output can be scaled to 1080p or 2K (1440p) via a UI dropdown. Bitrate auto-scales with resolution — 1080p uses 14261k, 2K uses 25000k. Both confirmed to bypass TikTok compression.
- **Modular Binary Patching Architecture:** Extracted all MP4 binary patching functions from `app.js` into four dedicated ES modules under `src/`.
- **7-Pass Non-Interpolation Pipeline:** Expanded from 3 passes to 7 passes.
- **Aligned Interpolation Pipeline:** The 60fps VFI path now shares the same metadata treatment — timescale 90000, AAC 250k audio, udta strip, tkhd matrix reset, and comment udta injection.
- **H.264 Output Profile:** Switched Non-Interpolation encoder from libx265 CRF 18 to libx264 CBR, Main profile Level 4.2, matching the reference output profile that bypasses TikTok compression.
- **MP4 Container Dimension Parser:** Added `getDimensionsFromMp4Container` to read video width/height/rotation directly from the `tkhd` box binary.
- **Output Thumbnail Capture:** History thumbnails are now captured from the processed output buffer instead of the original input file.
- **Screen Wake Lock:** The screen stays awake during processing on supported mobile browsers.
- **Upload to TikTok Studio Button:** Added a direct link to TikTok Studio web upload, with a mobile-only modal guiding users to enable desktop mode first.

### Changed
- **Non-Interpolation Output Format:** Replaced libx265 CRF encoding with libx264 CBR pipeline.
- **Rotation Handling:** Removed `-noautorotate` FFmpeg flag. FFmpeg now bakes rotation metadata into pixel data during encode.
- **UI Copy & Layout:** Updated header subtitle and system stats to reflect the re-encode + frame density engine.

### Fixed
- **Audio Corruption After Inflation:** Fixed critical bug where audio chunk offsets were not shifted after moov expansion during sample table inflation.
- **Portrait/Landscape Detection for HEVC:** Container-level dimension parsing now correctly identifies orientation for HEVC inputs.

## [1.4.0] - 2026-06-16

### Added
- **Adaptive Rotation Scaling:** Interpolation OFF path now detects video orientation and applies adaptive scaling.
- **Full 3-Pass Pipeline for Non-VFI:** Extended the interpolation OFF path from 1-pass to 3-pass architecture.

### Changed
- **Container Reencode (Pass 1/3):** Clarified terminology — the FFmpeg pass performs re-encoding, not remuxing.

## [1.3.0] - 2026-06-15

### Changed
- **FFmpeg-Native Container Reencode:** Added FFmpeg.wasm re-encoding pass using libx265 with CRF 18.
- **Video Timing Normalization:** Uses `setts=ts='2*TS'` to convert 60fps source to 30fps playback.
- **Audio Timing Normalization:** Synchronizes audio duration with the re-encoded video duration.
- **Metadata Strip:** Strips all source metadata including GPS location, device identifiers.
- **Track Timescale Lock:** Normalizes the video track timescale to the standard 90kHz value.
- **VFI Path Preserved:** The 60fps VFI interpolation path retains the original ZeroLoss + Quantum Matrix pipeline.

## [1.2.0] - 2026-05-26

### Added
- **64-Bit Edit List Support:** Dynamically writes version 1 `elst` boxes with 64-bit track durations.
- **Duplicate Upload Warning Notice:** Visible log alerts inside `addFiles` for duplicate files.
- **Same-Codec Output Alignment:** Matches output encoder/codec properties with the detected input codec.
- **Fast Motion-Compensated VFI:** Upgraded from linear blending to bilateral motion-compensated interpolation.
- **VFI Workload Lightening:** Integrated `mpdecimate` filters to drop duplicate frames prior to interpolation.

### Fixed
- **Active VFI Worker Interruption:** Instant termination of active WebAssembly worker threads on cancellation.
- **Portrait Video Rotation Protection:** Skips display matrix patching if a non-identity matrix is present.
- **Stream-Specific Codec Probing:** Corrected input codec detection to target exact video stream logs.
- **Lightweight DB Size Audits:** Cursor-based IndexedDB storage footprint calculation.

## [1.1.0] - 2026-05-25

### Added
- **60FPS Hybrid Interpolator (Beta):** Client-side video frame rate interpolation using Web Worker-based FFmpeg.wasm.
- **Vite Dev Server COOP/COEP Headers:** Cross-origin isolation natively on localhost.
- **Hardware Decoder Memory Guard:** Explicitly releases `<video>` memory to prevent tab crashes.
- **10-Second Metadata Timeout:** Strict timeout limits to prevent hangs on corrupted media files.
- **Loopback Service Worker Bypass:** Proactive cleanup sequence for sticky service worker headers.

### Fixed
- **FFmpeg Crash State Recovery:** Added `try-catch` resetting to safely reboot the FFmpeg engine on crash.
- **Always-Even & Adaptive Full HD Scaling:** Dynamic portrait/landscape aspect-ratio Full HD boundaries.
- **Safe Database Transactions:** Replaced insecure dynamic indexing with explicit store references.

## [1.0.0] - 2026-05-24

### Added
- **Initial Release:** NoBlur premium container patch utility.
- **ZeroLoss Track Bypass:** Automated metadata parsing injecting `edts`/`elst` atom hierarchy.
- **Quantum Matrix Patch:** Big-endian integer manipulation patching the `mvhd` display matrix.
- **Tactile Neo-Brutalist Layout:** Premium high-contrast dark card interface with flat offset shadows.
- **Local Persistence Storage:** IndexedDB local history tracking with 12-hour pruning and 200MB limit.

## 2.7.0 - Telegram Admin Bot

- Added secure Telegram webhook and protected webhook setup endpoint.
- Added admin dashboard, user search, subscription, trial, payment and stats commands.
- Added server-side compression metadata counters without uploading video files.
- Added admin-only access using `TELEGRAM_ADMIN_IDS`.

## 2.9.0 — Telegram-admin paid subscriptions
- Blocked public self-activation of PRO, PREMIUM, and MAX.
- Added admin-only `/grant`, `/revoke`, and `/plans` Telegram commands.
- Added Grant/Revoke buttons to Telegram user details.
- Marked paid plan cards as ADMIN ONLY and replaced demo-payment activation with status checking.
- Added automatic membership refresh when users return to the website.

## V12 — Paid plan duration correction

- PRO remains 30 days.
- PREMIUM changed from 120 to 180 days.
- MAX changed from unlimited to one year (365 days).
- Migrates existing paid subscriptions and enforces expiration for every paid plan.

## V13 — Telegram login recovery

- Removed paid-plan ALTER TABLE migration from the authentication-critical path.
- Made legacy plan-duration migration non-blocking.
- Clear stale OAuth cookies after a failed callback.
- Added safer callback diagnostics and a return-to-app error screen.

## V20 — Official TikTok Login + Inbox Upload (Sandbox)

- Added official TikTok OAuth 2.0 connection for Telegram-authenticated users with state, PKCE and secure cookies.
- Added AES-256-GCM encrypted server-side token storage and automatic access-token refresh.
- Added clean, real-timing TikTok upload artifacts created before local sample-table inflation.
- Added official Inbox/Draft upload initialization, direct browser-to-TikTok chunk transfer, status polling and cancellation.
- Added connected TikTok identity UI, explicit consent review modal, upload progress and Inbox completion guidance.
- Added `/terms` and `/privacy`, versioned PostgreSQL tables and TikTok integration tests/documentation.

## V21 — Consolidated Vercel API router

- Reduced the root `/api` directory from 25 files to one catch-all Vercel Function.
- Moved existing handlers and private helpers to `server/api/` without changing public API URLs.
- Added `api/[...route].js` to dispatch all Telegram, subscription, database and TikTok endpoints.
- Updated Vercel function configuration and test import paths.
