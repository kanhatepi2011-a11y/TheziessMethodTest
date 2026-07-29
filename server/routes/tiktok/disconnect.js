import { deleteTikTokConnection, getTikTokConnection } from "../_db.js";
import {
  decryptTikTokToken,
  requireTelegramUser,
  revokeTikTokAccessToken,
} from "../_tiktok.js";
import {
  readJsonBody,
  requireMethod,
  requireSameOrigin,
  sendApiError,
  setPrivateNoStore,
} from "../_http.js";

export default async function handler(req, res) {
  setPrivateNoStore(res);
  try {
    requireMethod(req, "POST");
    requireSameOrigin(req);
    await readJsonBody(req, 1024);
    const auth = requireTelegramUser(req);
    const connection = await getTikTokConnection(auth.userId);

    if (connection) {
      try {
        await revokeTikTokAccessToken(
          decryptTikTokToken(connection.encrypted_access_token),
        );
      } catch (error) {
        console.warn("TikTok revoke skipped", {
          code: error?.code || "TIKTOK_REVOKE_FAILED",
          message: error?.message || String(error),
        });
      }
      await deleteTikTokConnection(auth.userId);
    }

    return res.status(200).json({ ok: true, disconnected: true });
  } catch (error) {
    return sendApiError(res, error, "Unable to disconnect TikTok.");
  }
}
