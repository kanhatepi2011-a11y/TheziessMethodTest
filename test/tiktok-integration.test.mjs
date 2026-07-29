import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it, vi } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));

let tiktok;
let session;
let callbackHandler;
let media;

beforeAll(async () => {
    process.env.DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/test";
    process.env.SESSION_SECRET = "test-session-secret-at-least-24-characters";
    process.env.TIKTOK_TOKEN_ENCRYPTION_KEY = "test-token-encryption-key-at-least-32-characters-long";
    process.env.TIKTOK_CLIENT_KEY = "sandbox-client-key";
    process.env.TIKTOK_CLIENT_SECRET = "sandbox-client-secret";
    process.env.TIKTOK_REDIRECT_URI = "https://theziessmethod.site/api/auth/tiktok/callback";
    process.env.TIKTOK_PUBLIC_URL = "https://theziessmethod.site";
    process.env.TIKTOK_SCOPES = "user.info.basic,video.upload";

    tiktok = await import("../server/api/_tiktok.js");
    session = await import("../server/api/_session.js");
    callbackHandler = (await import("../server/api/auth/tiktok/callback.js")).default;
    media = await import("../src/tiktok-upload.mjs");
});

function makeResponse() {
    const headers = new Map();
    return {
        statusCode: 200,
        body: null,
        redirectCode: null,
        redirectUrl: null,
        setHeader(name, value) {
            headers.set(String(name).toLowerCase(), value);
        },
        getHeader(name) {
            return headers.get(String(name).toLowerCase());
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(value) {
            this.body = value;
            return this;
        },
        redirect(code, url) {
            this.redirectCode = code;
            this.redirectUrl = url;
            return this;
        },
    };
}

describe("TikTok OAuth security", () => {
    it("generates RFC-compatible PKCE values", () => {
        const first = tiktok.createPkcePair();
        const second = tiktok.createPkcePair();
        expect(first.method).toBe("S256");
        expect(first.verifier.length).toBeGreaterThanOrEqual(43);
        expect(first.verifier.length).toBeLessThanOrEqual(128);
        expect(first.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(second.verifier).not.toBe(first.verifier);
        expect(second.challenge).not.toBe(first.challenge);
    });

    it("creates unpredictable state and validates it timing-safely", () => {
        const first = tiktok.createOAuthState();
        const second = tiktok.createOAuthState();
        expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(first).not.toBe(second);
        expect(tiktok.timingSafeEqualText(first, first)).toBe(true);
        expect(tiktok.timingSafeEqualText(first, second)).toBe(false);
        expect(tiktok.timingSafeEqualText(first, `${first}x`)).toBe(false);
    });

    it("encrypts tokens with authenticated encryption", () => {
        const token = "act.test-secret-access-token";
        const first = tiktok.encryptTikTokToken(token);
        const second = tiktok.encryptTikTokToken(token);
        expect(first).toMatch(/^v1\./);
        expect(first).not.toBe(second);
        expect(tiktok.decryptTikTokToken(first)).toBe(token);

        const pieces = first.split(".");
        const last = pieces[3].at(-1);
        pieces[3] = `${pieces[3].slice(0, -1)}${last === "A" ? "B" : "A"}`;
        expect(() => tiktok.decryptTikTokToken(pieces.join("."))).toThrow(/decrypt/i);
    });

    it("refreshes an expired access token server-side", async () => {
        const now = Date.UTC(2026, 6, 29, 12, 0, 0);
        const connection = {
            user_key: "42",
            open_id: "open-id-old",
            granted_scopes: "user.info.basic,video.upload",
            encrypted_access_token: tiktok.encryptTikTokToken("expired-access"),
            encrypted_refresh_token: tiktok.encryptTikTokToken("valid-refresh"),
            access_token_expires_at: new Date(now - 1000).toISOString(),
            refresh_token_expires_at: new Date(now + 86_400_000).toISOString(),
        };
        const tokenFetcher = vi.fn(async ({ refreshToken }) => {
            expect(refreshToken).toBe("valid-refresh");
            return {
                access_token: "new-access",
                refresh_token: "new-refresh",
                open_id: "open-id-new",
                scope: "video.upload,user.info.basic",
                expires_in: 3600,
                refresh_expires_in: 86_400,
            };
        });
        const tokenUpdater = vi.fn(async (input) => ({
            ...connection,
            open_id: input.openId,
            encrypted_access_token: input.encryptedAccessToken,
            encrypted_refresh_token: input.encryptedRefreshToken,
            access_token_expires_at: input.accessTokenExpiresAt,
            refresh_token_expires_at: input.refreshTokenExpiresAt,
        }));

        const result = await tiktok.refreshTikTokConnection(connection, {
            now,
            tokenFetcher,
            tokenUpdater,
        });

        expect(result.refreshed).toBe(true);
        expect(result.accessToken).toBe("new-access");
        expect(tokenFetcher).toHaveBeenCalledOnce();
        expect(tokenUpdater).toHaveBeenCalledOnce();
        const update = tokenUpdater.mock.calls[0][0];
        expect(tiktok.decryptTikTokToken(update.encryptedAccessToken)).toBe("new-access");
        expect(tiktok.decryptTikTokToken(update.encryptedRefreshToken)).toBe("new-refresh");
    });

    it("rejects an OAuth callback with invalid state before network or database work", async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);
        const sessionToken = session.encodeSession({
            userId: "42",
            telegramId: "2296495941",
            user: { id: "2296495941", first_name: "Test" },
        });
        const req = {
            method: "GET",
            query: { code: "authorization-code", state: "wrong-state" },
            headers: {},
            cookies: {
                theziess_session: sessionToken,
                tiktok_oauth_state: "expected-state",
                tiktok_pkce_verifier: "verifier-value",
                tiktok_oauth_subject: "42.placeholder",
            },
        };
        const res = makeResponse();

        await callbackHandler(req, res);

        expect(res.redirectCode).toBe(302);
        expect(res.redirectUrl).toBe("/?tiktok=error");
        expect(fetchSpy).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it("guards routes that require Telegram authentication", () => {
        expect(() => tiktok.requireTelegramUser({ headers: {} })).toThrow(/Telegram/i);
        try {
            tiktok.requireTelegramUser({ headers: {} });
        } catch (error) {
            expect(error.code).toBe("AUTH_REQUIRED");
            expect(error.statusCode).toBe(401);
        }
    });
});

describe("TikTok upload validation and ownership", () => {
    const MB = 1024 * 1024;

    it.each([
        [1 * MB, 1, 1 * MB],
        [5 * MB - 1, 1, 5 * MB - 1],
        [5 * MB, 1, 5 * MB],
        [33 * MB, 1, 33 * MB],
        [64 * MB, 2, 32 * MB],
        [65 * MB, 2, 32 * MB],
        [95 * MB, 2, 32 * MB],
        [96 * MB, 3, 32 * MB],
    ])("calculates a valid chunk plan for %i bytes", (size, expectedCount, expectedChunkSize) => {
        const plan = tiktok.calculateTikTokChunkPlan(size);
        expect(plan.totalChunkCount).toBe(expectedCount);
        expect(plan.chunkSize).toBe(expectedChunkSize);
        expect(plan.chunks).toHaveLength(expectedCount);
        expect(plan.chunks[0].start).toBe(0);
        expect(plan.chunks.at(-1).end).toBe(size - 1);
        expect(plan.chunks.reduce((sum, chunk) => sum + chunk.size, 0)).toBe(size);
        for (const [index, chunk] of plan.chunks.entries()) {
            if (expectedCount > 1 && index < expectedCount - 1) {
                expect(chunk.size).toBeGreaterThanOrEqual(5 * MB);
                expect(chunk.size).toBeLessThanOrEqual(64 * MB);
            }
            if (index > 0) expect(chunk.start).toBe(plan.chunks[index - 1].end + 1);
        }
    });

    it("validates upload initialization metadata and rejects binary-like fields", () => {
        expect(
            tiktok.validateUploadInitInput({
                filename: "processed.mp4",
                fileSize: 12 * MB,
                mimeType: "video/mp4",
            }),
        ).toEqual({ filename: "processed.mp4", fileSize: 12 * MB, mimeType: "video/mp4" });

        expect(() =>
            tiktok.validateUploadInitInput({
                filename: "processed.mp4",
                fileSize: 12 * MB,
                mimeType: "video/mp4",
                binary: "not-allowed",
            }),
        ).toThrow(/Unexpected/i);
        expect(() =>
            tiktok.validateUploadInitInput({
                filename: "processed.exe",
                fileSize: 12 * MB,
                mimeType: "video/mp4",
            }),
        ).toThrow(/filename/i);
        expect(() =>
            tiktok.validateUploadInitInput({
                filename: "processed.mp4",
                fileSize: 12 * MB,
                mimeType: "application/octet-stream",
            }),
        ).toThrow(/MP4/i);
    });

    it("accepts only an upload owned by the current Telegram database user", () => {
        const upload = { user_key: "42", publish_id: "v_pub_123" };
        expect(tiktok.assertTikTokUploadOwnership(upload, "42", "v_pub_123")).toBe(upload);
        expect(() => tiktok.assertTikTokUploadOwnership(upload, "99", "v_pub_123")).toThrow(/not found/i);
        expect(() => tiktok.assertTikTokUploadOwnership(upload, "42", "other")).toThrow(/not found/i);
    });

    it("normalizes upstream errors without exposing raw data", () => {
        const error = tiktok.normalizeTikTokError(
            {
                error: {
                    code: "rate_limit_exceeded",
                    message: "raw upstream details must not be returned",
                    log_id: "safe-log-id-123",
                },
                access_token: "secret",
            },
            429,
        );
        expect(error.statusCode).toBe(429);
        expect(error.code).toBe("RATE_LIMIT_EXCEEDED");
        expect(error.message).toMatch(/rate limit/i);
        expect(error.message).not.toContain("raw upstream");
        expect(error.supportReference).toBe("safe-log-id-123");
    });

    it("requires real TikTok-compatible FPS between 23 and 60", () => {
        const base = {
            width: 1080,
            height: 1920,
            duration: 15,
            byteSize: 4 * MB,
            mimeType: "video/mp4",
            codec: "avc1",
        };
        expect(media.validateTikTokArtifact({ ...base, fps: 23 }).valid).toBe(true);
        expect(media.validateTikTokArtifact({ ...base, fps: 60 }).valid).toBe(true);
        expect(media.validateTikTokArtifact({ ...base, fps: 22.99 }).valid).toBe(false);
        expect(media.validateTikTokArtifact({ ...base, fps: 60.01 }).valid).toBe(false);
        expect(media.validateTikTokArtifact({ ...base, fps: 600 }).valid).toBe(false);
    });

    it("reads truthful timing from the clean MP4 fixture", () => {
        const bytes = new Uint8Array(readFileSync(join(testDir, "fixtures", "h264_faststart.mp4")));
        const metadata = media.inspectMp4ForTikTok(bytes, "video/mp4");
        expect(metadata.fps).toBeGreaterThan(0);
        expect(metadata.fps).toBeLessThanOrEqual(60);
        expect(metadata.sampleCount).toBeGreaterThan(0);
    });
});
