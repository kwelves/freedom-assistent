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

test("Thursday and Saturday Group reminders keep their existing meeting times", async (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", telegramFetch(sent));

  for (const [cron, expectedTime, scheduledTime] of [
    ["0 13 * * THU", "21:00", Date.UTC(2026, 8, 10, 13)],
    ["0 11 * * SAT", "19:00", Date.UTC(2026, 8, 12, 11)]
  ]) {
    const waits = [];
    worker.scheduled(
      { cron, scheduledTime },
      { DB: new FakeDB(), BOT_TOKEN: "test", CHAT_ID: -10001 },
      { waitUntil(promise) { waits.push(promise); } }
    );
    await Promise.all(waits);
    assert.match(sent.at(-1).text, new RegExp(expectedTime.replace(":", "\\:")));
    assert.equal(sent.at(-1).chat_id, -10001);
  }
});
