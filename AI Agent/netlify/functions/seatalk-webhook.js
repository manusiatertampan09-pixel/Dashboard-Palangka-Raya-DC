const crypto = require("crypto");
const {
  getSeatalkAccessToken,
  sendSeatalkGroupMessage,
  sendSeatalkPrivateMessage,
  answerModuleQuestion,
} = require("./_seatalk-common");
const { askGemini } = require("./_gemini-chat");

const BOT_MENTION_NAME = process.env.BOT_MENTION_NAME || "Smith - Reminder Support";

const AI_FOOTER = "\n\nℹ️ Dijawab AI (Gemini). Mohon verifikasi kembali untuk memastikan keakuratannya.";
const HELP_TEXT =
  "Halo, aku Smith - Reminder Support 👋 Tanya apa aja soal operasional SOC, atau data live pakai kata kunci: late/transit (Inbound), aging/backlog (Outbound), stock/consumable (Inventory), performa/packing (Performance Bagger).";

function isValidSignature(rawBody, signatureHeader) {
  const signingSecret = process.env.SEATALK_SIGNING_SECRET;
  if (!signatureHeader || !signingSecret) return false;
  const expected = crypto
    .createHmac("sha256", signingSecret)
    .update(rawBody)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanQuestion(text) {
  return String(text || "")
    .replace(/<mention-tag[^>]*\/?>(<\/mention-tag>)?/gi, " ")
    .replace(new RegExp("@" + escapeRegExp(BOT_MENTION_NAME), "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function buildAnswer(question) {
  if (!question) return HELP_TEXT;

  try {
    const dataAnswer = await answerModuleQuestion(question);
    if (dataAnswer) return dataAnswer;
  } catch (err) {
    console.error("Gagal ambil data dashboard:", err);
    return "Lagi ada gangguan ambil data dari dashboard, coba lagi sebentar ya.";
  }

  try {
    const aiAnswer = await askGemini(question);
    return aiAnswer + AI_FOOTER;
  } catch (err) {
    console.error("Gagal jawab pakai Gemini:", err);
    return "Maaf, AI-nya lagi sibuk/gangguan. Coba tanya lagi sebentar lagi ya, atau pakai kata kunci data (late, aging, stock, performa).";
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const rawBody = event.body || "";
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  if (body.event_type === "event_verification") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seatalk_challenge: body.event.seatalk_challenge }),
    };
  }

  const signatureHeader =
    event.headers["signature"] || event.headers["x-seatalk-signature"];
  if (!isValidSignature(rawBody, signatureHeader)) {
    console.warn("Signature SeaTalk gak valid / belum dicocokkan skemanya.");
  }

  const seatalkEvent = body.event || {};
  const msg = seatalkEvent.message || {};
  if (!seatalkEvent.message) {
    return { statusCode: 200, body: "ok" };
  }

  console.log("SeaTalk event payload:", JSON.stringify(body));

  const rawText = (msg.text && (msg.text.plain_text || msg.text.content)) || "";
  const question = cleanQuestion(rawText);
  const answer = await buildAnswer(question);

  try {
    const token = await getSeatalkAccessToken();
    if (seatalkEvent.group_id) {
      const threadId =
        msg.thread_id && msg.thread_id !== "0" ? msg.thread_id : msg.message_id;

      const result = await sendSeatalkGroupMessage(
        token,
        seatalkEvent.group_id,
        answer,
        { threadId }
      );

      if (result && (result.code === 4009 || result.code === 4010)) {
        await sendSeatalkGroupMessage(token, seatalkEvent.group_id, answer, {
          quotedMessageId: msg.message_id,
        });
      }
    } else if (seatalkEvent.employee_code) {
      await sendSeatalkPrivateMessage(token, seatalkEvent.employee_code, answer);
    }
  } catch (err) {
    console.error("Gagal kirim balasan SeaTalk:", err);
  }

  return { statusCode: 200, body: "ok" };
};
