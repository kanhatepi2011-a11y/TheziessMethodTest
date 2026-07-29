import {
  countRecentTikTokUploadInits,
  createTikTokUpload,
  findActiveTikTokUpload,
} from "../../_db.js";
import {
  TIKTOK_UPLOAD_INIT_URL,
  calculateTikTokChunkPlan,
  callTikTokJson,
  getActiveTikTokConnection,
  requireTelegramUser,
  validateUploadInitInput,
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
    const input = validateUploadInitInput(await readJsonBody(req, 4096));
    const auth = requireTelegramUser(req);

    const activeUpload = await findActiveTikTokUpload(auth.userId);
    if (activeUpload) {
      const error = new Error("Finish or cancel the current TikTok upload before starting another.");
      error.code = "TIKTOK_UPLOAD_ALREADY_ACTIVE";
      error.statusCode = 409;
      throw error;
    }

    const recentCount = await countRecentTikTokUploadInits(auth.userId, 60);
    if (recentCount >= 5) {
      const error = new Error("Too many TikTok upload attempts. Please wait one minute.");
      error.code = "TIKTOK_UPLOAD_RATE_LIMIT";
      error.statusCode = 429;
      throw error;
    }

    const { accessToken } = await getActiveTikTokConnection(auth.userId);
    const chunkPlan = calculateTikTokChunkPlan(input.fileSize);
    const payload = await callTikTokJson(TIKTOK_UPLOAD_INIT_URL, {
      accessToken,
      body: {
        source_info: {
          source: "FILE_UPLOAD",
          video_size: input.fileSize,
          chunk_size: chunkPlan.chunkSize,
          total_chunk_count: chunkPlan.totalChunkCount,
        },
      },
    });

    const publishId = String(payload?.data?.publish_id || "");
    const uploadUrl = String(payload?.data?.upload_url || "");
    if (!publishId || !uploadUrl || !uploadUrl.startsWith("https://")) {
      const error = new Error("TikTok returned an invalid upload session.");
      error.code = "TIKTOK_UPLOAD_SESSION_INVALID";
      error.statusCode = 502;
      throw error;
    }

    await createTikTokUpload({
      userId: auth.userId,
      publishId,
      filename: input.filename,
      byteSize: input.fileSize,
      mimeType: input.mimeType,
    });

    return res.status(200).json({
      ok: true,
      publishId,
      uploadUrl,
      chunkPlan,
    });
  } catch (error) {
    return sendApiError(res, error, "Unable to initialize TikTok upload.");
  }
}
