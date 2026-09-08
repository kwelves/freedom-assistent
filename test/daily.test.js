import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { handleUpdate } from "../src/index.js";
import dailyWorker, {
  HOURLY_CRON,
  isCurrentEnglishDate,
  parseSpiritualPrinciple,
  processSpiritualDaily,
  sendDailyToSubscribers
} from "../src/daily-gemini.js";
import { currentSpadnaFixture, FakeDB, telegramFetch } from "./helpers.js";

const russianPreviewFixture = `
<div class="text-lg font-bold">Тема дня</div>
<div data-qa="meditation-date">8 сентября</div>
<div class="text-md italic">Цитата</div>
<div class="text-md text-secondary-blue">Источник</div>
<div class="text-md mt-8"><p>Основной текст</p></div>
<div class="order-2"></div>`;

test("spadna parser extracts all required fields", () => {
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

test("/daily waits for preview completion instead of using waitUntil", async (t) => {
  const originalTimingSafeEqual = crypto.subtle.timingSafeEqual;
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
    if (originalTimingSafeEqual) {
      Object.defineProperty(crypto.subtle, "timingSafeEqual", { configurable: true, value: originalTimingSafeEqual });
    } else {
      delete crypto.subtle.timingSafeEqual;
    }
  });

  const geminiStarted = Promise.withResolvers();
  const releaseGemini = Promise.withResolvers();
  const telegramMessages = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const target = String(url);
    if (target === "https://na-russia.org/") return new Response(russianPreviewFixture);
    if (target === "https://www.spadna.org/") return new Response(currentSpadnaFixture);
    if (target === "https://generativelanguage.googleapis.com/v1beta/interactions") {
      geminiStarted.resolve();
      await releaseGemini.promise;
      return new Response(JSON.stringify({
        steps: [{ type: "model_output", content: [{ type: "text", text: "8 сентября 2026\nПереведённая тема\nПереведённый текст" }] }]
      }), { headers: { "content-type": "application/json" } });
    }
    if (target.startsWith("https://api.telegram.org/bot")) {
      telegramMessages.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, result: { message_id: telegramMessages.length } }), {
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  });

  const backgroundTasks = [];
  const request = new Request("https://worker.example/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "hook-secret"
    },
    body: JSON.stringify({ message: {
      message_id: 12,
      text: "/daily",
      chat: { id: 77, type: "private" },
      from: { id: 77, username: "owner", first_name: "Owner" }
    } })
  });
  const invocation = dailyWorker.fetch(request, {
    DB: new FakeDB(),
    BOT_TOKEN: "test",
    OWNER_ID: "77",
    TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    GEMINI_API_KEY: "test"
  }, { waitUntil(promise) { backgroundTasks.push(promise); } });

  let completed = false;
  invocation.then(() => { completed = true; });
  await geminiStarted.promise;
  assert.equal(completed, false);
  assert.equal(backgroundTasks.length, 0);

  releaseGemini.resolve();
  const response = await invocation;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "OK");
  assert.equal(telegramMessages.length, 3);
  assert.match(telegramMessages.at(-1).text, /Переведённый текст/);
});

test("hourly, Saturday and Thursday Cron expressions remain configured", async () => {
  const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.equal(HOURLY_CRON, "0 * * * *");
  assert.match(config, /"0 \* \* \* \*"/);
  assert.match(config, /"0 11 \* \* SAT"/);
  assert.match(config, /"0 13 \* \* THU"/);
});
