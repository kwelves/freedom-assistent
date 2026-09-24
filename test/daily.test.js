import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { handleUpdate } from "../src/index.js";
import dailyWorker, {
  checkScheduledDaily,
  DAILY_CRONS,
  DAILY_PREPARE_CRON,
  formatBroadcastSummary,
  getDailyCache,
  getBishkekDate,
  isCurrentEnglishDate,
  parseSpiritualPrinciple,
  prepareDailyCache,
  processSpiritualDaily,
  runDailyBroadcast,
  sendDailyToSubscribers,
  SPIRITUAL_SOURCE_URL
} from "../src/daily-gemini.js";
import { currentSpadnaFixture, FakeDB, telegramFetch } from "./helpers.js";

const russianPreviewFixture = `
<div class="text-lg font-bold">Тема дня</div>
<div data-qa="meditation-date">8 сентября</div>
<div class="text-md italic">Цитата</div>
<div class="text-md text-secondary-blue">Источник</div>
<div class="text-md mt-8"><p>Основной текст</p></div>
<div class="order-2"></div>`;

function installTimingSafeEqual(t) {
  const original = crypto.subtle.timingSafeEqual;
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    configurable: true,
    value(left, right) {
      const a = new Uint8Array(left);
      const b = new Uint8Array(right);
      if (a.length !== b.length) return false;
      let difference = 0;
      for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
      return difference === 0;
    }
  });
  t.after(() => {
    if (original) Object.defineProperty(crypto.subtle, "timingSafeEqual", { configurable: true, value: original });
    else delete crypto.subtle.timingSafeEqual;
  });
}

function webhookRequest(command, fromId = 77, updateId = 1000) {
  return new Request("https://worker.example/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "hook-secret"
    },
    body: JSON.stringify({ update_id: updateId, message: {
      message_id: 12,
      text: command,
      chat: { id: fromId, type: "private" },
      from: { id: fromId, username: "user", first_name: "User" }
    } })
  });
}

