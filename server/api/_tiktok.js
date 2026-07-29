import crypto from "node:crypto";

import {
  getTikTokConnection,
  updateTikTokConnectionProfile,
  updateTikTokConnectionTokens,
} from "./_db.js";
import { getSession } from "./_session.js";

export const REQUIRED_TIKTOK_SCOPES = ["user.info.basic", "video.upload"];
export const TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
export const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
export const TIKTOK_REVOKE_URL = "https://open.tiktokapis.com/v2/oauth/revoke/";
export const TIKTOK_USER_INFO_URL =
  "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url";
export const TIKTOK_UPLOAD_INIT_URL =
  "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
export const TIKTOK_UPLOAD_STATUS_URL =
  "https://open.tiktokapis.com/v2/post/publish/status/fetch/";

const ACCESS_REFRESH_SKEW_MS = 5 * 60 * 1000;
const MAX_TIKTOK_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
const MIN_CHUNK_BYTES = 5 * 1024 * 1024;
const PREFERRED_CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

function createError(message, code, statusCode = 400, supportReference) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  if (supportReference) error.supportReference = supportReference;
  return error;
}

export function getTikTokConfig() {
  const clientKey = String(process.env.TIKTOK_CLIENT_KEY || "").trim();
  const clientSecret = String(process.env.TIKTOK_CLIENT_SECRET || "").trim();
  const publicUrl = String(
    process.env.TIKTOK_PUBLIC_URL || "https://theziessmethod.site",
  ).replace(/\/+$/, "");
  const redirectUri = String(
    process.env.TIKTOK_REDIRECT_URI ||
      "https://theziessmethod.site/api/auth/tiktok/callback",
  ).trim();
  const configuredScopes = normalizeScopes(
    String(process.env.TIKTOK_SCOPES || REQUIRED_TIKTOK_SCOPES.join(",")),
  );
  const unknownScopes = configuredScopes.filter(
    (scope) => !REQUIRED_TIKTOK_SCOPES.includes(scope),
  );
  if (
    unknownScopes.length ||
    !REQUIRED_TIKTOK_SCOPES.every((scope) => configuredScopes.includes(scope))
  ) {
    throw createError(
      "TikTok scopes must be exactly user.info.basic and video.upload.",
      "TIKTOK_SCOPES_INVALID",
      500,
    );
  }
  const scopes = [...REQUIRED_TIKTOK_SCOPES];

  if (!clientKey || !clientSecret) {
    throw createError(
      "TikTok integration is not configured.",
      "TIKTOK_CONFIG_MISSING",
      503,
    );
  }

  let redirect;
  let publicOrigin;
  try {
    redirect = new URL(redirectUri);
    publicOrigin = new URL(publicUrl).origin;
  } catch {
    throw createError(
      "TikTok redirect configuration is invalid.",
      "TIKTOK_CONFIG_INVALID",
      500,
    );
  }

  if (redirect.protocol !== "https:" || redirect.origin !== publicOrigin) {
    throw createError(
      "TikTok redirect URI must use the configured HTTPS public origin.",
      "TIKTOK_REDIRECT_INVALID",
      500,
    );
  }

  return { clientKey, clientSecret, publicUrl, redirectUri, scopes };
}

export function base64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

export function createOAuthState() {
  return base64Url(crypto.randomBytes(32));
}

export function createPkcePair() {
  const verifier = base64Url(crypto.randomBytes(64)).slice(0, 96);
  const challenge = base64Url(
    crypto.createHash("sha256").update(verifier, "utf8").digest(),
  );
  return { verifier, challenge, method: "S256" };
}

