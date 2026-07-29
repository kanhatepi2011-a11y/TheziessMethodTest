import {
  createRemoteJWKSet,
  jwtVerify,
} from "jose";

import {
  upsertTelegramUser,
} from "../../_db.js";

import {
  getTelegramRedirectUri,
} from "../../_telegram.js";

import {
  appendCookies,
  createClearCookie,
  createSessionCookie,
  parseCookies,
} from "../../_session.js";

import {
  notifyAdminsOfTelegramLogin,
} from "../../_login-alert.js";

function firstQueryValue(value) {
  return Array.isArray(value)
    ? value[0]
    : value;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  res.setHeader("Cache-Control", "no-store");

  try {
    const code = firstQueryValue(
      req.query.code,
    );

    const returnedState = firstQueryValue(
      req.query.state,
    );

    const oauthError = firstQueryValue(
      req.query.error,
    );

    const oauthDescription = firstQueryValue(
      req.query.error_description,
    );

    if (oauthError) {
      return res.status(400).send(
        `Telegram authorization failed: ${
          oauthDescription || oauthError
        }`,
      );
    }

    if (!code || !returnedState) {
      return res.status(400).send(
        "Missing Telegram authorization code or state.",
      );
    }

    const cookies = parseCookies(
      req.headers.cookie || "",
    );

    const savedState =
      cookies.telegram_oauth_state;

    const verifier =
      cookies.telegram_pkce_verifier;

    if (
      !savedState ||
      returnedState !== savedState
    ) {
      return res.status(400).send(
        "Invalid Telegram OAuth state. Please restart login.",
      );
    }

    if (!verifier) {
      return res.status(400).send(
        "Missing Telegram PKCE verifier. Please restart login.",
      );
    }

    const clientId =
      process.env.TELEGRAM_CLIENT_ID;

    const clientSecret =
      process.env.TELEGRAM_CLIENT_SECRET;

    const redirectUri =
      getTelegramRedirectUri(req);

    if (
      !clientId ||
      !clientSecret
    ) {
      return res.status(500).send(
        "Telegram OIDC configuration is incomplete.",
      );
    }

    const basicAuthorization =
      Buffer.from(
        `${clientId}:${clientSecret}`,
      ).toString("base64");

    const tokenResponse = await fetch(
      "https://oauth.telegram.org/token",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",

          Authorization:
            `Basic ${basicAuthorization}`,
        },

        body: new URLSearchParams({
          grant_type:
            "authorization_code",

          code,

          redirect_uri:
            redirectUri,

          client_id:
            clientId,

          code_verifier:
            verifier,
        }),
      },
    );

    const tokenData =
      await tokenResponse.json();

    if (
      !tokenResponse.ok ||
      !tokenData.id_token
    ) {
      console.error(
        "Telegram token response:",
        tokenData,
      );

      return res.status(400).json({
        error:
          "Telegram token exchange failed.",

        details:
          tokenData,
      });
    }

    const telegramJwks =
      createRemoteJWKSet(
        new URL(
          "https://oauth.telegram.org/.well-known/jwks.json",
        ),
      );

    const verification =
      await jwtVerify(
        tokenData.id_token,
        telegramJwks,
        {
          issuer:
            "https://oauth.telegram.org",

          audience:
            String(clientId),
        },
      );

    const payload =
      verification.payload;

    const telegramId =
      payload.sub ||
      payload.id;

    if (!telegramId) {
      return res.status(400).send(
        "Telegram user ID is missing.",
      );
    }

    const fullName =
      typeof payload.name === "string"
        ? payload.name.trim()
        : "";

    const nameParts =
      fullName
        ? fullName.split(/\s+/)
        : [];

    const telegramUser = {
      id:
        String(telegramId),

      username:
        typeof payload.preferred_username ===
        "string"
          ? payload.preferred_username
          : "",

      first_name:
        typeof payload.given_name ===
        "string"
          ? payload.given_name
          : nameParts[0] ||
            "Telegram User",

      last_name:
        typeof payload.family_name ===
        "string"
          ? payload.family_name
          : nameParts.slice(1).join(" "),

      photo_url:
        typeof payload.picture ===
        "string"
          ? payload.picture
          : "",
    };

    const databaseUser =
      await upsertTelegramUser(
        telegramUser,
      );

    const session = {
      userId:
        String(databaseUser.id),

      telegramId:
        String(databaseUser.telegram_id),

      user: {
        id:
          String(
            databaseUser.telegram_id,
          ),

        databaseId:
          String(databaseUser.id),

        first_name:
          databaseUser.first_name ||
          "",

        last_name:
          databaseUser.last_name ||
          "",

        username:
          databaseUser.username ||
          "",

        photo_url:
          databaseUser.photo_url ||
          "",
      },

      issuedAt:
        Date.now(),
    };

    appendCookies(res, [
      createSessionCookie(session),

      createClearCookie(
        "telegram_oauth_state",
      ),

      createClearCookie(
        "telegram_pkce_verifier",
      ),
    ]);

    // Alert configured Telegram admins after authentication succeeds.
    // Notification failures are isolated so users can always finish login.
    try {
      await notifyAdminsOfTelegramLogin({
        databaseUser,
        telegramUser,
      });
    } catch (alertError) {
      console.warn("Telegram login alert skipped:", {
        code: alertError?.code || "UNKNOWN",
        message: alertError?.message || String(alertError),
      });
    }

    // Save a browser-side copy of the public Telegram profile before
    // returning home. The signed HttpOnly cookie remains the real session,
    // while this safe fallback prevents a service-worker/browser cookie race
    // from leaving the UI permanently locked after a successful callback.
    const publicUserJson = JSON.stringify(session.user)
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");

    res.setHeader("Content-Type", "text/html; charset=utf-8");

    return res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Telegram login complete</title>