function dailySourcesFetch(telegramMessages, failures = new Map()) {
  return async (url, options = {}) => {
    const target = String(url);
    if (target === "https://na-russia.org/") return new Response(russianPreviewFixture);
    if (target === SPIRITUAL_SOURCE_URL) return new Response(currentSpadnaFixture);
    if (target === "https://generativelanguage.googleapis.com/v1beta/interactions") {
      return new Response(JSON.stringify({
        steps: [{ type: "model_output", content: [{ type: "text", text: "8 сентября 2026\nПереведённая тема\nПереведённый текст" }] }]
      }), { headers: { "content-type": "application/json" } });
    }
    if (target.startsWith("https://api.telegram.org/bot")) {
      const body = JSON.parse(options.body);
      telegramMessages.push(body);
      const failure = failures.get(body.chat_id);
      if (failure) {
        return new Response(JSON.stringify({ ok: false, description: failure }), {
          status: 400,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: telegramMessages.length } }), {
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  };
}

function countedDailySourcesFetch(telegramMessages, sourceCalls) {
  const baseFetch = dailySourcesFetch(telegramMessages);
  return (url, options) => {
    const target = String(url);
    if (target === "https://na-russia.org/" || target === SPIRITUAL_SOURCE_URL) {
      sourceCalls.count += 1;
    }
    return baseFetch(url, options);
  };
}

const broadcastToday = { key: "2026-09-08", year: 2026, month: 9, day: 8, hour: 10 };

test("na.org/spadna parser extracts all required fields from the current heading markup", () => {
  const parsed = parseSpiritualPrinciple(currentSpadnaFixture);
  assert.equal(parsed.date, "September 08, 2026");
  assert.equal(parsed.title, "Gratitude Transforms Us");
  assert.equal(parsed.page, "Page 260");
  assert.match(parsed.quote, /Gratitude in action/);
  assert.equal(parsed.source, "Guiding Principles, Tradition Five, Opening Reflection");
  assert.equal(parsed.body, "First main paragraph.\n\nSecond main paragraph.");
  assert.match(parsed.thought, /opportunities/);
  assert.match(parsed.raw, /Guiding Principles/);
});

test("spadna parser accepts a missing quote source", () => {
  const withoutSource = currentSpadnaFixture.replace(
    '<tr><td align="center">Guiding Principles, Tradition Five, Opening Reflection<br><br></td></tr>',
    ""
  );
  const parsed = parseSpiritualPrinciple(withoutSource);
  assert.equal(parsed.source, "");
  assert.equal(parsed.body, "First main paragraph.\n\nSecond main paragraph.");
});

test("English date parsing is explicit and deterministic", () => {
  const today = { year: 2026, month: 9, day: 8 };
  assert.equal(isCurrentEnglishDate("September 08, 2026", today), true);
  assert.equal(isCurrentEnglishDate("September 07, 2026", today), false);
  assert.equal(isCurrentEnglishDate("not a date", today), false);
});

test("spadna requests use the Bishkek timezone and bypass cache without changing the Russian source request", async (t) => {
  const db = new FakeDB();
  db.subscribers.set(1, { chat_id: 1, active: 1 });
  const sent = [];
  const sourceRequests = new Map();
  const baseFetch = dailySourcesFetch(sent);
  t.mock.method(globalThis, "fetch", (url, options = {}) => {
    const target = String(url);
    if (target === "https://na-russia.org/" || target === SPIRITUAL_SOURCE_URL) {
      sourceRequests.set(target, options);
    }
    return baseFetch(url, options);
  });

  await runDailyBroadcast(
    { DB: db, BOT_TOKEN: "test", GEMINI_API_KEY: "test" },
    { force: false, today: broadcastToday }
  );

  assert.equal(SPIRITUAL_SOURCE_URL, "https://na.org/spadna/?timeZone=Asia%2FBishkek");
  const spiritualUrl = new URL(SPIRITUAL_SOURCE_URL);
  assert.equal(`${spiritualUrl.origin}${spiritualUrl.pathname}`, "https://na.org/spadna/");
  assert.equal(spiritualUrl.searchParams.get("timeZone"), "Asia/Bishkek");
  assert.equal(sourceRequests.get(SPIRITUAL_SOURCE_URL).cache, "no-store");
  assert.equal("cache" in sourceRequests.get("https://na-russia.org/"), false);
});

function pageResponse(body, finalUrl, status = 200) {
  const response = new Response(body, { status });
  Object.defineProperty(response, "url", { value: finalUrl });
  return response;
}

test("a moved source is remembered, reported once, and opened directly next time", async (t) => {
  const db = new FakeDB();
  const sent = [];
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const target = String(url);
    requested.push(target);
    if (target === "https://na-russia.org/") {
      return pageResponse(russianPreviewFixture, "https://new-daily.example/today");
    }
    if (target === "https://new-daily.example/today") return pageResponse(russianPreviewFixture, target);
    if (target.startsWith("https://api.telegram.org/bot")) {
      sent.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), {
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  });
  const env = { DB: db, BOT_TOKEN: "test", OWNER_ID: "77" };

  await prepareDailyCache(env, broadcastToday, { russian: true, spiritual: false });
  db.dailyCache.clear();
  await prepareDailyCache(env, broadcastToday, { russian: true, spiritual: false });

  assert.deepEqual(requested.filter((url) => !url.includes("api.telegram.org")), [
    "https://na-russia.org/",
    "https://new-daily.example/today"
  ]);
  assert.equal(db.settings.get("source_url:russian"), "https://new-daily.example/today");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, "77");
  assert.match(sent[0].text, /Сайт переехал/);
  assert.match(sent[0].text, /https:\/\/new-daily\.example\/today/);
});

test("a saved source that does not open falls back to the original address", async (t) => {
  const db = new FakeDB();
  db.settings.set("source_url:russian", "https://broken.example/");
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const target = String(url);
    requested.push(target);
    if (target === "https://broken.example/") return new Response("missing", { status: 404 });
    if (target === "https://na-russia.org/") return pageResponse(russianPreviewFixture, target);
    throw new Error(`Unexpected fetch: ${target}`);
  });

  const cache = await prepareDailyCache(
    { DB: db, BOT_TOKEN: "test" },
    broadcastToday,
    { russian: true, spiritual: false }
  );

  assert.deepEqual(requested, ["https://broken.example/", "https://na-russia.org/"]);
  assert.equal(cache.russian.payload.title, "Тема дня");
});

test("an unrecognized page on a new address reports the move and the unfamiliar layout", async (t) => {
  const db = new FakeDB();
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url) === "https://na-russia.org/") return pageResponse("<html>пусто</html>", "https://new-daily.example/");
    if (String(url).startsWith("https://api.telegram.org/bot")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const cache = await prepareDailyCache(
    { DB: db, BOT_TOKEN: "test", OWNER_ID: "77" },
    broadcastToday,
    { russian: true, spiritual: false }
  );

  assert.match(String(cache.errors.russian), /новом адресе: https:\/\/new-daily\.example\//);
  assert.match(String(cache.errors.russian), /Вид страницы незнакомый/);
});

