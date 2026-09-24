import assert from "node:assert/strict";
import test from "node:test";

import { isCurrentEnglishDate, parseSpiritualPrinciple, SPIRITUAL_SOURCE_URL } from "../../src/daily-gemini.js";

test("current spad.na.org HTML is parsed", async () => {
  const response = await fetch(SPIRITUAL_SOURCE_URL, { headers: { "user-agent": "FreedomHelperBot/1.0" } });
  assert.equal(response.ok, true, `spad.na.org returned ${response.status}`);
  const parsed = parseSpiritualPrinciple(await response.text());
  assert.ok(parsed.date);
  assert.ok(parsed.title);
  assert.ok(parsed.quote);
  assert.ok(parsed.body);
  assert.ok(parsed.thought);

  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bishkek",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  assert.equal(isCurrentEnglishDate(parsed.date, {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day)
  }), true, `spad.na.org date is stale: ${parsed.date}`);
});
