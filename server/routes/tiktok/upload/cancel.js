import {
  getTikTokUploadForUser,
  updateTikTokUploadStatus,
} from "../../_db.js";
import {
  assertTikTokUploadOwnership,
  requireTelegramUser,
} from "../../_tiktok.js";
import {
  readJsonBody,
  requireMethod,
  requireSameOrigin,
  sendApiError,
  setPrivateNoStore,
} from "../../_http.js";

export default async function handler(req, res) {
  setPrivateNoStore(res);
  try {
    requireMethod(req, "POST");
    requireSameOrigin(req);
    const body = await readJsonBody(req, 2048);
    const publishId = String(body?.publishId || "").trim();
    if (!publishId || publishId.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(publishId)) {
      const error = new Error("Invalid TikTok publish ID.");
      error.code = "INVALID_PUBLISH_ID";
      error.statusCode = 400;
      throw error;
    }

    const auth = requireTelegramUser(req);
    const upload = await getTikTokUploadForUser(auth.userId, publishId);
    assertTikTokUploadOwnership(upload, auth.userId, publishId);

    await updateTikTokUploadStatus({
      userId: auth.userId,
      publishId,
      status: "CANCELLED",
      errorCode: "CLIENT_CANCELLED",
      uploadedBytes: Number(upload.uploaded_bytes || 0),
      completed: true,
    });

    return res.status(200).json({ ok: true, status: "CANCELLED" });
  } catch (error) {
    return sendApiError(res, error, "Unable to cancel TikTok upload.");
  }
}