test("daily preparation translates once and reuses today's D1 cache", async (t) => {
  const db = new FakeDB();
  const sent = [];
  const calls = { sources: 0, gemini: 0 };
  const baseFetch = dailySourcesFetch(sent);
  t.mock.method(globalThis, "fetch", (url, options) => {
    const target = String(url);
    if (target === "https://na-russia.org/" || target === SPIRITUAL_SOURCE_URL) calls.sources += 1;
    if (target === "https://generativelanguage.googleapis.com/v1beta/interactions") calls.gemini += 1;
    return baseFetch(url, options);
  });
  const env = { DB: db, BOT_TOKEN: "test", GEMINI_API_KEY: "test" };

  await prepareDailyCache(env, broadcastToday);
  await prepareDailyCache(env, broadcastToday);
  const cache = await getDailyCache(env, broadcastToday);

  assert.deepEqual(calls, { sources: 2, gemini: 1 });
  assert.equal(cache.russian.payload.title, "Тема дня");
  assert.equal(cache.spiritual.payload.title, "Переведённая тема");
  assert.equal(db.dailyCache.size, 2);
});

test("daily cache never returns a previous date", async () => {
  const db = new FakeDB();
  db.dailyCache.set("spiritual:2026-09-07", {
    content_type: "spiritual",
    date_key: "2026-09-07",
    source_date: "September 07, 2026",
    payload: JSON.stringify({ date: "7 сентября 2026", title: "Старое", body: "Старый текст" })
  });

  assert.deepEqual(await getDailyCache({ DB: db }, broadcastToday), {});
});

test("private /start upserts an active subscriber without adding a Group username", async (t) => {
  const db = new FakeDB();
  const sent = [];
  t.mock.method(globalThis, "fetch", telegramFetch(sent));
  await handleUpdate({ message: {
    message_id: 10,
    text: "/start",
    chat: { id: 101, type: "private" },
    from: { id: 101, username: "new_user", first_name: "New" }
  } }, { DB: db, BOT_TOKEN: "test" });

  assert.deepEqual(db.subscribers.get(101), {
    chat_id: 101,
    username: "new_user",
    first_name: "New",
    active: 1,
    created_at: db.subscribers.get(101).created_at
  });
  assert.equal(db.usernames.size, 0);
  assert.equal(sent[0].chat_id, 101);
  assert.match(sent[0].text, /подписаны/);
});

test("group /start never creates a subscriber", async (t) => {
  const db = new FakeDB();
  const sent = [];
  t.mock.method(globalThis, "fetch", telegramFetch(sent));
  await handleUpdate({ message: {
    message_id: 11,
    text: "/start",
    chat: { id: -10001, type: "supergroup" },
    from: { id: 77, username: "owner", first_name: "Owner" }
  } }, { DB: db, BOT_TOKEN: "test", OWNER_ID: "77" });

  assert.equal(db.subscribers.size, 0);
  assert.equal(sent[0].chat_id, -10001);
  assert.match(sent[0].text, /Команды бота/);
});

test("fan-out is per-user idempotent and one blocked recipient does not stop later users", async (t) => {
  const db = new FakeDB();
  db.subscribers.set(1, { chat_id: 1, active: 1 });
  db.subscribers.set(2, { chat_id: 2, active: 1 });
  db.subscribers.set(3, { chat_id: 3, active: 1 });
  db.subscribers.set(4, { chat_id: 4, active: 1 });
  db.markers.add("daily:spiritual:2026-09-08:2");
  const sent = [];
  t.mock.method(globalThis, "fetch", telegramFetch(sent, new Map([[3, "Forbidden: bot was blocked by the user"]])));

  await sendDailyToSubscribers(
    { DB: db, BOT_TOKEN: "test" },
    "spiritual",
    "2026-09-08",
    "ДУХОВНЫЕ ПРИНЦИПЫ",
    { date: "8 сентября 2026", title: "Тема", body: "Текст" },
    [1, 2, 3, 4]
  );

  assert.deepEqual(sent.map((message) => message.chat_id), [1, 3, 4]);
  assert.equal(db.markers.has("daily:spiritual:2026-09-08:1"), true);
  assert.equal(db.markers.has("daily:spiritual:2026-09-08:2"), true);
  assert.equal(db.markers.has("daily:spiritual:2026-09-08:3"), false);
  assert.equal(db.markers.has("daily:spiritual:2026-09-08:4"), true);
  assert.equal(db.subscribers.get(3).active, 0);
});

