function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0] || "";
  return String(value || "").split(",")[0].trim();
}

export function getRequestOrigin(req) {
  const forwardedProto = firstHeaderValue(
    req.headers?.["x-forwarded-proto"],
  );

  const forwardedHost = firstHeaderValue(
    req.headers?.["x-forwarded-host"],
  );

  const host =
    forwardedHost ||
    firstHeaderValue(req.headers?.host);

  if (!host) {
    throw new Error(
      "Unable to determine the public application host.",
    );
  }

  const protocol =
    forwardedProto ||
    (process.env.NODE_ENV === "production"
      ? "https"
      : "http");

  return `${protocol}://${host}`;
}

export function getTelegramRedirectUri(req) {
  const configured = String(
    process.env.TELEGRAM_REDIRECT_URI || "",
  ).trim();

  if (configured) {
    return configured;
  }

  return `${getRequestOrigin(req)}/api/auth/telegram/callback`;
}