</head>
<body>
  <script>
    try {
      localStorage.setItem("theziess.telegram.user", JSON.stringify(${publicUserJson}));
      localStorage.setItem("theziess.telegram.connectedAt", String(Date.now()));
    } catch (error) {
      console.warn("Unable to save Telegram login fallback", error);
    }
    window.location.replace("/?telegram_login=success");
  </script>
  <p>Telegram login completed. Returning to the app…</p>
</body>
</html>`);
  } catch (error) {
    const errorCode = error?.code || "TELEGRAM_LOGIN_ERROR";

    console.error("Telegram OIDC callback error:", {
      code: errorCode,
      message: error?.message || String(error),
      stack: error?.stack,
    });

    // Clear one-time OAuth cookies so the next attempt starts cleanly.
    appendCookies(res, [
      createClearCookie("telegram_oauth_state"),
      createClearCookie("telegram_pkce_verifier"),
    ]);

    res.setHeader("Content-Type", "text/html; charset=utf-8");

    const safeErrorCode = String(errorCode).replace(/[^A-Z0-9_-]/gi, "");

    return res.status(500).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Telegram login failed</title>
</head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0717;color:#f5efff;font-family:system-ui,sans-serif">
  <main style="width:min(92vw,520px);padding:24px;border:1px solid #4b2a68;border-radius:18px;background:#160b25;text-align:center">
    <h1 style="font-size:22px;margin:0 0 10px">Telegram login could not finish</h1>
    <p style="color:#cdbfe0;line-height:1.6">Please return to the app and try one more time. Error code: <strong>${safeErrorCode}</strong></p>
    <a href="/?telegram_login=failed" style="display:inline-block;margin-top:10px;padding:12px 18px;border-radius:12px;background:linear-gradient(135deg,#7c3aed,#22d3ee);color:white;text-decoration:none;font-weight:800">Return to app</a>
  </main>
</body>
</html>`);
  }
}