test("stale Spiritual date sends no Telegram message", async (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", telegramFetch(sent));
  const stale = currentSpadnaFixture.replace("September 08, 2026", "September 07, 2026");
  await processSpiritualDaily(
    { DB: new FakeDB(), BOT_TOKEN: "test", GEMINI_API_KEY: "unused" },
    stale,
    { key: "2026-09-08", year: 2026, month: 9, day: 8, hour: 10 },
    [1]
  );
  assert.deepEqual(sent, []);
});

for (const command of ["/daily_for_all", "/daily_force_all"]) {
  test(`${command} is unavailable to non-owner`, async (t) => {
    installTimingSafeEqual(t);
    const db = new FakeDB();
    const sent = [];
    t.mock.method(globalThis, "fetch", telegramFetch(sent));
    const response = await dailyWorker.fetch(webhookRequest(command, 88), {
      DB: db,
      BOT_TOKEN: "test",
      OWNER_ID: "77",
      TELEGRAM_WEBHOOK_SECRET: "hook-secret",
      GEMINI_API_KEY: "unused"
    }, { waitUntil() { throw new Error("waitUntil must not be used"); } });
    assert.equal(response.status, 200);
    assert.deepEqual(sent, []);
    assert.equal(db.markers.size, 0);
  });
}

test("normal broadcast sends pending recipients, skips existing markers and creates new markers", async (t) => {
  const db = new FakeDB();
  db.subscribers.set(1, { chat_id: 1, active: 1 });
  db.subscribers.set(2, { chat_id: 2, active: 1 });
  db.markers.add("daily:russian:2026-09-08:2");
  db.markers.add("daily:spiritual:2026-09-08:2");
  const sent = [];
  t.mock.method(globalThis, "fetch", dailySourcesFetch(sent));

  const summary = await runDailyBroadcast(
    { DB: db, BOT_TOKEN: "test", GEMINI_API_KEY: "test" },
    { force: false, today: broadcastToday }
  );

  assert.deepEqual(sent.map((message) => message.chat_id), [1, 1]);
  assert.deepEqual(summary.russian, { status: "ready", sent: 1, skipped: 1, errors: 0 });
  assert.deepEqual(summary.spiritual, { status: "ready", sent: 1, skipped: 1, errors: 0 });
  assert.equal(db.markers.has("daily:russian:2026-09-08:1"), true);
  assert.equal(db.markers.has("daily:spiritual:2026-09-08:1"), true);
});

test("normal broadcast exits before fetch when every active subscriber has both markers", async (t) => {
  const db = new FakeDB();
  for (const chatId of [1, 2]) {
    db.subscribers.set(chatId, { chat_id: chatId, active: 1 });
    db.markers.add(`daily:russian:2026-09-08:${chatId}`);
    db.markers.add(`daily:spiritual:2026-09-08:${chatId}`);
  }
  const calls = { sources: 0, gemini: 0, telegram: 0 };
  t.mock.method(globalThis, "fetch", async (url) => {
    const target = String(url);
    if (target === "https://na-russia.org/" || target === SPIRITUAL_SOURCE_URL) calls.sources += 1;
    if (target === "https://generativelanguage.googleapis.com/v1beta/interactions") calls.gemini += 1;
    if (target.startsWith("https://api.telegram.org/bot")) calls.telegram += 1;
    throw new Error(`Unexpected fetch: ${target}`);
  });

  const summary = await runDailyBroadcast(
    { DB: db, BOT_TOKEN: "test", GEMINI_API_KEY: "test" },
    { force: false, today: broadcastToday }
  );

  assert.deepEqual(calls, { sources: 0, gemini: 0, telegram: 0 });
  assert.deepEqual(summary.russian, { status: "ready", sent: 0, skipped: 2, errors: 0 });
  assert.deepEqual(summary.spiritual, { status: "ready", sent: 0, skipped: 2, errors: 0 });
});

