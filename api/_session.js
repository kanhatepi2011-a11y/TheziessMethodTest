import crypto from "node:crypto";

const COOKIE_NAME = "theziess_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 24) {
    throw new Error("SESSION_SECRET must be configured and at least 24 characters long.");
  }
  return value;
}

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function sign(payload) {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function encodeSession(data) {
  const payload = b64url(JSON.stringify(data));
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(token) {
  if (!token || typeof token !== "string") return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function getSession(req) {
  return decodeSession(req.cookies?.[COOKIE_NAME]);
}

export function setSessionCookie(res, session) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeSession(session)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SECONDS}${secure}`,
  );
}

export function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
}

export function publicSession(session) {
  if (!session?.user) return { authenticated: false, user: null, subscription: null };
  const subscription = session.subscription || null;
  const active = Boolean(
    subscription &&
      (subscription.planId === "max" || Number(subscription.expiresAt) > Date.now()),
  );
  return {
    authenticated: true,
    user: session.user,
    subscription: active ? subscription : null,
  };
}
