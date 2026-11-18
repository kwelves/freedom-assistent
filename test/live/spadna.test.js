import assert from "node:assert/strict";
import test from "node:test";

import {
  getBishkekDate,
  isCurrentEnglishDate,
  parseSpiritualPrinciple,
  spiritualSourceUrl
} from "../../src/daily-gemini.js";

test("spad.na.org returns today's Bishkek reading and it parses", async () => {
  const today = getBishkekDate();
  const response = await fetch(spiritualSourceUrl(today), { headers: { "user-agent": "FreedomHelperBot/1.0" } });
  assert.equal(response.ok, true, `spad.na.org returned ${response.status}`);
  const reading = await response.json();
  assert.equal(typeof reading.html, "string");
  const parsed = parseSpiritualPrinciple(reading.html);
  assert.ok(parsed.date);
  assert.ok(parsed.title);
  assert.ok(parsed.quote);
  assert.ok(parsed.body);
  assert.ok(parsed.thought);
  assert.equal(isCurrentEnglishDate(parsed.date, today), true, `spad.na.org date is stale: ${parsed.date}`);
});