test("normal broadcast fetches and sends only Spiritual when Russian is complete", async (t) => {
  const db = new FakeDB();
  for (const chatId of [1, 2]) db.subscribers.set(chatId, { chat_id: chatId, active: 1 });
  db.markers.add("daily:russian:2026-09-08:1");
  db.markers.add("daily:russian:2026-09-08:2");
  db.markers.add("daily:spiritual:2026-09-08:1");
  const sent = [];
  const sources = [];
  let geminiCalls = 0;
  const baseFetch = dailySourcesFetch(sent);
  t.mock.method(globalThis, "fetch", (url, options) => {
    const target = String(url);
    if (target === "https://na-russia.org/" || target === SPIRITUAL_SOURCE_URL) sources.push(target);
    if (target === "https://generativelanguage.googleapis.com/v1beta/interactions") geminiCalls += 1;
    return baseFetch(url, options);
  });

  const summary = await runDailyBroadcast(
    { DB: db, BOT_TOKEN: "test", GEMINI_API_KEY: "test" },
    { force: false, today: broadcastToday }
  );

  assert.deepEqual(sources, [SPIRITUAL_SOURCE_URL]);
  assert.equal(geminiCalls, 1);
  assert.deepEqual(sent.map((message) => message.chat_id), [2]);
  assert.deepEqual(summary.russian, { status: "ready", sent: 0, skipped: 2, errors: 0 });
  assert.deepEqual(summary.spiritual, { status: "ready", sent: 1, skipped: 1, errors: 0 });
});

test("a new active subscriber without markers makes both materials pending again", async (t) => {
  const db = new FakeDB();
  for (const chatId of [1, 2, 3, 4, 5, 6]) {
    db.subscribers.set(chatId, { chat_id: chatId, active: 1 });
    db.markers.add(`daily:russian:2026-09-08:${chatId}`);
    db.markers.add(`daily:spiritual:2026-09-08:${chatId}`);
  }
  const sent = [];
  const sources = [];
  let geminiCalls = 0;
  const baseFetch = dailySourcesFetch(sent);
  t.mock.method(globalThis, "fetch", (url, options) => {
    const target = String(url);
    if (target === "https://na-russia.org/" || target === SPIRITUAL_SOURCE_URL) sources.push(target);
    if (target === "https://generativelanguage.googleapis.com/v1beta/interactions") geminiCalls += 1;
    return baseFetch(url, options);
  });
  const env = { DB: db, BOT_TOKEN: "test", GEMINI_API_KEY: "test" };

  const complete = await runDailyBroadcast(env, { force: false, today: broadcastToday });
  assert.deepEqual(sources, []);
  assert.deepEqual(sent, []);
  assert.equal(complete.russian.skipped, 6);
  assert.equal(complete.spiritual.skipped, 6);

  db.subscribers.set(7, { chat_id: 7, active: 1 });
  const withNewSubscriber = await runDailyBroadcast(env, { force: false, today: broadcastToday });

  assert.deepEqual(sources, ["https://na-russia.org/", SPIRITUAL_SOURCE_URL]);
  assert.equal(geminiCalls, 1);
  assert.deepEqual(sent.map((message) => message.chat_id), [7, 7]);
  assert.equal(withNewSubscriber.russian.sent, 1);
  assert.equal(withNewSubscriber.russian.skipped, 6);
  assert.equal(withNewSubscriber.spiritual.sent, 1);
  assert.equal(withNewSubscriber.spiritual.skipped, 6);
});

test("stale Spiritual is reported without sending it and does not block current Russian Daily", async (t) => {
  const db = new FakeDB();
  db.subscribers.set(1, { chat_id: 1, active: 1 });
  const sent = [];
  const logs = [];
  t.mock.method(console, "log", (message) => logs.push(JSON.parse(message)));
  const baseFetch = dailySourcesFetch(sent);
  t.mock.method(globalThis, "fetch", (url, options) => {
    if (String(url) === SPIRITUAL_SOURCE_URL) {
      return Promise.resolve(new Response(currentSpadnaFixture.replace("September 08, 2026", "September 07, 2026")));
    }
    return baseFetch(url, options);
  });

  const summary = await runDailyBroadcast(
    { DB: db, BOT_TOKEN: "test", GEMINI_API_KEY: "test" },
    { force: false, today: broadcastToday }
  );

  assert.deepEqual(sent.map((message) => message.chat_id), [1]);
  assert.equal(summary.russian.sent, 1);
  assert.deepEqual(summary.spiritual, {
    status: "not_updated",
    sent: 0,
    skipped: 0,
    errors: 0,
    sourceDate: "September 07, 2026",
    todayKey: "2026-09-08",
    todayHour: 10
  });
  assert.deepEqual(logs, [{
    event: "spiritual_date_mismatch",
    source_date: "September 07, 2026",
    today_key: "2026-09-08",
    today_hour: 10
  }]);
});

