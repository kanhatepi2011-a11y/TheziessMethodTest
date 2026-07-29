function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

export function setPrivateNoStore(res) {
  res.setHeader(
    "Cache-Control",
    "private, no-store, no-cache, must-revalidate, max-age=0",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Vary", "Cookie, Origin");
}

export function requireMethod(req, allowed) {
  const methods = Array.isArray(allowed) ? allowed : [allowed];
  if (!methods.includes(req.method)) {
    const error = new Error("Method not allowed");
    error.statusCode = 405;
    error.code = "METHOD_NOT_ALLOWED";
    error.allow = methods.join(", ");
    throw error;
  }
}

export function requireJsonContentType(req) {
  const contentType = String(firstHeader(req.headers?.["content-type"]) || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    const error = new Error("Content-Type must be application/json.");
    error.statusCode = 415;
    error.code = "UNSUPPORTED_MEDIA_TYPE";
    throw error;
  }
}

export async function readJsonBody(req, maxBytes = 16_384) {
  requireJsonContentType(req);

  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    const size = Buffer.byteLength(JSON.stringify(req.body));
    if (size > maxBytes) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    return req.body;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(buffer);
  }

  if (!chunks.length) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON body.");
    error.statusCode = 400;
    error.code = "INVALID_JSON";
    throw error;
  }
}

function expectedOrigin(req) {
  const configured = String(process.env.TIKTOK_PUBLIC_URL || "").trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Fall back to the request host below.
    }
  }

  const forwardedProto = firstHeader(req.headers?.["x-forwarded-proto"]);
  const proto = forwardedProto || (process.env.NODE_ENV === "production" ? "https" : "http");
  const host = firstHeader(req.headers?.["x-forwarded-host"]) || firstHeader(req.headers?.host);
  return host ? `${proto}://${host}` : null;
}

export function requireSameOrigin(req) {
  const origin = firstHeader(req.headers?.origin);
  const target = expectedOrigin(req);

  if (!origin || !target) {
    const error = new Error("Missing same-origin request context.");
    error.statusCode = 403;
    error.code = "ORIGIN_REQUIRED";
    throw error;
  }

  let normalizedOrigin;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    const error = new Error("Invalid request origin.");
    error.statusCode = 403;
    error.code = "INVALID_ORIGIN";
    throw error;
  }

  if (normalizedOrigin !== target) {
    const localAllowed =
      process.env.NODE_ENV !== "production" &&
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalizedOrigin);

    if (!localAllowed) {
      const error = new Error("Cross-origin request rejected.");
      error.statusCode = 403;
      error.code = "ORIGIN_MISMATCH";
      throw error;
    }
  }
}

export function sendApiError(res, error, fallbackMessage = "Request failed.") {
  if (error?.allow) res.setHeader("Allow", error.allow);
  const status = Number(error?.statusCode || 500);
  const safeStatus = status >= 400 && status <= 599 ? status : 500;
  return res.status(safeStatus).json({
    ok: false,
    error: safeStatus >= 500 ? fallbackMessage : error?.message || fallbackMessage,
    code: String(error?.code || (safeStatus >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR")),
    supportReference: error?.supportReference || undefined,
  });
}
