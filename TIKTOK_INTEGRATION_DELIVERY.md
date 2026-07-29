# THEZIESS METHOD TikTok Integration — Delivery Notes

## Scope

This build adds TikTok Login Kit and Content Posting API Inbox/Draft upload support while preserving the existing Telegram authentication, subscriptions, payment/admin features, TikTok link checker, IndexedDB history, and local FFmpeg/MP4 workflow.

The implementation is configured for TikTok Sandbox validation first. It does not claim TikTok Production approval.

## API routes

- `GET /api/auth/tiktok`
- `GET /api/auth/tiktok/callback`
- `GET /api/tiktok/account`
- `POST /api/tiktok/disconnect`
- `POST /api/tiktok/upload/init`
- `POST /api/tiktok/upload/status`
- `POST /api/tiktok/upload/cancel` — closes the local upload reservation after browser cancellation; it does not cancel an upstream TikTok FILE_UPLOAD task.

## Database additions

- `theziess_tiktok_connections_v1`
- `theziess_tiktok_uploads_v1`

Only OAuth connection data and upload metadata are stored. Video bytes are uploaded directly from the browser to TikTok and are not stored in PostgreSQL.

## Required environment variables

```env
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
TIKTOK_REDIRECT_URI=https://theziessmethod.site/api/auth/tiktok/callback
TIKTOK_SCOPES=user.info.basic,video.upload
TIKTOK_TOKEN_ENCRYPTION_KEY=
TIKTOK_PUBLIC_URL=https://theziessmethod.site
```

Use an independent, high-entropy 32-byte encryption key. Never commit real credentials.

## Validation status

Completed in the delivery environment:

- JavaScript module syntax checks
- JSON configuration parsing
- HTML parsing
- merge-conflict marker scan
- duplicate `ffmpeg-core-mt/` application tree unchanged
- manual mocked assertions for state, PKCE helpers, token encryption, token refresh, auth guards, upload ownership, chunk planning, safe errors, and 23–60 FPS validation

The complete `npm test`, `npm run lint`, and `npm run build` commands could not be executed in the delivery environment because its internal npm mirror did not provide a locked transitive package. Run all three after installing dependencies on a normal network before deployment.

## Remaining external validation

- Configure TikTok Login Kit and Content Posting API products in TikTok Developer Portal.
- Add the exact redirect URI and Sandbox target user.
- Confirm Sandbox grants exactly `user.info.basic` and `video.upload`.
- Perform a real browser-to-TikTok upload and finish the draft in the TikTok mobile app.
- Complete TikTok review before treating the integration as Production-approved.
- TikTok's current web documentation does not require PKCE for confidential web clients; this build includes the requested PKCE parameters and therefore needs explicit Sandbox verification with your TikTok app configuration.