test("one source failure does not block the other material", async (t) => {
  const db = new FakeDB();
  db.subscribers.set(1, { chat_id: 1, active: 1 });
  const sent = [];
  const baseFetch = dailySourcesFetch(sent);
  t.mock.method(globalThis, "fetch", (url, options) => {
    if (String(url) === "https://na-russia.org/") return Promise.resolve(new Response("unavailable", { status: 503 }));
    return baseFetch(url, options);
  });

  const summary = await runDailyBroadcast(
    { DB: db, BOT_TOKEN: "test", GEMINI_API_KEY: "test" },
    { force: false, today: broadcastToday }
  );

  assert.equal(summary.russian.status, "error");
  assert.equal(summary.spiritual.sent, 1);
  assert.deepEqual(sent.map((message) => message.chat_id), [1]);
});

test("force broadcast sends despite markers and reuses the prepared daily cache", async (t) => {
  const db = new FakeDB();
  db.subscribers.set(1, { chat_id: 1, active: 1 });
  db.markers.add("daily:russian:2026-09-08:1");
  db.markers.add("daily:spiritual:2026-09-08:1");
  const sent = [];
  const sourceCalls = { count: 0 };
  t.mock.method(globalThis, "fetch", countedDailySourcesFetch(sent, sourceCalls));
  const env = { DB: db, BOT_TOKEN: "test", GEMINI_API_KEY: "test" };

  const first = await runDailyBroadcast(env, { force: true, today: broadcastToday });
  const second = await runDailyBroadcast(env, { force: true, today: broadcastToday });

  assert.deepEqual(sent.map((message) => message.chat_id), [1, 1, 1, 1]);
  assert.equal(first.russian.sent, 1);
  assert.equal(first.spiritual.sent, 1);
  assert.equal(second.russian.sent, 1);
  assert.equal(second.spiritual.sent, 1);
  assert.equal(sourceCalls.count, 2);
  assert.equal(db.markers.has("daily:russian:2026-09-08:1"), true);
  assert.equal(db.markers.has("daily:spiritual:2026-09-08:1"), true);
});

test("owner broadcast command sends a summary report to OWNER_ID", async (t) => {
  installTimingSafeEqual(t);
  const sent = [];
  t.mock.method(globalThis, "fetch", telegramFetch(sent));
  const response = await dailyWorker.fetch(webhookRequest("/daily_for_all"), {
    DB: new FakeDB(),
    BOT_TOKEN: "test",
    OWNER_ID: "77",
    TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    GEMINI_API_KEY: "unused"
  }, { waitUntil() { throw new Error("waitUntil must not be used"); } });

  assert.equal(response.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, "77");
  assert.match(sent[0].text, /daily_for_all/);
  assert.match(sent[0].text, /Active subscribers: 0/);
  assert.match(sent[0].text, /Ежедневник/);
  assert.match(sent[0].text, /Духовные принципы/);
});

test("duplicate /daily_force_all update_id runs the broadcast only once", async (t) => {
  installTimingSafeEqual(t);
  const db = new FakeDB();
  db.subscribers.set(1, { chat_id: 1, active: 1 });
  const sent = [];
  const sourceCalls = { count: 0 };
  t.mock.method(globalThis, "fetch", countedDailySourcesFetch(sent, sourceCalls));
  const env = {
    DB: db,
    BOT_TOKEN: "test",
    OWNER_ID: "77",
    TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    GEMINI_API_KEY: "unused"
  };
  const ctx = { waitUntil() { throw new Error("waitUntil must not be used"); } };

  const first = await dailyWorker.fetch(webhookRequest("/daily_force_all", 77, 5001), env, ctx);
  const duplicate = await dailyWorker.fetch(webhookRequest("/daily_force_all", 77, 5001), env, ctx);

  assert.equal(first.status, 200);
  assert.equal(duplicate.status, 200);
  assert.equal(sourceCalls.count, 2);
  assert.equal(db.markers.has("command:daily_force_all:5001"), true);
  assert.equal(sent.filter((message) => message.text?.includes("/daily_force_all")).length, 1);
});

