import assert from "node:assert/strict";
import test from "node:test";

import { prepareDailyCache, SPIRITUAL_SOURCE_URL } from "../src/daily-gemini.js";
import {
  GEMINI_MODELS,
  GROQ_MODEL,
  translateToRussian,
  WORKERS_AI_MODEL
} from "../src/translate.js";
import { currentSpadnaFixture, FakeDB } from "./helpers.js";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const today = { key: "2026-09-08", year: 2026, month: 9, day: 8, hour: 10, minute: 0 };
const russianFixture = `
<div class="text-lg font-bold">Тема дня</div>
<div data-qa="meditation-date">8 сентября</div>
<div class="text-md italic">Цитата</div>
<div class="text-md text-secondary-blue">Источник</div>
<div class="text-md mt-8"><p>Основной текст</p></div>
<div class="order-2"></div>`;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function geminiPayload(text) {
  return { steps: [{ type: "model_output", content: [{ type: "text", text }] }] };
}

test("Workers AI is used first and the other translators stay idle", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    throw new Error(`fetch must stay idle: ${url}`);
  });

  const translation = await translateToRussian({
    AI: {
      async run(model, input, options) {
        calls.push({ model, options, text: input.messages.at(-1).content });
        return { choices: [{ message: { content: "Готовый перевод" } }] };
      }
    },
    GROQ_API_KEY: "groq",
    GEMINI_API_KEY: "gemini"
  }, "Hello");

  assert.equal(translation, "Готовый перевод");
  assert.deepEqual(calls, [{
    model: WORKERS_AI_MODEL,
    options: { rejectIfBusy: true },
    text: "Hello"
  }]);
});

test("a busy Workers AI falls through Groq, then both Gemini models", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const target = String(url);
    const body = JSON.parse(options.body);
    calls.push({ target, model: body.model });
    if (target === GROQ_URL) return jsonResponse({ error: { message: "rate limit" } }, 429);
    if (target === GEMINI_URL && body.model === GEMINI_MODELS[0]) {
      return jsonResponse({ error: { message: "quota" } }, 429);
    }
    if (target === GEMINI_URL && body.model === GEMINI_MODELS[1]) {
      return jsonResponse(geminiPayload("Запасной перевод"));
    }
    throw new Error(`Unexpected fetch: ${target}`);
  });

  const translation = await translateToRussian({
    AI: { async run() { throw new Error("busy"); } },
    GROQ_API_KEY: "groq",
    GEMINI_API_KEY: "gemini"
  }, "Hello");

  assert.equal(translation, "Запасной перевод");
  assert.deepEqual(calls, [
    { target: GROQ_URL, model: GROQ_MODEL },
    { target: GEMINI_URL, model: GEMINI_MODELS[0] },
    { target: GEMINI_URL, model: GEMINI_MODELS[1] }
  ]);
});

test("Groq is skipped when its key is absent and Gemini still translates", async (t) => {
  const models = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const target = String(url);
    assert.equal(target, GEMINI_URL);
    const model = JSON.parse(options.body).model;
    models.push(model);
    return jsonResponse(geminiPayload("Перевод Gemini"));
  });

  const translation = await translateToRussian({ GEMINI_API_KEY: "gemini" }, "Hello");

  assert.equal(translation, "Перевод Gemini");
  assert.deepEqual(models, [GEMINI_MODELS[0]]);
});

test("an empty Workers AI answer falls through to the next translator", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(String(url), GROQ_URL);
    return jsonResponse({ choices: [{ message: { content: "Перевод Groq" } }] });
  });

  const translation = await translateToRussian({
    AI: { async run() { return { choices: [{ message: { content: "  " } }] }; } },
    GROQ_API_KEY: "groq"
  }, "Hello");

  assert.equal(translation, "Перевод Groq");
});

test("translation explains that no translator is configured", async () => {
  await assert.rejects(
    () => translateToRussian({}, "Hello"),
    /Не настроен ни один API перевода/
  );
});

test("translation explains when every configured translator fails", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse({ error: { message: "quota" } }, 429));
  await assert.rejects(
    () => translateToRussian({ GEMINI_API_KEY: "gemini" }, "Hello"),
    /Перевод недоступен/
  );
});

test("daily cache stores one Workers AI translation and reuses it", async (t) => {
  const db = new FakeDB();
  let aiCalls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    const target = String(url);
    if (target === "https://na-russia.org/") return new Response(russianFixture);
    if (target === SPIRITUAL_SOURCE_URL) return new Response(currentSpadnaFixture);
    throw new Error(`Unexpected fetch: ${target}`);
  });
  const env = {
    DB: db,
    AI: {
      async run() {
        aiCalls += 1;
        return { choices: [{ message: { content: "8 сентября 2026\nПереведённая тема\nПереведённый текст" } }] };
      }
    },
    GEMINI_API_KEY: "must-not-be-used"
  };

  await prepareDailyCache(env, today);
  await prepareDailyCache(env, today);

  assert.equal(aiCalls, 1);
  assert.equal(db.dailyCache.get("spiritual:2026-09-08").source_date, "September 08, 2026");
  assert.match(db.dailyCache.get("spiritual:2026-09-08").payload, /Переведённый текст/);
});