export function timingSafeEqualText(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function oauthSigningSecret() {
  const value = String(
    process.env.SESSION_SECRET || process.env.TIKTOK_TOKEN_ENCRYPTION_KEY || "",
  );
  if (value.length < 24) {
    throw createError(
      "SESSION_SECRET is required for TikTok OAuth.",
      "SESSION_SECRET_MISSING",
      500,
    );
  }
  return value;
}

export function signOAuthSubject(userId, state) {
  const payload = `${String(userId)}.${String(state)}`;
  const signature = crypto
    .createHmac("sha256", oauthSigningSecret())
    .update(payload)
    .digest("base64url");
  return `${String(userId)}.${signature}`;
}

export function validateOAuthSubject(value, userId, state) {
  const [storedUserId, signature] = String(value || "").split(".");
  if (!storedUserId || !signature || storedUserId !== String(userId)) return false;
  return timingSafeEqualText(value, signOAuthSubject(userId, state));
}

function getEncryptionKey() {
  const raw = String(process.env.TIKTOK_TOKEN_ENCRYPTION_KEY || "").trim();
  if (!raw) {
    throw createError(
      "TikTok token encryption key is missing.",
      "TIKTOK_ENCRYPTION_KEY_MISSING",
      500,
    );
  }

  let key;
  if (/^[a-f0-9]{64}$/i.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    try {
      const candidate = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      if (candidate.length === 32) key = candidate;
    } catch {
      // Derive below.
    }
  }

  if (!key) {
    if (raw.length < 32) {
      throw createError(
        "TikTok token encryption key must contain at least 32 characters.",
        "TIKTOK_ENCRYPTION_KEY_INVALID",
        500,
      );
    }
    key = crypto.createHash("sha256").update(raw, "utf8").digest();
  }

  return key;
}

export function encryptTikTokToken(token) {
  const plaintext = String(token || "");
  if (!plaintext) throw createError("TikTok token is empty.", "TOKEN_EMPTY", 500);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1.${base64Url(iv)}.${base64Url(tag)}.${base64Url(ciphertext)}`;
}

export function decryptTikTokToken(value) {
  const [version, ivEncoded, tagEncoded, ciphertextEncoded] = String(value || "").split(".");
  if (version !== "v1" || !ivEncoded || !tagEncoded || !ciphertextEncoded) {
    throw createError("Stored TikTok token is invalid.", "TOKEN_DECRYPT_FAILED", 500);
  }
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      getEncryptionKey(),
      Buffer.from(ivEncoded, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextEncoded, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw createError("Stored TikTok token could not be decrypted.", "TOKEN_DECRYPT_FAILED", 500);
  }
}

export function requireTelegramUser(req) {
  const session = getSession(req);
  if (!session?.userId || !session?.user) {
    throw createError("Login with Telegram first.", "AUTH_REQUIRED", 401);
  }
  return {
    userId: String(session.userId),
    telegramId: String(session.telegramId || session.user?.id || ""),
    user: session.user,
  };
}


export function sanitizeHttpsUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString().slice(0, 2048) : "";
  } catch {
    return "";
  }
}

export function normalizeScopes(value) {
  const scopes = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((scope) => scope.trim());
  return [...new Set(scopes.filter(Boolean))].sort();
}

export function hasRequiredScopes(value) {
  const granted = new Set(normalizeScopes(value));
  return REQUIRED_TIKTOK_SCOPES.every((scope) => granted.has(scope));
}

export function normalizeTikTokError(payload, responseStatus = 500) {
  const errorBlock = payload?.error && typeof payload.error === "object" ? payload.error : payload;
  const upstreamCode = String(errorBlock?.code || errorBlock?.error || "tiktok_error");
  const logId = String(errorBlock?.log_id || "").slice(0, 160) || undefined;
  const statusMap = {
    access_token_invalid: 401,
    scope_not_authorized: 403,
    rate_limit_exceeded: 429,
    invalid_publish_id: 404,
    token_not_authorized_for_specified_publish_id: 403,
  };
  const safeStatus = statusMap[upstreamCode] || (responseStatus >= 400 && responseStatus < 600 ? responseStatus : 502);
  const messages = {
    access_token_invalid: "TikTok connection expired. Please reconnect.",
    scope_not_authorized: "TikTok permission is missing. Please reconnect and approve upload access.",
    rate_limit_exceeded: "TikTok rate limit reached. Please wait and try again.",
    invalid_publish_id: "TikTok upload was not found.",
    token_not_authorized_for_specified_publish_id: "This TikTok upload does not belong to the connected account.",
  };
  return createError(
    messages[upstreamCode] || "TikTok could not complete the request.",
    upstreamCode.toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
    safeStatus,
    logId,
  );
}

async function readTikTokResponse(response) {
  const payload = await response.json().catch(() => ({}));
  const embeddedError = payload?.error;
  const isEmbeddedFailure =
    embeddedError &&
    typeof embeddedError === "object" &&
    embeddedError.code &&
    embeddedError.code !== "ok";
  if (!response.ok || isEmbeddedFailure || payload?.error_description) {
    throw normalizeTikTokError(payload, response.status);
  }
  return payload;
}

async function fetchWithTimeout(url, options, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw createError("TikTok request timed out.", "TIKTOK_TIMEOUT", 504);
    }
    throw createError("TikTok service is temporarily unavailable.", "TIKTOK_NETWORK_ERROR", 502);
  } finally {
    clearTimeout(timeout);
  }
}

export async function callTikTokJson(url, { accessToken, body, method = "POST" }) {
  const response = await fetchWithTimeout(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return readTikTokResponse(response);
}

export async function exchangeAuthorizationCode({ code, codeVerifier }) {
  const config = getTikTokConfig();
  const response = await fetchWithTimeout(TIKTOK_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body: new URLSearchParams({
      client_key: config.clientKey,
      client_secret: config.clientSecret,
      code: String(code),
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
      code_verifier: String(codeVerifier),
    }),
  });
  return readTikTokResponse(response);
}

export async function revokeTikTokAccessToken(accessToken) {
  const config = getTikTokConfig();
  const response = await fetchWithTimeout(TIKTOK_REVOKE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body: new URLSearchParams({
      client_key: config.clientKey,
      client_secret: config.clientSecret,
      token: String(accessToken),
    }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw normalizeTikTokError(payload, response.status);
  }
  return true;
}

export async function fetchTikTokProfile(accessToken) {
  const response = await fetchWithTimeout(TIKTOK_USER_INFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const payload = await readTikTokResponse(response);
  const user = payload?.data?.user;
  if (!user?.open_id) {
    throw createError("TikTok profile response was incomplete.", "TIKTOK_PROFILE_INVALID", 502);
  }
  return {
    openId: String(user.open_id),
    displayName: String(user.display_name || "TikTok User").slice(0, 255),
    avatarUrl: sanitizeHttpsUrl(user.avatar_url),
  };
}

export function tokenExpiryDate(seconds, now = Date.now()) {
  const safeSeconds = Number(seconds);
  if (!Number.isFinite(safeSeconds) || safeSeconds <= 0) {
    throw createError("TikTok token expiry is invalid.", "TOKEN_EXPIRY_INVALID", 502);
  }
  return new Date(now + safeSeconds * 1000);
}

export async function refreshTikTokConnection(
  connection,
  {
    now = Date.now(),
    tokenFetcher = async ({ config, refreshToken }) => {
      const response = await fetchWithTimeout(TIKTOK_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Cache-Control": "no-cache",
        },
        body: new URLSearchParams({
          client_key: config.clientKey,
          client_secret: config.clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });
      return readTikTokResponse(response);
    },
    tokenUpdater = updateTikTokConnectionTokens,
  } = {},
) {
  if (!connection) throw createError("TikTok is not connected.", "TIKTOK_NOT_CONNECTED", 409);

  const accessExpiry = new Date(connection.access_token_expires_at).getTime();
  if (Number.isFinite(accessExpiry) && accessExpiry > now + ACCESS_REFRESH_SKEW_MS) {
    return {
      connection,
      accessToken: decryptTikTokToken(connection.encrypted_access_token),
      refreshed: false,
    };
  }

  const refreshExpiry = new Date(connection.refresh_token_expires_at).getTime();
  if (!Number.isFinite(refreshExpiry) || refreshExpiry <= now) {
    throw createError("TikTok connection expired. Please reconnect.", "TIKTOK_RECONNECT_REQUIRED", 401);
  }

  const config = getTikTokConfig();
  const refreshToken = decryptTikTokToken(connection.encrypted_refresh_token);
  const tokenData = await tokenFetcher({ config, refreshToken, connection });
  if (!tokenData?.access_token) {
    throw createError("TikTok refresh response was incomplete.", "TIKTOK_TOKEN_REFRESH_INVALID", 502);
  }
  if (!hasRequiredScopes(tokenData.scope)) {
    throw createError("TikTok upload permission is missing. Please reconnect.", "TIKTOK_SCOPE_MISSING", 403);
  }
  if (tokenData.open_id && String(tokenData.open_id) !== String(connection.open_id)) {
    throw createError("TikTok account identity changed. Please reconnect.", "TIKTOK_IDENTITY_MISMATCH", 401);
  }

  const updated = await tokenUpdater({
    userId: connection.user_key,
    openId: tokenData.open_id || connection.open_id,
    grantedScopes: normalizeScopes(tokenData.scope).join(","),
    encryptedAccessToken: encryptTikTokToken(tokenData.access_token),
    encryptedRefreshToken: encryptTikTokToken(tokenData.refresh_token || refreshToken),
    accessTokenExpiresAt: tokenExpiryDate(tokenData.expires_in, now),
    refreshTokenExpiresAt: tokenData.refresh_expires_in
      ? tokenExpiryDate(tokenData.refresh_expires_in, now)
      : new Date(connection.refresh_token_expires_at),
  });
  if (!updated) {
    throw createError("TikTok connection could not be updated.", "TIKTOK_CONNECTION_UPDATE_FAILED", 500);
  }
  return { connection: updated, accessToken: tokenData.access_token, refreshed: true };
}

export async function getActiveTikTokConnection(userId) {
  const connection = await getTikTokConnection(userId);
  if (!connection) throw createError("TikTok is not connected.", "TIKTOK_NOT_CONNECTED", 409);
  return refreshTikTokConnection(connection);
}

export async function refreshConnectionProfile(userId, accessToken) {
  const profile = await fetchTikTokProfile(accessToken);
  const connection = await updateTikTokConnectionProfile({
    userId,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
  });
  return { profile, connection };
}

export function sanitizeFilename(value) {
  const filename = String(value || "").trim();
  if (!filename || filename.length > 255 || /[\0\r\n]/.test(filename)) {
    throw createError("Invalid video filename.", "INVALID_FILENAME", 400);
  }
  return filename.replace(/[\\/]+/g, "_");
}

export function validateUploadInitInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw createError("Invalid upload metadata.", "INVALID_UPLOAD_METADATA", 400);
  }
  const allowedKeys = new Set(["filename", "fileSize", "mimeType"]);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw createError("Unexpected upload metadata field.", "INVALID_UPLOAD_METADATA", 400);
    }
  }

  const filename = sanitizeFilename(input.filename);
  const fileSize = Number(input.fileSize);
  const mimeType = String(input.mimeType || "").toLowerCase().split(";", 1)[0];
  const allowedMimeTypes = new Set(["video/mp4", "video/quicktime", "video/webm"]);
  const allowedExtensions = new Set([".mp4", ".mov", ".webm"]);
  const extensionMatch = filename.toLowerCase().match(/\.[a-z0-9]+$/);

  if (!extensionMatch || !allowedExtensions.has(extensionMatch[0])) {
    throw createError("Video filename must end in .mp4, .mov, or .webm.", "INVALID_FILENAME", 400);
  }
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > MAX_TIKTOK_VIDEO_BYTES) {
    throw createError("Video size must be between 1 byte and 4 GB.", "INVALID_FILE_SIZE", 400);
  }
  if (!allowedMimeTypes.has(mimeType)) {
    throw createError("TikTok supports MP4, MOV, or WebM uploads.", "INVALID_MIME_TYPE", 400);
  }
  const mimeExtensions = {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
  };
  if (mimeExtensions[mimeType] !== extensionMatch[0]) {
    throw createError("Video filename and MIME type do not match.", "MIME_EXTENSION_MISMATCH", 400);
  }
  return { filename, fileSize, mimeType };
}

export function calculateTikTokChunkPlan(fileSize) {
  const totalBytes = Number(fileSize);
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_TIKTOK_VIDEO_BYTES) {
    throw createError("Invalid TikTok upload size.", "INVALID_FILE_SIZE", 400);
  }

  if (totalBytes < MIN_CHUNK_BYTES) {
    return {
      chunkSize: totalBytes,
      totalChunkCount: 1,
      chunks: [{ index: 0, start: 0, end: totalBytes - 1, size: totalBytes }],
    };
  }

  const preferredChunkSize = Math.min(PREFERRED_CHUNK_BYTES, MAX_CHUNK_BYTES, totalBytes);
  const totalChunkCount = Math.max(1, Math.floor(totalBytes / preferredChunkSize));
  const baseChunkSize = totalChunkCount === 1 ? totalBytes : preferredChunkSize;
  const chunks = [];
  let start = 0;

  for (let index = 0; index < totalChunkCount; index += 1) {
    const isFinal = index === totalChunkCount - 1;
    const endExclusive = isFinal ? totalBytes : start + baseChunkSize;
    chunks.push({
      index,
      start,
      end: endExclusive - 1,
      size: endExclusive - start,
    });
    start = endExclusive;
  }

  return { chunkSize: baseChunkSize, totalChunkCount, chunks };
}

export function publicTikTokAccount(connection, status = "connected") {
  if (!connection) return { connected: false, status: "disconnected" };
  return {
    connected: status === "connected",
    status,
    displayName: connection.display_name || "TikTok User",
    avatarUrl: sanitizeHttpsUrl(connection.avatar_url),
    scopes: normalizeScopes(connection.granted_scopes),
    accessTokenExpiresAt: new Date(connection.access_token_expires_at).getTime(),
    refreshTokenExpiresAt: new Date(connection.refresh_token_expires_at).getTime(),
  };
}

export function assertTikTokUploadOwnership(upload, userId, publishId) {
  if (
    !upload ||
    String(upload.user_key) !== String(userId) ||
    String(upload.publish_id) !== String(publishId)
  ) {
    throw createError(
      "TikTok upload was not found for this account.",
      "UPLOAD_NOT_OWNED",
      404,
    );
  }
  return upload;
}
