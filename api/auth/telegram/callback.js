import { createRemoteJWKSet, jwtVerify } from "jose";
import { upsertTelegramUser } from "../../_db.js";
import { setSessionCookie } from "../../_session.js";

function parseCookies(header = "") {
  const result = {};

  for (const part of header.split(";")) {
    const item = part.trim();
    if (!item) continue;

    const separator = item.indexOf("=");
    if (separator === -1) continue;

    const key = decodeURIComponent(item.slice(0, separator));
    const value = decodeURIComponent(item.slice(separator + 1));
    result[key] = value;
  }

  return result;
}

function clearOAuthCookies(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";

  res.setHeader("Set-Cookie", [
    `telegram_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
    `telegram_pkce_verifier=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  ]);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const code = Array.isArray(req.query.code)
      ? req.query.code[0]
      : req.query.code;

    const returnedState = Array.isArray(req.query.state)
      ? req.query.state[0]
      : req.query.state;

    const oauthError = Array.isArray(req.query.error)
      ? req.query.error[0]
      : req.query.error;

    if (oauthError) {
      return res
        .status(400)
        .send(`Telegram authorization failed: ${oauthError}`);
    }

    if (!code || !returnedState) {
      return res.status(400).send("Missing Telegram code or state.");
    }

    const cookies = parseCookies(req.headers.cookie || "");
    const savedState = cookies.telegram_oauth_state;
    const verifier = cookies.telegram_pkce_verifier;

    if (!savedState || returnedState !== savedState) {
      return res.status(400).send("Invalid Telegram OAuth state.");
    }

    if (!verifier) {
      return res.status(400).send("Missing Telegram PKCE verifier.");
    }

    const clientId = process.env.TELEGRAM_CLIENT_ID;
    const clientSecret = process.env.TELEGRAM_CLIENT_SECRET;
    const redirectUri = process.env.TELEGRAM_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(500).send("Telegram OIDC configuration is incomplete.");
    }

    const basicAuthorization = Buffer.from(
      `${clientId}:${clientSecret}`,
    ).toString("base64");

    const tokenResponse = await fetch("https://oauth.telegram.org/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuthorization}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.id_token) {
      console.error("Telegram token response:", tokenData);

      return res.status(400).json({
        error: "Telegram token exchange failed",
        details: tokenData,
      });
    }

    const jwks = createRemoteJWKSet(
      new URL("https://oauth.telegram.org/.well-known/jwks.json"),
    );

    const { payload } = await jwtVerify(tokenData.id_token, jwks, {
      issuer: "https://oauth.telegram.org",
      audience: String(clientId),
    });

    const telegramId = payload.id || payload.sub;

    if (!telegramId) {
      return res.status(400).send("Telegram user ID is missing.");
    }

    const fullName = typeof payload.name === "string" ? payload.name : "";
    const nameParts = fullName.trim().split(/\s+/);

    const telegramUser = {
      id: String(telegramId),
      username:
        typeof payload.preferred_username === "string"
          ? payload.preferred_username
          : "",
      first_name:
        typeof payload.given_name === "string"
          ? payload.given_name
          : nameParts[0] || "Telegram user",
      last_name:
        typeof payload.family_name === "string"
          ? payload.family_name
          : nameParts.slice(1).join(" "),
      photo_url:
        typeof payload.picture === "string" ? payload.picture : "",
    };

    const dbUser = await upsertTelegramUser(telegramUser);

    setSessionCookie(res, {
      userId: String(dbUser.id),
      telegramId: String(dbUser.telegram_id),
      issuedAt: Date.now(),
    });

    clearOAuthCookies(res);

    return res.redirect(302, "/?telegram_login=success");
  } catch (error) {
    console.error("Telegram OIDC callback error:", error);

    return res.status(500).send(
      "Telegram login failed. Check Client ID, Client Secret, redirect URI and database connection.",
    );
  }
}