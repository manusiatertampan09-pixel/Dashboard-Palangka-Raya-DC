const GEMINI_MODEL_CHAIN = [
  "gemini-3-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
];

const THINKING_LEVEL_LADDER = ["minimal", "low", "medium", "high"];

function geminiUrlFor(model) {
  return "https://generativelanguage.googleapis.com/v1beta/models/" +
    model + ":generateContent";
}

function errMsgOf(data){
  return JSON.stringify((data && data.error) || "");
}

function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelayMsOf(data){
  const msg = errMsgOf(data);
  const m = msg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
  const seconds = m ? parseFloat(m[1]) : 2;
  return Math.min(Math.max(seconds, 1), 6) * 1000;
}

function isRateLimitError(status, data){
  if (status === 429) return true;
  return /RESOURCE_EXHAUSTED/i.test(errMsgOf(data));
}

function isOverloadedError(status, data){
  if (status === 503) return true;
  const msg = errMsgOf(data);
  return /UNAVAILABLE/i.test(msg) || /overloaded/i.test(msg) || /experiencing high demand/i.test(msg);
}

function isModelUnavailableError(status, data){
  if (status === 404) return true;
  const msg = errMsgOf(data);
  return /NOT_FOUND/i.test(msg) || /no longer available/i.test(msg);
}

function isThinkingLevelError(status, data){
  if (status !== 400) return false;
  const msg = errMsgOf(data);
  return /thinking/i.test(msg) && /not supported/i.test(msg);
}

function buildChain(preferredModel){
  if (!preferredModel || GEMINI_MODEL_CHAIN.indexOf(preferredModel) === -1){
    return GEMINI_MODEL_CHAIN;
  }
  return [preferredModel].concat(GEMINI_MODEL_CHAIN.filter(m => m !== preferredModel));
}

async function callGemini(model, geminiBodyBase, thinkingLevel, apiKey){
  const geminiBody = Object.assign({}, geminiBodyBase, {
    generationConfig: Object.assign({}, geminiBodyBase.generationConfig, {
      thinkingConfig: { thinkingLevel: thinkingLevel }
    })
  });
  const geminiRes = await fetch(geminiUrlFor(model) + "?key=" + apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(geminiBody)
  });
  const data = await geminiRes.json();
  return { status: geminiRes.status, data: data };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "GEMINI_API_KEY belum di-set di Environment Variables Netlify"
      })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Body request bukan JSON valid" })
    };
  }

  const { system, contents, max_tokens, thinking_level, preferred_model } = payload;

  if (!contents || !Array.isArray(contents)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Field 'contents' wajib ada dan berupa array" })
    };
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

  async function runChainPass(){
    let lastResult = null;
    for (let i = 0; i < modelChain.length; i++){
      const model = modelChain[i];

      for (let lvl = startLadderIdx; lvl < THINKING_LEVEL_LADDER.length; lvl++){
        const thinkingLevel = THINKING_LEVEL_LADDER[lvl];
        try {
          const result = await callGemini(model, geminiBodyBase, thinkingLevel, apiKey);
          lastResult = result;

          if (isThinkingLevelError(result.status, result.data)){
            continue;
          }
          if (isRateLimitError(result.status, result.data) || isModelUnavailableError(result.status, result.data) || isOverloadedError(result.status, result.data)){
            break;
          }

          result.data.modelUsed = model;
          return {
            done: true,
            statusCode: result.status,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(result.data)
          };
        } catch (e) {
          lastResult = { status: 502, data: { error: "Gagal menghubungi Gemini API (" + model + "): " + e.message } };
          break;
        }
      }
    }
    return { done: false, lastResult: lastResult };
  }

  const SMALL_PROMPT_CHAR_LIMIT = 20000;
  const promptCharLen = JSON.stringify(geminiBodyBase).length;

  let pass = await runChainPass();
  if (!pass.done && pass.lastResult && isRateLimitError(pass.lastResult.status, pass.lastResult.data) && promptCharLen < SMALL_PROMPT_CHAR_LIMIT){
    await sleep(retryDelayMsOf(pass.lastResult.data));
    pass = await runChainPass();
  }

  if (pass.done){
    return {
      statusCode: pass.statusCode,
      headers: pass.headers,
      body: pass.body
    };
  }

  const lastResult = pass.lastResult;
  const finalData = lastResult ? lastResult.data : { error: "Semua model di GEMINI_MODEL_CHAIN gagal, gak ada respons." };
  return {
    statusCode: (lastResult && lastResult.status) || 502,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(finalData)
  };
};
