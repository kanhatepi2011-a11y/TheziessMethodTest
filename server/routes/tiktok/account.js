import { getTikTokConnection } from "../_db.js";
import {
  getActiveTikTokConnection,
  publicTikTokAccount,
  refreshConnectionProfile,
  requireTelegramUser,
} from "../_tiktok.js";
import { requireMethod, sendApiError, setPrivateNoStore } from "../_http.js";

export default async function handler(req, res) {
  setPrivateNoStore(res);
  try {
    requireMethod(req, "GET");
    const auth = requireTelegramUser(req);
    const stored = await getTikTokConnection(auth.userId);
    if (!stored) {
      return res.status(200).json({ ok: true, account: publicTikTokAccount(null) });
    }

    try {
      const active = await getActiveTikTokConnection(auth.userId);
      let connection = active.connection;
      if (active.refreshed || !connection.display_name) {
        const refreshedProfile = await refreshConnectionProfile(auth.userId, active.accessToken);
        connection = refreshedProfile.connection || connection;
      }
      return res.status(200).json({ ok: true, account: publicTikTokAccount(connection) });
    } catch (error) {
      if (["TIKTOK_RECONNECT_REQUIRED", "ACCESS_TOKEN_INVALID", "TIKTOK_SCOPE_MISSING", "TIKTOK_IDENTITY_MISMATCH"].includes(error?.code)) {
        return res.status(200).json({
          ok: true,
          account: publicTikTokAccount(stored, "expired"),
        });
      }
      throw error;
    }
  } catch (error) {
    return sendApiError(res, error, "Unable to read TikTok connection.");
  }
}
