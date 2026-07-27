import crypto from "node:crypto";

const COOKIE_NAME = "theziess_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

function getSessionSecret() {
  const value = process.env.SESSION_SECRET;

  if (!value || value.length < 24) {
    throw new Error(
      "SESSION_SECRET must be configured and contain at least 24 characters.",
    );
  }

  return value;
}

function sign(payload) {
  return crypto
    .createHmac("sha256", getSessionSecret())
    .update(payload)
    .digest("base64url");
}

export function parseCookies(cookieHeader = "") {
  const cookies = {};

  for (const part of cookieHeader.split(";")) {
    const item = part.trim();

    if (!item) continue;

    const separator = item.indexOf("=");

    if (separator === -1) continue;

    const key = decodeURIComponent(item.slice(0, separator));
    const value = decodeURIComponent(item.slice(separator + 1));

    cookies[key] = value;
  }

  return cookies;
}

export function encodeSession(data) {
  const payload = Buffer.from(
    JSON.stringify(data),
    "utf8",
  ).toString("base64url");

  return `${payload}.${sign(payload)}`;
}

export function decodeSession(token) {
  if (!token || typeof token !== "string") {
    return null;
  }

  const parts = token.split(".");

  if (parts.length !== 2) {
    return null;
  }

  const [payload, receivedSignature] = parts;
  const expectedSignature = sign(payload);

  const receivedBuffer = Buffer.from(receivedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (receivedBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
    return null;
  }

  try {
    return JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
  } catch {
    return null;
  }
}

export function getSession(req) {
  const cookies =
    req.cookies || parseCookies(req.headers?.cookie || "");

  return decodeSession(cookies[COOKIE_NAME]);
}

function secureCookieSuffix() {
  const isHttpsDeployment =
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL === "1" ||
    Boolean(process.env.VERCEL_ENV);

  return isHttpsDeployment ? "; Secure; Priority=High" : "";
}

export function createSessionCookie(session) {
  return [
    `${COOKIE_NAME}=${encodeSession(session)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${MAX_AGE_SECONDS}`,
  ].join("; ") + secureCookieSuffix();
}

export function createClearSessionCookie() {
  return [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ") + secureCookieSuffix();
}

export function createClearCookie(name) {
  return [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ") + secureCookieSuffix();
}

export function appendCookies(res, cookies) {
  const validCookies = cookies.filter(
    (cookie) => typeof cookie === "string" && cookie.length > 0,
  );

  if (!validCookies.length) return;

  const existingCookies = res.getHeader("Set-Cookie");

  if (!existingCookies) {
    res.setHeader("Set-Cookie", validCookies);
    return;
  }

  res.setHeader("Set-Cookie", [
    ...(Array.isArray(existingCookies)
      ? existingCookies
      : [String(existingCookies)]),
    ...validCookies,
  ]);
}

export function setSessionCookie(res, session) {
  appendCookies(res, [
    createSessionCookie(session),
  ]);
}

export function clearSessionCookie(res) {
  appendCookies(res, [
    createClearSessionCookie(),
  ]);
}

export function publicSession(session) {
  if (!session?.user) {
    return {
      authenticated: false,
      user: null,
      subscription: null,
    };
  }

  const subscription = session.subscription || null;

  const isActive = Boolean(
    subscription &&
      subscription.status === "active" &&
      (
        subscription.planId === "max" ||
        Number(subscription.expiresAt) > Date.now()
      ),
  );

  return {
    authenticated: true,
    user: session.user,
    subscription: isActive
      ? subscription
      : null,
  };
}