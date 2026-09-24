import assert from "node:assert/strict";
import test from "node:test";

import { handleUpdate } from "../src/index.js";
import worker from "../src/schedule-fix.js";
import { FakeDB, telegramFetch } from "./helpers.js";

test("new_chat_members still records username and sends a welcome reply", async (t) => {
  const db = new FakeDB();
  const sent = [];
  t.mock.method(globalThis, "fetch", telegramFetch(sent));

  await handleUpdate({ message: {
    message_id: 20,
    chat: { id: -10001, type: "supergroup" },
    new_chat_members: [{ id: 91, username: "member", first_name: "Member", is_bot: false }]
  } }, { DB: db, BOT_TOKEN: "test" });

  assert.equal(db.usernames.has("@member"), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, -10001);
  assert.equal(sent[0].reply_parameters.message_id, 20);
});

test("Saturday group reminder stays and Thursday reminder is not sent", async (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", telegramFetch(sent));
  const saturdayWaits = [];
  worker.scheduled(
    { cron: "0 11 * * SAT", scheduledTime: Date.UTC(2026, 8, 12, 11) },
    { DB: new FakeDB(), BOT_TOKEN: "test", CHAT_ID: -10001 },
    { waitUntil(promise) { saturdayWaits.push(promise); } }
  );
  await Promise.all(saturdayWaits);
  assert.match(sent.at(-1).text, /19:00/);
  assert.equal(sent.at(-1).chat_id, -10001);

  const beforeThursday = sent.length;
  const thursdayWaits = [];
  worker.scheduled(
    { cron: "0 13 * * THU", scheduledTime: Date.UTC(2026, 8, 10, 13) },
    { DB: new FakeDB(), BOT_TOKEN: "test", CHAT_ID: -10001 },
    { waitUntil(promise) { thursdayWaits.push(promise); } }
  );
  await Promise.all(thursdayWaits);
  assert.equal(thursdayWaits.length, 0);
  assert.equal(sent.length, beforeThursday);
});