test("different /daily_force_all update_id values run separate force broadcasts", async (t) => {
  installTimingSafeEqual(t);
  const db = new FakeDB();
  db.subscribers.set(1, { chat_id: 1, active: 1 });
  const sent = [];
  const sourceCalls = { count: 0 };
  t.mock.method(globalThis, "fetch", countedDailySourcesFetch(sent, sourceCalls));
  const env = {
    DB: db,
    BOT_TOKEN: "test",
    OWNER_ID: "77",
    TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    GEMINI_API_KEY: "unused"
  };
  const ctx = { waitUntil() { throw new Error("waitUntil must not be used"); } };

  await dailyWorker.fetch(webhookRequest("/daily_force_all", 77, 5002), env, ctx);
  await dailyWorker.fetch(webhookRequest("/daily_force_all", 77, 5003), env, ctx);

  assert.equal(sourceCalls.count, 4);
  assert.equal(db.markers.has("command:daily_force_all:5002"), true);
  assert.equal(db.markers.has("command:daily_force_all:5003"), true);
  assert.equal(sent.filter((message) => message.text?.includes("/daily_force_all")).length, 2);
});

test("/daily_for_all deduplicates the same update_id and accepts a new one", async (t) => {
  installTimingSafeEqual(t);
  const db = new FakeDB();
  db.subscribers.set(1, { chat_id: 1, active: 1 });
  const sent = [];
  const sourceCalls = { count: 0 };
  t.mock.method(globalThis, "fetch", countedDailySourcesFetch(sent, sourceCalls));
  const env = {
    DB: db,
    BOT_TOKEN: "test",
    OWNER_ID: "77",
    TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    GEMINI_API_KEY: "unused"
  };
  const ctx = { waitUntil() { throw new Error("waitUntil must not be used"); } };

  await dailyWorker.fetch(webhookRequest("/daily_for_all", 77, 6001), env, ctx);
  await dailyWorker.fetch(webhookRequest("/daily_for_all", 77, 6001), env, ctx);
  await dailyWorker.fetch(webhookRequest("/daily_for_all", 77, 6002), env, ctx);

  assert.equal(sourceCalls.count, 4);
  assert.equal(db.markers.has("command:daily_for_all:6001"), true);
  assert.equal(db.markers.has("command:daily_for_all:6002"), true);
  assert.equal(sent.filter((message) => message.text?.includes("/daily_for_all")).length, 2);
});

test("summary shows FORCE mode and material counters", () => {
  const text = formatBroadcastSummary("/daily_force_all", {
    activeSubscribers: 12,
    force: true,
    russian: { status: "ready", sent: 12, skipped: 0, errors: 0 },
    spiritual: {
      status: "not_updated",
      sent: 0,
      skipped: 0,
      errors: 0,
      sourceDate: "September 08, 2026",
      todayKey: "2026-09-09",
      todayHour: 9
    },
    deactivated: 1
  });
  assert.match(text, /Mode: FORCE/);
  assert.match(text, /sent: 12/);
  assert.match(text, /status: ещё не обновлён/);
  assert.match(text, /source date: September 08, 2026/);
  assert.match(text, /worker today: 2026-09-09/);
  assert.match(text, /worker hour: 9/);
  assert.match(text, /deactivated: 1/);
});

test("Daily Cron handler remains explicitly configured for silent normal mode", async () => {
  const source = await readFile(new URL("../src/daily-gemini.js", import.meta.url), "utf8");
  assert.match(source, /runDailyBroadcast\(env, \{ force: false, today \}\)/);
  assert.doesNotMatch(source, /checkScheduledDaily[\s\S]*?notifyRussianStale: true/);
  assert.doesNotMatch(source, /checkScheduledDaily[\s\S]*?force: true/);
  assert.equal(getBishkekDate(new Date("2026-09-08T03:00:00Z")).hour, 9);
});

test("scheduled stale Russian source does not send an OWNER notification", async (t) => {
  const db = new FakeDB();
  db.subscribers.set(1, { chat_id: 1, active: 1 });
  db.markers.add("daily:spiritual:2026-09-08:1");
  const sourceRequests = [];
  const telegramMessages = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const target = String(url);
    if (target === "https://na-russia.org/") {
      sourceRequests.push(target);
      return new Response(russianPreviewFixture.replace("8 сентября", "7 сентября"));
    }
    if (target === SPIRITUAL_SOURCE_URL) {
      sourceRequests.push(target);
      return new Response(currentSpadnaFixture);
    }
    if (target.startsWith("https://api.telegram.org/bot")) {
      telegramMessages.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  });

  await checkScheduledDaily(
    { DB: db, BOT_TOKEN: "test", OWNER_ID: "77" },
    { ...broadcastToday, minute: 15 }
  );

  assert.deepEqual(sourceRequests, ["https://na-russia.org/"]);
  assert.deepEqual(telegramMessages, []);
});

