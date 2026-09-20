/**
 * Firebase Cloud Function: Low Stock -> SeaTalk Bot Notification
 * -----------------------------------------------------------------
 * Trigger otomatis tiap ada perubahan data di:
 *   inventoryControl/{facility}/stock/{assetId}
 *
 * Kalau qty turun sampai <= minStock (dan sebelumnya belum dalam
 * kondisi menipis), function ini kirim pesan reminder ke SeaTalk
 * lewat bot "Santana" (App ID / App Secret disimpan sebagai
 * Firebase Secret, BUKAN hardcode di sini).
 *
 * Deploy:
 *   firebase deploy --only functions:notifyLowStock
 */

const { onValueWritten } = require("firebase-functions/v2/database");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const crypto = require("crypto");
const admin = require("firebase-admin");

admin.initializeApp({
  // GANTI dengan URL Realtime Database asli lo (Firebase Console > Realtime
  // Database > lihat di bagian atas halaman, biasanya format
  // https://<project-id>-default-rtdb.<region>.firebasedatabase.app)
  databaseURL: "https://GANTI-DENGAN-URL-RTDB-LO.firebasedatabase.app",
});

// Secrets diset lewat CLI, JANGAN pernah ditulis literal di file ini:
//   firebase functions:secrets:set SEATALK_APP_ID
//   firebase functions:secrets:set SEATALK_APP_SECRET
//   firebase functions:secrets:set SEATALK_TARGET_GROUP_ID
//   firebase functions:secrets:set SEATALK_SIGNING_SECRET
const SEATALK_APP_ID = defineSecret("SEATALK_APP_ID");
const SEATALK_APP_SECRET = defineSecret("SEATALK_APP_SECRET");
// group_id tujuan (grup SeaTalk tempat bot Santana sudah di-add).
// Cara dapetin group_id: undang bot ke grup, lalu cek event
// "new_mentioned_message_received" / "group chat" di Callback URL
// yang kemarin sudah di-setup -> body.event.group_id.
const SEATALK_TARGET_GROUP_ID = defineSecret("SEATALK_TARGET_GROUP_ID");
// Signing Secret dari halaman Callback URL Configuration (bukan App Secret).
const SEATALK_SIGNING_SECRET = defineSecret("SEATALK_SIGNING_SECRET");

const SEATALK_API_BASE = "https://openapi.seatalk.io";

/**
 * Ambil access_token bot dari App ID + App Secret.
 * Token ini yang dipakai buat panggil endpoint kirim pesan.
 */
async function getSeatalkAccessToken(appId, appSecret) {
  const res = await fetch(`${SEATALK_API_BASE}/auth/app_access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json();
  if (!data.app_access_token) {
    throw new Error("Gagal ambil access token SeaTalk: " + JSON.stringify(data));
  }
  return data.app_access_token;
}

/**
 * Kirim pesan teks ke grup SeaTalk lewat bot.
 * NOTE: endpoint persis (path/versi) kadang berubah di dokumentasi SeaTalk —
 * cross-check ke Open Platform docs project lo sebelum deploy ke production.
 */
async function sendSeatalkGroupMessage(accessToken, groupId, text) {
  const res = await fetch(`${SEATALK_API_BASE}/messaging/v2/group_chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      group_id: groupId,
      message: { tag: "text", text: { content: text } },
    }),
  });
  const data = await res.json();
  if (data.code && data.code !== 0) {
    logger.error("SeaTalk send group message error:", data);
  }
  return data;
}

/**
 * Kirim pesan teks private (1-on-1) ke satu employee lewat bot.
 */
