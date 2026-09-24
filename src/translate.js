const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export const WORKERS_AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const GROQ_MODEL = "openai/gpt-oss-120b";
export const GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-3.6-flash"];

const INSTRUCTIONS = [
  "Переведи приведённый ниже текст с английского на русский.",
  "Переведи весь текст без сокращений, пересказа, комментариев и добавлений.",
  "Сохраняй абзацы, даты, цитаты, названия литературы и терминологию Анонимных Наркоманов.",
  "Верни только готовый русский перевод."
].join("\n");

const PROVIDER_ORDER = ["workers-ai", "groq", "gemini"];

export async function translateToRussian(env, text) {
  return (await translateForDaily(env, text)).text;
}

export async function translateForDaily(env, text) {
  const failures = [];
  const skipped = [];
  for (const provider of PROVIDER_ORDER) {
    if (!providerReady(provider, env)) {
      skipped.push(provider);
      continue;
    }
    try {
      const translation = await translateWith(provider, env, text);
      if (!translation) throw new Error("пустой ответ");
      console.log(JSON.stringify({ event: "translation_ready", provider }));
      return { text: translation, provider, failures, skipped };
    } catch (error) {
      failures.push({ provider, error: String(error).slice(0, 180) });
      console.error(JSON.stringify({
        event: "translation_provider_failed",
        provider,
        error: String(error).slice(0, 300)
      }));
    }
  }
  const error = new Error(failures.length
    ? `Перевод недоступен. ${failures.map((item) => `${item.provider}: ${item.error}`).join(" | ")}`
    : "Не настроен ни один API перевода");
  error.failures = failures;
  error.skipped = skipped;
  throw error;
}

function providerReady(provider, env) {
  if (provider === "workers-ai") return typeof env.AI?.run === "function";
  if (provider === "groq") return Boolean(env.GROQ_API_KEY);
  return Boolean(env.GEMINI_API_KEY);
}

function translateWith(provider, env, text) {
  if (provider === "workers-ai") return translateWithWorkersAi(env, text);
  if (provider === "groq") return translateWithGroq(env, text);
  return translateWithGemini(env, text);
}

async function translateWithWorkersAi(env, text) {
  const payload = await env.AI.run(WORKERS_AI_MODEL, {
    messages: [
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: text }
    ],
    chat_template_kwargs: { enable_thinking: false }
  }, { rejectIfBusy: true });
  const translation = extractChatText(payload);
  if (!translation) throw new Error("Workers AI не вернул текст перевода");
  return translation;
}

async function translateWithGroq(env, text) {
  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: INSTRUCTIONS },
        { role: "user", content: text }
      ]
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Groq API: ${payload.error?.message || response.status}`);
  const translation = extractChatText(payload);
  if (!translation) throw new Error("Groq не вернул текст перевода");
  return translation;
}

async function translateWithGemini(env, text) {
  const errors = [];
  for (const model of GEMINI_MODELS) {
    try {
      return await callGemini(env, model, `${INSTRUCTIONS}\n\n${text}`);
    } catch (error) {
      errors.push(`${model}: ${String(error).slice(0, 160)}`);
    }
  }
  throw new Error(errors.join(" | "));
}

async function callGemini(env, model, input) {
  const response = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ model, input })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Gemini API: ${payload.error?.message || response.status}`);
  const translation = payload.steps?.filter((step) => step.type === "model_output")
    .flatMap((step) => step.content || []).filter((item) => item.type === "text")
    .map((item) => item.text).join("").trim();
  if (!translation) throw new Error("Gemini не вернул текст перевода");
  return translation;
}

function extractChatText(payload) {
  const body = payload?.choices ? payload : payload?.result;
  const content = body?.response ?? body?.choices?.[0]?.message?.content ?? "";
  return String(content).trim();
}
