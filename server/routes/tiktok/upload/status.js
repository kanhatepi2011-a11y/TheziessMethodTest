import {
  getTikTokUploadForUser,
  updateTikTokUploadStatus,
} from "../../_db.js";
import {
  TIKTOK_UPLOAD_STATUS_URL,
  assertTikTokUploadOwnership,
  callTikTokJson,
  getActiveTikTokConnection,
  requireTelegramUser,
} from "../../_tiktok.js";
import {
  readJsonBody,
  requireMethod,
  requireSameOrigin,
  sendApiError,
  setPrivateNoStore,
} from "../../_http.js";

const TERMINAL_SUCCESS = new Set(["SEND_TO_USER_INBOX", "PUBLISH_COMPLETE"]);
const TERMINAL_FAILURE = new Set(["FAILED"]);

function normalizeStatus(data, errorBlock) {
  const status = String(data?.status || "UNKNOWN");
  const failReason = String(data?.fail_reason || "").slice(0, 120) || null;
  const uploadedBytes = Number(data?.uploaded_bytes || 0);
  const terminal = TERMINAL_SUCCESS.has(status) || TERMINAL_FAILURE.has(status);
  const success = TERMINAL_SUCCESS.has(status);
  const messages = {
    PROCESSING_UPLOAD: "TikTok is receiving and processing the video.",
    PROCESSING_DOWNLOAD: "TikTok is processing the video.",
    SEND_TO_USER_INBOX: "Upload complete. The draft notification was sent to your TikTok Inbox.",
    PUBLISH_COMPLETE: "The TikTok draft flow was completed.",
    FAILED: "TikTok could not process this upload.",
  };
  return {
    status,
    stage: status,
    failReason,
    uploadedBytes: Number.isFinite(uploadedBytes) ? uploadedBytes : 0,
    terminal,
    success,
    message: messages[status] || "TikTok upload status is pending.",
    supportReference: String(errorBlock?.log_id || "").slice(0, 160) || undefined,
  };
}

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

    const { accessToken } = await getActiveTikTokConnection(auth.userId);
    const payload = await callTikTokJson(TIKTOK_UPLOAD_STATUS_URL, {
      accessToken,
      body: { publish_id: publishId },
    });
    const normalized = normalizeStatus(payload?.data, payload?.error);

    await updateTikTokUploadStatus({
      userId: auth.userId,
      publishId,
      status: normalized.status,
      errorCode: normalized.failReason,
      supportLogId: normalized.supportReference,
      uploadedBytes: normalized.uploadedBytes,
      completed: normalized.terminal,
    });

    return res.status(200).json({ ok: true, ...normalized });
  } catch (error) {
    return sendApiError(res, error, "Unable to check TikTok upload status.");
  }
}

export { normalizeStatus };