async function sendSeatalkPrivateMessage(accessToken, employeeCode, text) {
  const res = await fetch(`${SEATALK_API_BASE}/messaging/v2/single_chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      employee_code: employeeCode,
      message: { tag: "text", text: { content: text } },
    }),
  });
  const data = await res.json();
  if (data.code && data.code !== 0) {
    logger.error("SeaTalk send private message error:", data);
  }
  return data;
}

/**
 * Verifikasi bahwa request beneran datang dari SeaTalk, bukan pihak luar,
 * pakai HMAC-SHA256 dari raw body + Signing Secret.
 * PENTING: kalau pas testing ternyata SeaTalk pakai skema lain (misal
 * signature dikirim polos di body, bukan HMAC di header), sesuaikan
 * fungsi ini dengan yang tertulis di halaman "Learn more" Event Callback.
 */
function isValidSeatalkSignature(rawBody, signatureHeader, signingSecret) {
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac("sha256", signingSecret)
    .update(rawBody)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signatureHeader)
    );
  } catch {
    return false;
  }
}

/**
 * Jawab pertanyaan seputar Stock di Inventory Control (path: inventoryControl/SOC/stock)
 * berdasarkan keyword sederhana. Gampang diperluas kalau mau tambah topik lain.
 */
async function answerInventoryQuestion(text) {
  const lower = text.toLowerCase();
  const snap = await admin.database().ref("inventoryControl/SOC/stock").get();
  const stock = snap.val() || {};
  const items = Object.values(stock);

  if (!items.length) {
    return "Belum ada data Stock di Inventory Control.";
  }

  // "stock consumable apa aja" / "consumable"
  if (lower.includes("consumable")) {
    const consumables = items.filter((it) =>
      (it.category || "").toLowerCase().includes("consumable")
    );
    if (!consumables.length) return "Gak ada Asset dengan kategori Consumable di Stock.";
    const lines = consumables.map((it) => `• ${it.name}: ${it.qty} ${it.unit || "pcs"}`);
    return `Stock Consumable saat ini:\n${lines.join("\n")}`;
  }

  // "stock menipis" / "low stock"
  if (lower.includes("menipis") || lower.includes("low stock")) {
    const low = items.filter((it) => Number(it.qty) <= Number(it.minStock ?? 0));
    if (!low.length) return "Gak ada Asset yang stock-nya menipis 👍";
    const lines = low.map(
      (it) => `• ${it.name}: sisa ${it.qty} ${it.unit || "pcs"} (Min: ${it.minStock})`
    );
    return `Asset dengan stock menipis:\n${lines.join("\n")}`;
  }

  // "stock apa aja" umum -> list semua
  if (lower.includes("stock")) {
    const lines = items
      .slice(0, 20)
      .map((it) => `• ${it.name}: ${it.qty} ${it.unit || "pcs"}`);
    return `Daftar Stock Asset:\n${lines.join("\n")}${items.length > 20 ? "\n…dan lainnya" : ""}`;
  }

  return null; // gak match keyword apapun
}

exports.seatalkWebhook = onRequest(
  { secrets: [SEATALK_SIGNING_SECRET, SEATALK_APP_ID, SEATALK_APP_SECRET] },
  async (req, res) => {
    const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body);
    const body = req.body || {};

    // 1) Verifikasi tanda tangan (aktifkan setelah dicocokkan ke docs resmi)
    const signature = req.get("signature") || req.get("x-seatalk-signature");
    if (!isValidSeatalkSignature(rawBody, signature, SEATALK_SIGNING_SECRET.value())) {
      logger.warn("Signature callback SeaTalk gak valid, request ditolak.");
      // return res.status(401).send("invalid signature");
      // (sementara di-comment biar gak ke-block pas masih uji coba format signature)
    }

    // 2) Handle challenge verification pas pertama kali setup Callback URL
    if (body.event_type === "event_verification") {
      return res.status(200).json({ seatalk_challenge: body.event.seatalk_challenge });
    }

    // 3) Handle pesan masuk dari user ke bot
    const event = body.event || {};
    const messageText = event?.message?.text?.content;
    if (!messageText) {
      return res.status(200).send("ok"); // event lain yang belum ditangani
    }

    let answer;
    try {
      answer = (await answerInventoryQuestion(messageText)) ||
        "Maaf, aku belum ngerti pertanyaan itu. Coba tanya soal Stock atau Consumable di Inventory Control ya.";
    } catch (err) {
      logger.error("Gagal ambil data Inventory:", err);
      answer = "Lagi ada gangguan ambil data dari dashboard, coba lagi sebentar ya.";
    }

    try {
      const token = await getSeatalkAccessToken(
        SEATALK_APP_ID.value(),
        SEATALK_APP_SECRET.value()
      );
      if (event.group_id) {
        await sendSeatalkGroupMessage(token, event.group_id, answer);
      } else if (event.employee_code) {
        await sendSeatalkPrivateMessage(token, event.employee_code, answer);
      }
    } catch (err) {
      logger.error("Gagal kirim balasan SeaTalk:", err);
    }

    return res.status(200).send("ok");
  }
);

exports.notifyLowStock = onValueWritten(
  {
    ref: "/inventoryControl/{facility}/stock/{assetId}",
    instance: "dashboardpalangkarayadc-default-rtdb", // sesuaikan kalau nama DB instance beda
    secrets: [SEATALK_APP_ID, SEATALK_APP_SECRET, SEATALK_TARGET_GROUP_ID],
  },
  async (event) => {
    const before = event.data.before.val();
    const after = event.data.after.val();

    // Asset baru dihapus, atau memang belum ada data -> skip
    if (!after) return;

    const qty = Number(after.qty ?? 0);
    const minStock = Number(after.minStock ?? 0);
    const wasQty = before ? Number(before.qty ?? 0) : null;
    const wasMinStock = before ? Number(before.minStock ?? minStock) : minStock;

    const isLowNow = qty <= minStock;
    const wasLowBefore = before ? wasQty <= wasMinStock : false;

    // Cuma kirim notif pas TRANSISI dari "aman" -> "menipis",
    // biar gak spam tiap kali ada write lain yang gak ngubah kondisi.
    if (!isLowNow || wasLowBefore) return;

    const facility = event.params.facility;
    const assetName = after.name || "(tanpa nama)";
    const unit = after.unit || "pcs";

    const text =
      `⚠️ Stock Menipis - ${facility}\n` +
      `Asset: ${assetName}\n` +
      `Sisa: ${qty} ${unit} (Min Stock: ${minStock} ${unit})\n` +
      `Cek & reorder di Inventory Control ya.`;

    try {
      const token = await getSeatalkAccessToken(
        SEATALK_APP_ID.value(),
        SEATALK_APP_SECRET.value()
      );
      await sendSeatalkGroupMessage(
        token,
        SEATALK_TARGET_GROUP_ID.value(),
        text
      );
      logger.info(`Notif low stock terkirim: ${assetName} (${facility})`);
    } catch (err) {
      logger.error("Gagal kirim notif SeaTalk:", err);
    }
  }
);
