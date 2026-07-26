import crypto from "node:crypto";

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const clientId =
    process.env.TELEGRAM_CLIENT_ID;

  const redirectUri =
    process.env.TELEGRAM_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).json({
      error:
        "TELEGRAM_CLIENT_ID or TELEGRAM_REDIRECT_URI is missing.",
    });
  }

  const state = base64Url(
    crypto.randomBytes(32),
  );

  const verifier = base64Url(
    crypto.randomBytes(48),
  );

  const challenge = base64Url(
    crypto
      .createHash("sha256")
      .update(verifier)
      .digest(),
  );

  const secure =
    process.env.NODE_ENV === "production"
      ? "; Secure"
      : "";

  res.setHeader("Cache-Control", "no-store");

  res.setHeader("Set-Cookie", [
    [
      `telegram_oauth_state=${state}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=600",
    ].join("; ") + secure,

    [
      `telegram_pkce_verifier=${verifier}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=600",
    ].join("; ") + secure,
  ]);

  const authorizationUrl = new URL(
    "https://oauth.telegram.org/auth",
  );

  authorizationUrl.searchParams.set(
    "client_id",
    clientId,
  );

  authorizationUrl.searchParams.set(
    "redirect_uri",
    redirectUri,
  );

  authorizationUrl.searchParams.set(
    "response_type",
    "code",
  );

  authorizationUrl.searchParams.set(
    "scope",
    "openid profile",
  );

  authorizationUrl.searchParams.set(
    "state",
    state,
  );

  authorizationUrl.searchParams.set(
    "code_challenge",
    challenge,
  );

  authorizationUrl.searchParams.set(
    "code_challenge_method",
    "S256",
  );

  return res.redirect(
    302,
    authorizationUrl.toString(),
  );
}