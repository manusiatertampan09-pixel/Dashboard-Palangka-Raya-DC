// netlify/functions/gemini-proxy.js
// Perubahan dari versi lama:
//  1. Urutan chain: model yang paling sering sukses (3.1 Flash Lite, jatah 500/hari) di depan.
//  2. Ada batas waktu total (TIME_BUDGET_MS) supaya function berhenti SEBELUM di-kill Netlify
//     (default sync function biasanya 10 detik). Kalau ke-kill, browser nerima respons
//     aneh -> muncul "Waduh, gagal ngambil jawaban AI".
//  3. Tiap percobaan di-log ke Netlify Functions Logs (model, level, status, durasi, error).
//  4. 500/502/504 dari Gemini juga dianggap "coba model lain".
//  5. Kalau semua gagal, balikin JSON { error: { message } } yang jelas + rincian per model.

const GEMINI_MODEL_CHAIN = [
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
];

const THINKING_LEVEL_LADDER = ["minimal", "low", "medium", "high"];

// Sisakan ~1.5 detik dari batas 10 detik Netlify. Kalau plan lu punya timeout lebih
// panjang, set env PROXY_TIME_BUDGET_MS (mis. 22000).
const TIME_BUDGET_MS = parseInt(process.env.PROXY_TIME_BUDGET_MS || "8500", 10);

function geminiUrlFor(model) {
  return "https://generativelanguage.googleapis.com/v1beta/models/" +
    model + ":generateContent";
}

function errMsgOf(data) {
  return JSON.stringify((data && data.error) || "");
}

function shortErr(data) {
  const e = data && data.error;
  const m = (e && (e.message || e.status)) || (typeof e === "string" ? e : "");
  return String(m).slice(0, 160);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelayMsOf(data) {
  const msg = errMsgOf(data);
  const m = msg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
  const seconds = m ? parseFloat(m[1]) : 2;
  return Math.min(Math.max(seconds, 1), 6) * 1000;
}

function isRateLimitError(status, data) {
  if (status === 429) return true;
  return /RESOURCE_EXHAUSTED/i.test(errMsgOf(data));
}

function isOverloadedError(status, data) {
  if (status === 503 || status === 500 || status === 502 || status === 504) return true;
  const msg = errMsgOf(data);
  return /UNAVAILABLE/i.test(msg) || /overloaded/i.test(msg) || /experiencing high demand/i.test(msg);
}

function isModelUnavailableError(status, data) {
  if (status === 404) return true;
  const msg = errMsgOf(data);
  return /NOT_FOUND/i.test(msg) || /no longer available/i.test(msg);
}

function isThinkingLevelError(status, data) {
  if (status !== 400) return false;
  const msg = errMsgOf(data);
  return /thinking/i.test(msg) && /(not supported|invalid|unsupported)/i.test(msg);
}

function buildChain(preferredModel) {
  if (!preferredModel || GEMINI_MODEL_CHAIN.indexOf(preferredModel) === -1) {
    return GEMINI_MODEL_CHAIN;
  }
  return [preferredModel].concat(GEMINI_MODEL_CHAIN.filter(m => m !== preferredModel));
}

async function callGemini(model, geminiBodyBase, thinkingLevel, apiKey, timeoutMs) {
  const geminiBody = Object.assign({}, geminiBodyBase, {
    generationConfig: Object.assign({}, geminiBodyBase.generationConfig, {
      thinkingConfig: { thinkingLevel: thinkingLevel }
    })
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const geminiRes = await fetch(geminiUrlFor(model) + "?key=" + apiKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody),
      signal: controller.signal
    });
    const data = await geminiRes.json();
    return { status: geminiRes.status, data: data };
  } finally {
    clearTimeout(timer);
  }
}

function jsonResponse(statusCode, obj) {
  return {
    statusCode: statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj)
  };
}

