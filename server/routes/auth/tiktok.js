import {
  TIKTOK_AUTHORIZE_URL,
  createOAuthState,
  createPkcePair,
  getTikTokConfig,
  requireTelegramUser,
  signOAuthSubject,
} from "../_tiktok.js";
import { requireMethod, sendApiError, setPrivateNoStore } from "../_http.js";

const COOKIE_PATH = "/api/auth/tiktok";

function cookie(name, value, maxAge = 600) {
  const secure =
    process.env.NODE_ENV === "production" || process.env.VERCEL === "1" || process.env.VERCEL_ENV
      ? "; Secure; Priority=High"
      : "";
  return `${name}=${encodeURIComponent(value)}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export default async function handler(req, res) {
  setPrivateNoStore(res);
  try {
    requireMethod(req, "GET");
    const auth = requireTelegramUser(req);
    const config = getTikTokConfig();
    const state = createOAuthState();
    const pkce = createPkcePair();
    const subject = signOAuthSubject(auth.userId, state);

    res.setHeader("Set-Cookie", [
      cookie("tiktok_oauth_state", state),
      cookie("tiktok_pkce_verifier", pkce.verifier),
      cookie("tiktok_oauth_subject", subject),
    ]);

    const authorizationUrl = new URL(TIKTOK_AUTHORIZE_URL);
    authorizationUrl.searchParams.set("client_key", config.clientKey);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", config.scopes.join(","));
    authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", pkce.challenge);
    authorizationUrl.searchParams.set("code_challenge_method", pkce.method);

    return res.redirect(302, authorizationUrl.toString());
  } catch (error) {
    return sendApiError(res, error, "Unable to start TikTok connection.");
  }
}
