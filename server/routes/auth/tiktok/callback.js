import { saveTikTokConnection } from "../../_db.js";
import { parseCookies } from "../../_session.js";
import {
  encryptTikTokToken,
  exchangeAuthorizationCode,
  fetchTikTokProfile,
  getTikTokConfig,
  hasRequiredScopes,
  normalizeScopes,
  requireTelegramUser,
  revokeTikTokAccessToken,
  timingSafeEqualText,
  tokenExpiryDate,
  validateOAuthSubject,
} from "../../_tiktok.js";
import { requireMethod, setPrivateNoStore } from "../../_http.js";

const COOKIE_PATH = "/api/auth/tiktok";

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function clearCookie(name) {
  const secure =
    process.env.NODE_ENV === "production" || process.env.VERCEL === "1" || process.env.VERCEL_ENV
      ? "; Secure; Priority=High"
      : "";
  return `${name}=; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function redirectHome(res, result) {
  res.setHeader("Set-Cookie", [
    clearCookie("tiktok_oauth_state"),
    clearCookie("tiktok_pkce_verifier"),
    clearCookie("tiktok_oauth_subject"),
  ]);
  return res.redirect(302, result === "connected" ? "/?tiktok=connected" : "/?tiktok=error");
}

export default async function handler(req, res) {
  setPrivateNoStore(res);
  let issuedAccessToken = null;

  try {
    requireMethod(req, "GET");
    const auth = requireTelegramUser(req);
    getTikTokConfig();

    if (first(req.query?.error)) {
      return redirectHome(res, "error");
    }

    const code = String(first(req.query?.code) || "");
    const returnedState = String(first(req.query?.state) || "");
    const cookies = req.cookies || parseCookies(req.headers?.cookie || "");
    const savedState = String(cookies.tiktok_oauth_state || "");
    const verifier = String(cookies.tiktok_pkce_verifier || "");
    const subject = String(cookies.tiktok_oauth_subject || "");

    if (!code || !returnedState || !savedState || !verifier || !subject) {
      throw Object.assign(new Error("TikTok authorization session expired."), {
        code: "TIKTOK_OAUTH_EXPIRED",
        statusCode: 400,
      });
    }

    if (!timingSafeEqualText(returnedState, savedState)) {
      throw Object.assign(new Error("Invalid TikTok OAuth state."), {
        code: "TIKTOK_STATE_INVALID",
        statusCode: 400,
      });
    }

    if (!validateOAuthSubject(subject, auth.userId, savedState)) {
      throw Object.assign(new Error("TikTok OAuth user mismatch."), {
        code: "TIKTOK_SUBJECT_MISMATCH",
        statusCode: 403,
      });
    }

    const tokenData = await exchangeAuthorizationCode({ code, codeVerifier: verifier });
    issuedAccessToken = tokenData.access_token;

    if (!tokenData.access_token || !tokenData.refresh_token || !tokenData.open_id) {
      throw Object.assign(new Error("TikTok token response was incomplete."), {
        code: "TIKTOK_TOKEN_INVALID",
        statusCode: 502,
      });
    }

    if (!hasRequiredScopes(tokenData.scope)) {
      await revokeTikTokAccessToken(tokenData.access_token).catch(() => {});
      throw Object.assign(new Error("Required TikTok permissions were not approved."), {
        code: "TIKTOK_SCOPE_MISSING",
        statusCode: 403,
      });
    }

    const profile = await fetchTikTokProfile(tokenData.access_token);
    if (profile.openId !== String(tokenData.open_id)) {
      throw Object.assign(new Error("TikTok account identity mismatch."), {
        code: "TIKTOK_IDENTITY_MISMATCH",
        statusCode: 502,
      });
    }

    await saveTikTokConnection({
      userId: auth.userId,
      openId: profile.openId,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      grantedScopes: normalizeScopes(tokenData.scope).join(","),
      encryptedAccessToken: encryptTikTokToken(tokenData.access_token),
      encryptedRefreshToken: encryptTikTokToken(tokenData.refresh_token),
      accessTokenExpiresAt: tokenExpiryDate(tokenData.expires_in),
      refreshTokenExpiresAt: tokenExpiryDate(tokenData.refresh_expires_in),
    });

    issuedAccessToken = null;
    return redirectHome(res, "connected");
  } catch (error) {
    if (issuedAccessToken) {
      await revokeTikTokAccessToken(issuedAccessToken).catch(() => {});
    }
    console.error("TikTok OAuth callback failed", {
      code: error?.code || "TIKTOK_CALLBACK_ERROR",
      message: error?.message || String(error),
    });
    return redirectHome(res, "error");
  }
}