exports.handler = async function (event) {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: { message: "Method not allowed" } });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonResponse(500, {
      error: { message: "GEMINI_API_KEY belum di-set di Environment Variables Netlify" }
    });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return jsonResponse(400, { error: { message: "Body request bukan JSON valid" } });
  }

  const { system, contents, max_tokens, thinking_level, preferred_model } = payload;

  if (!contents || !Array.isArray(contents)) {
    return jsonResponse(400, { error: { message: "Field 'contents' wajib ada dan berupa array" } });
  }

  const requestedThinkingLevel = THINKING_LEVEL_LADDER.includes(thinking_level) ? thinking_level : "minimal";
  const startLadderIdx = THINKING_LEVEL_LADDER.indexOf(requestedThinkingLevel);

  const geminiBodyBase = {
    contents: contents,
    generationConfig: {
      maxOutputTokens: max_tokens || 1000,
      responseMimeType: "application/json"
    }
  };
  if (system) {
    geminiBodyBase.system_instruction = { parts: [{ text: system }] };
  }

  const modelChain = buildChain(preferred_model);
  const attempts = []; // rincian buat pesan error & log

  async function runChainPass() {
    let lastResult = null;
    for (let i = 0; i < modelChain.length; i++) {
      const model = modelChain[i];

      for (let lvl = startLadderIdx; lvl < THINKING_LEVEL_LADDER.length; lvl++) {
        const remaining = TIME_BUDGET_MS - elapsed();
        if (remaining < 1500) {
          return { done: false, lastResult: lastResult, outOfTime: true };
        }

        const thinkingLevel = THINKING_LEVEL_LADDER[lvl];
        const t0 = Date.now();
        try {
          const result = await callGemini(model, geminiBodyBase, thinkingLevel, apiKey, remaining);
          lastResult = result;
          console.log("[gemini-proxy]", model, "lvl=" + thinkingLevel, "->", result.status,
            (Date.now() - t0) + "ms", shortErr(result.data));
          attempts.push({ model: model, status: result.status });

          if (isThinkingLevelError(result.status, result.data)) {
            continue; // naik ke level thinking berikutnya
          }
          if (isRateLimitError(result.status, result.data) ||
              isModelUnavailableError(result.status, result.data) ||
              isOverloadedError(result.status, result.data)) {
            break; // ganti model
          }

          result.data.modelUsed = model;
          return {
            done: true,
            statusCode: result.status,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(result.data)
          };
        } catch (e) {
          const aborted = e && e.name === "AbortError";
          console.log("[gemini-proxy]", model, "lvl=" + thinkingLevel, "-> EXC",
            (Date.now() - t0) + "ms", e.message);
          attempts.push({ model: model, status: aborted ? "timeout" : "exc" });
          lastResult = {
            status: aborted ? 504 : 502,
            data: { error: { message: (aborted ? "Timeout" : "Gagal menghubungi Gemini API") + " (" + model + "): " + e.message } }
          };
          break;
        }
      }
    }
    return { done: false, lastResult: lastResult };
  }

  const SMALL_PROMPT_CHAR_LIMIT = 20000;
  const promptCharLen = JSON.stringify(geminiBodyBase).length;

  let pass = await runChainPass();
  if (!pass.done && !pass.outOfTime && pass.lastResult &&
      isRateLimitError(pass.lastResult.status, pass.lastResult.data) &&
      promptCharLen < SMALL_PROMPT_CHAR_LIMIT &&
      elapsed() + retryDelayMsOf(pass.lastResult.data) < TIME_BUDGET_MS - 2000) {
    await sleep(retryDelayMsOf(pass.lastResult.data));
    pass = await runChainPass();
  }

  if (pass.done) {
    return {
      statusCode: pass.statusCode,
      headers: pass.headers,
      body: pass.body
    };
  }

  // Semua gagal: balikin JSON yang jelas, bukan error mentah dari model terakhir
  const last = pass.lastResult;
  const detail = attempts.map(a => a.model + ":" + a.status).join(", ");
  const reason = pass.outOfTime
    ? "Timeout: waktu habis sebelum ada model yang jawab (UNAVAILABLE)"
    : "Semua model gagal (UNAVAILABLE)";
  console.log("[gemini-proxy] GAGAL TOTAL setelah " + elapsed() + "ms ->", detail);

  return jsonResponse((last && last.status >= 400 && last.status < 600) ? last.status : 503, {
    error: {
      message: reason + ". Rincian: " + (detail || "-"),
      lastError: last ? shortErr(last.data) : ""
    }
  });
};
