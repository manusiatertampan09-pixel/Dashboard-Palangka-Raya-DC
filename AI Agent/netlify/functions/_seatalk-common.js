/**
 * _seatalk-common.js
 * ------------------------------------------------------------------
 * Helper bersama dipakai oleh seatalk-webhook.js & check-low-stock.js.
 * File ini BUKAN endpoint sendiri (gak diawali handler), jadi Netlify
 * gak akan nge-generate URL publik buat file ini — aman ditaruh di
 * folder functions yang sama.
 */

const admin = require("firebase-admin");

const SEATALK_API_BASE = "https://openapi.seatalk.io";

// ================= FIREBASE ADMIN INIT =================
// Env var FIREBASE_SERVICE_ACCOUNT_B64 harus diisi hasil base64 dari
// file JSON service account (Firebase Console > Project Settings >
// Service Accounts > Generate new private key), biar gak kena masalah
// newline pas disimpen sebagai env var biasa.
function getFirebaseApp() {
  if (admin.apps.length) return admin.app();

  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) {
    throw new Error("Env var FIREBASE_SERVICE_ACCOUNT_B64 belum diset.");
  }
  const serviceAccount = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL, // contoh: https://xxx-default-rtdb.asia-southeast1.firebasedatabase.app
  });
}

function db() {
  return getFirebaseApp().database();
}

// ================= SEATALK BOT API =================

async function getSeatalkAccessToken() {
  const res = await fetch(`${SEATALK_API_BASE}/auth/app_access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: process.env.SEATALK_APP_ID,
      app_secret: process.env.SEATALK_APP_SECRET,
    }),
  });
  const data = await res.json();
  if (!data.app_access_token) {
    throw new Error("Gagal ambil access token SeaTalk: " + JSON.stringify(data));
  }
  return data.app_access_token;
}

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
  return res.json();
}

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
  return res.json();
}

// ================= LOGIKA STOCK (dipakai webhook Q&A & scheduled check) =================

async function getStockItems() {
  const snap = await db().ref("inventoryControl/SOC/stock").get();
  const stock = snap.val() || {};
  return Object.entries(stock).map(([id, val]) => ({ id, ...val }));
}

async function answerInventoryQuestion(text) {
  const lower = text.toLowerCase();
  const items = await getStockItems();

  if (!items.length) return "Belum ada data Stock di Inventory Control.";

  if (lower.includes("consumable")) {
    const consumables = items.filter((it) =>
      (it.category || "").toLowerCase().includes("consumable")
    );
    if (!consumables.length) return "Gak ada Asset dengan kategori Consumable di Stock.";
    const lines = consumables.map((it) => `• ${it.name}: ${it.qty} ${it.unit || "pcs"}`);
    return `Stock Consumable saat ini:\n${lines.join("\n")}`;
  }

  if (lower.includes("menipis") || lower.includes("low stock")) {
    const low = items.filter((it) => Number(it.qty) <= Number(it.minStock ?? 0));
    if (!low.length) return "Gak ada Asset yang stock-nya menipis 👍";
    const lines = low.map(
      (it) => `• ${it.name}: sisa ${it.qty} ${it.unit || "pcs"} (Min: ${it.minStock})`
    );
    return `Asset dengan stock menipis:\n${lines.join("\n")}`;
  }

  if (lower.includes("stock")) {
    const lines = items
      .slice(0, 20)
      .map((it) => `• ${it.name}: ${it.qty} ${it.unit || "pcs"}`);
    return `Daftar Stock Asset:\n${lines.join("\n")}${items.length > 20 ? "\n…dan lainnya" : ""}`;
  }

  return null;
}

module.exports = {
  db,
  getSeatalkAccessToken,
  sendSeatalkGroupMessage,
  sendSeatalkPrivateMessage,
  getStockItems,
  answerInventoryQuestion,
};