test("scheduled recognizes both Daily Cron expressions", async () => {
  const tasks = [];
  const env = { DB: new FakeDB() };
  const ctx = { waitUntil(promise) { tasks.push(promise); } };

  for (const cron of DAILY_CRONS) dailyWorker.scheduled({ cron }, env, ctx);

  assert.equal(tasks.length, 2);
  await Promise.all(tasks);
});

test("08:55 Bishkek preparation cron fills cache without sending", async (t) => {
  const db = new FakeDB();
  const sent = [];
  t.mock.method(globalThis, "fetch", dailySourcesFetch(sent));
  const tasks = [];

  dailyWorker.scheduled(
    { cron: DAILY_PREPARE_CRON },
    { DB: db, BOT_TOKEN: "test", GEMINI_API_KEY: "test" },
    { waitUntil(promise) { tasks.push(promise); } }
  );
  await Promise.all(tasks);

  assert.equal(tasks.length, 1);
  assert.equal(db.dailyCache.size, 0, "fixture date differs from the real Bishkek date");
  assert.deepEqual(sent, []);
});

test("checkScheduledDaily allows 13:59 and 14:00 but stops outside the safety window", async () => {
  const dailyRuns = [];
  const env = {
    DB: {
      prepare(sql) {
        assert.match(sql, /SELECT chat_id FROM subscribers/);
        return { async all() { dailyRuns.push(sql); return { results: [] }; } };
      }
    }
  };
  const today = (hour, minute) => ({
    key: "2026-09-08", year: 2026, month: 9, day: 8, hour, minute
  });

  await checkScheduledDaily(env, today(8, 59));
  assert.equal(dailyRuns.length, 0);
  await checkScheduledDaily(env, today(13, 59));
  assert.equal(dailyRuns.length, 1);
  await checkScheduledDaily(env, today(14, 0));
  assert.equal(dailyRuns.length, 2);
  await checkScheduledDaily(env, today(14, 1));
  assert.equal(dailyRuns.length, 2);
});

test("/daily sends today's cached materials without source or model calls", async (t) => {
  installTimingSafeEqual(t);

  const telegramMessages = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith("https://api.telegram.org/bot")) {
      telegramMessages.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, result: { message_id: telegramMessages.length } }), {
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  });

  const backgroundTasks = [];
  const previewDb = new FakeDB();
  const today = getBishkekDate();
  previewDb.dailyCache.set(`russian:${today.key}`, {
    content_type: "russian",
    date_key: today.key,
    source_date: `${today.day} сентября`,
    payload: JSON.stringify({ date: `${today.day} сентября`, title: "Тема", body: "Ежедневник" })
  });
  const englishDate = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bishkek",
    month: "long",
    day: "2-digit",
    year: "numeric"
  }).format(new Date());
  previewDb.dailyCache.set(`spiritual:${today.key}`, {
    content_type: "spiritual",
    date_key: today.key,
    source_date: englishDate,
    payload: JSON.stringify({ date: `${today.day} сентября`, title: "Принцип", body: "Перевод" })
  });
  const invocation = dailyWorker.fetch(webhookRequest("/daily"), {
    DB: previewDb,
    BOT_TOKEN: "test",
    OWNER_ID: "77",
    TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    GEMINI_API_KEY: "test"
  }, { waitUntil(promise) { backgroundTasks.push(promise); } });

  const response = await invocation;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "OK");
  assert.equal(telegramMessages.length, 2);
  assert.match(telegramMessages[0].text, /Ежедневник/);
  assert.match(telegramMessages[1].text, /Перевод/);
  assert.equal(backgroundTasks.length, 0);
  assert.equal(previewDb.markers.size, 0);
});

test("Daily, Saturday and Thursday Cron expressions remain configured", async () => {
  const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.deepEqual(DAILY_CRONS, ["*/15 3-7 * * *", "0 8 * * *"]);
  assert.equal(DAILY_PREPARE_CRON, "55 2 * * *");
  assert.match(config, /"55 2 \* \* \*"/);
  assert.match(config, /"\*\/15 3-7 \* \* \*"/);
  assert.match(config, /"0 8 \* \* \*"/);
  assert.doesNotMatch(config, /"\*\/15 3-17 \* \* \*"/);
  assert.match(config, /"0 11 \* \* SAT"/);
  assert.match(config, /"0 13 \* \* THU"/);
});
