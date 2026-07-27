function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0] || "";
  return String(value || "").split(",")[0].trim();
}

function normalizeOrigin(value) {
  const candidate = String(value || "").trim();
  if (!candidate) return "";

  const withProtocol = /^https?:\/\//i.test(candidate)
    ? candidate
    : `https://${candidate}`;

  const url = new URL(withProtocol);
  return url.origin;
}

export function getRequestOrigin(req) {
  const forwardedProto = firstHeaderValue(
    req.headers?.["x-forwarded-proto"],
  );

  const forwardedHost = firstHeaderValue(
    req.headers?.["x-forwarded-host"],
  );

  const host = forwardedHost || firstHeaderValue(req.headers?.host);

  if (!host) {
    throw new Error("Unable to determine the public application host.");
  }

  const protocol =
    forwardedProto ||
    (process.env.NODE_ENV === "production" ? "https" : "http");

  return `${protocol}://${host}`;
}

/**
 * Prefer an explicitly configured production URL. On Vercel, use the stable
 * production project URL instead of a temporary preview deployment URL.
 */
export function getPublicAppOrigin(req) {
  const configured =
    process.env.TELEGRAM_PUBLIC_URL ||
    process.env.PUBLIC_APP_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    "";

  if (configured) return normalizeOrigin(configured);
  return getRequestOrigin(req);
}

export function getTelegramRedirectUri(req) {
  const configured = String(process.env.TELEGRAM_REDIRECT_URI || "").trim();

  if (configured) return configured;
  return `${getRequestOrigin(req)}/api/auth/telegram/callback`;
}

export function getHeaderValue(req, name) {
  return firstHeaderValue(req.headers?.[String(name).toLowerCase()]);
}
