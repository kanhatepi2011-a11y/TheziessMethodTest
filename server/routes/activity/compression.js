import { recordCompressionEvent } from "../_db.js";
import { getSession } from "../_session.js";

function readJsonBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return {};
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Cache-Control", "private, no-store");

  try {
    const session = getSession(req);

    if (!session?.userId) {
      return res.status(401).json({
        error: "Please log in with Telegram first.",
      });
    }

    const body = readJsonBody(req);
    const event = await recordCompressionEvent({
      userId: session.userId,
      inputName: body.inputName,
      outputName: body.outputName,
      inputBytes: body.inputBytes,
      outputBytes: body.outputBytes,
      outputMime: body.outputMime,
    });

    return res.status(200).json({
      ok: true,
      eventId: String(event.id),
    });
  } catch (error) {
    console.error("Compression activity save failed:", {
      message: error?.message,
      code: error?.code,
    });

    return res.status(error?.code === "USER_NOT_FOUND" ? 401 : 500).json({
      error: "Unable to save compression activity.",
      code: error?.code || "COMPRESSION_ACTIVITY_FAILED",
    });
  }
}
