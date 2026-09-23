import worker from "./schedule-fix.js";
import { translateForDaily, translateToRussian } from "./translate.js";

export const DAILY_CRONS = ["*/15 3-7 * * *", "0 8 * * *"];
export const DAILY_PREPARE_CRON = "55 2 * * *";
const BISHKEK_TIME_ZONE = "Asia/Bishkek";
const SPIRITUAL_TIME_ZONE = BISHKEK_TIME_ZONE;
const DAILY_START_HOUR = 9;
const DAILY_END_HOUR = 14;
const RUSSIAN_SOURCE_URL = "https://na-russia.org/";
export const SPIRITUAL_SOURCE_URL = `https://na.org/spadna/?timeZone=${encodeURIComponent(SPIRITUAL_TIME_ZONE)}`;

export default {
  async fetch(request, env, ctx) {
    const workerResponse = await worker.fetch(request.clone(), env, ctx);
    if (!workerResponse.ok) return workerResponse;

    const update = await request.json().catch(() => null);
    const message = update?.message;
    const command = message?.text?.trim().toLowerCase().split(/\s+/)[0]?.split("@")[0];
    const isOwner = String(message?.from?.id) === String(env.OWNER_ID);

    if (command === "/daily" && isOwner) {
      const today = getBishkekDate();
      try {
        const prepared = await prepareDailyCache(env, today);
        await sendDailyPreviewFromCache(env, message.chat.id, today);
        const report = describeDailyProblems(today, prepared);
        if (report) await sendMessage(env, message.chat.id, report);
      } catch (error) {
        await sendMessage(
          env,
          message.chat.id,
          `⚠️ Команда /daily сломалась.\nГде: подготовка или отправка текста.\nЧто случилось: ${String(error).slice(0, 500)}`
        );
      }
      return new Response("OK");
    }

    if ((command === "/daily_for_all" || command === "/daily_force_all") && isOwner) {
      if (!await claimDailyBroadcastCommand(env, command, update?.update_id)) {
        return new Response("OK");
      }
      const force = command === "/daily_force_all";
      const summary = await runDailyBroadcast(env, { force });
      await sendMessage(env, env.OWNER_ID, formatBroadcastSummary(command, summary));
      return new Response("OK");
    }

    return workerResponse;
  },

  scheduled(controller, env, ctx) {
    if (controller.cron === DAILY_PREPARE_CRON) {
      ctx.waitUntil(prepareDailyCache(env));
      return;
    }
    if (DAILY_CRONS.includes(controller.cron)) {
      ctx.waitUntil(checkScheduledDaily(env));
      return;
    }
    return worker.scheduled(controller, env, ctx);
  }
};

export async function checkScheduledDaily(env, today = getBishkekDate()) {
  if (today.hour < DAILY_START_HOUR
    || today.hour > DAILY_END_HOUR
    || (today.hour === DAILY_END_HOUR && today.minute > 0)) return;

  try {
    await runDailyBroadcast(env, { force: false, today });
  } catch (error) {
    console.error(JSON.stringify({ event: "scheduled_daily_check_failed", error: String(error) }));
  }
}

export async function runDailyBroadcast(env, { force = false, notifyRussianStale = false, today = getBishkekDate() } = {}) {
  const subscribers = await getActiveSubscribers(env);
  const recipients = includeOwner(subscribers, env);
  const summary = {
    activeSubscribers: subscribers.length,
    force,
    russian: createMaterialSummary(),
    spiritual: createMaterialSummary(),
    deactivated: 0
  };
  if (!recipients.length) return summary;

  const deactivatedChatIds = new Set();
  const deliveryProblems = [];
  let pendingRussian = recipients;
  let pendingSpiritual = recipients;
  if (!force) {
    [pendingRussian, pendingSpiritual] = await Promise.all([
      getPendingSubscribers(env, "russian", today.key, recipients),
      getPendingSubscribers(env, "spiritual", today.key, recipients)
    ]);
    if (!pendingRussian.length && !pendingSpiritual.length) {
      summary.russian.skipped = recipients.length;
      summary.spiritual.skipped = recipients.length;
      return summary;
    }
  }

  const shouldFetchRussian = force || pendingRussian.length > 0;
  const shouldFetchSpiritual = force || pendingSpiritual.length > 0;
  let cache = { errors: {}, notUpdated: {}, translation: null };
  try {
    cache = await prepareDailyCache(env, today, {
      russian: shouldFetchRussian,
      spiritual: shouldFetchSpiritual
    });
  } catch (error) {
    if (shouldFetchRussian) markMaterialError(summary.russian, error);
    if (shouldFetchSpiritual) markMaterialError(summary.spiritual, error);
    cache.errors = {
      ...(shouldFetchRussian ? { russian: error } : {}),
      ...(shouldFetchSpiritual ? { spiritual: error } : {})
    };
    await reportDailyProblems(env, today, { ...cache, sendFailures: deliveryProblems });
    return summary;
  }

  if (!shouldFetchRussian) {
    summary.russian.skipped = recipients.length;
  } else if (cache.errors.russian) {
    markMaterialError(summary.russian, cache.errors.russian);
  } else if (!cache.russian) {
    summary.russian.status = "not_updated";
    if (notifyRussianStale) {
      await sendMessage(env, env.OWNER_ID, "⌛ Дата Ежедневника ещё не изменилась. Проверю снова через час.");
    }
  } else {
    Object.assign(summary.russian, await sendDailyToSubscribers(
      env,
      "russian",
      today.key,
      "ЕЖЕДНЕВНИК",
      cache.russian.payload,
      recipients,
      { force, deactivatedChatIds, deliveryProblems }
    ));
  }

  if (!shouldFetchSpiritual) {
    summary.spiritual.skipped = recipients.length;
  } else if (cache.errors.spiritual) {
    markMaterialError(summary.spiritual, cache.errors.spiritual);
  } else if (!cache.spiritual) {
    Object.assign(summary.spiritual, {
      status: "not_updated",
      ...(cache.notUpdated.spiritual ? {
        sourceDate: cache.notUpdated.spiritual,
        todayKey: today.key,
        todayHour: today.hour
      } : {})
    });
  } else {
    const pendingSubscribers = (force ? recipients : pendingSpiritual)
      .filter((chatId) => !deactivatedChatIds.has(chatId));
    if (!pendingSubscribers.length) {
      summary.spiritual.skipped = recipients.length - deactivatedChatIds.size;
    } else {
      Object.assign(summary.spiritual, await sendDailyToSubscribers(
        env,
        "spiritual",
        today.key,
        "ДУХОВНЫЕ ПРИНЦИПЫ",
        cache.spiritual.payload,
        recipients,
        { force, deactivatedChatIds, deliveryProblems }
      ));
    }
  }

  summary.deactivated = deactivatedChatIds.size;
  await reportDailyProblems(env, today, { ...cache, sendFailures: deliveryProblems });
  return summary;
}

function includeOwner(subscribers, env) {
  const ownerId = String(env.OWNER_ID || "").trim();
  if (!ownerId || subscribers.some((chatId) => String(chatId) === ownerId)) return subscribers;
  return [...subscribers, ownerId];
}

export function describeDailyProblems(today, prepared = {}) {
  const blocks = [];
  if (prepared.errors?.russian) {
    blocks.push([
      "Ежедневник не подготовлен.",
      "Где сломалось: чтение сайта na-russia.org.",
      `Что случилось: ${cleanError(prepared.errors.russian)}`
    ].join("\n"));
  } else if (prepared.notUpdated?.russian) {
    blocks.push([
      "Ежедневник не отправлен.",
      "Где сломалось: дата на сайте na-russia.org.",
      `На сайте: ${prepared.notUpdated.russian}. Сегодня: ${today.day}.${today.month}.${today.year}.`
    ].join("\n"));
  }

  const translation = prepared.translation;
  if (prepared.errors?.spiritual) {
    blocks.push([
      "Духовные принципы не подготовлены.",
      "Где сломалось: источник или перевод.",
      `Что случилось: ${cleanError(prepared.errors.spiritual)}`,
      formatTranslationChain(translation)
    ].filter(Boolean).join("\n"));
  } else if (prepared.notUpdated?.spiritual) {
    blocks.push([
      "Духовные принципы не отправлены.",
      "Где сломалось: дата на сайте na.org.",
      `На сайте: ${prepared.notUpdated.spiritual}. Сегодня: ${today.key}.`
    ].join("\n"));
  } else if (translation?.failures?.length) {
    blocks.push([
      `Духовные принципы переведены через ${providerLabel(translation.provider)}, не с первой попытки.`,
      "Где в цепочке была проблема:",
      formatTranslationChain(translation)
    ].join("\n"));
  }

  for (const failure of prepared.sendFailures || []) blocks.push(failure);
  if (!blocks.length) return "";
  return [`⚠️ Отчёт за ${today.key}`, ...blocks].join("\n\n");
}

async function reportDailyProblems(env, today, prepared) {
  const text = describeDailyProblems(today, prepared);
  if (!text || !env.OWNER_ID) return;
  const marker = `owner-report:${today.key}:${reportKey(text)}`;
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO sent_reminders (reminder_key) VALUES (?)"
  ).bind(marker).run();
  if (!inserted.meta.changes) return;
  try {
    await sendMessage(env, env.OWNER_ID, text);
  } catch (error) {
    await env.DB.prepare("DELETE FROM sent_reminders WHERE reminder_key = ?").bind(marker).run();
    console.error(JSON.stringify({ event: "owner_report_failed", error: String(error) }));
  }
}

function formatTranslationChain(translation) {
  if (!translation) return "";
  const lines = [];
  let step = 1;
  for (const failure of translation.failures || []) {
    lines.push(`${step}. ${providerLabel(failure.provider)} — ошибка: ${cleanError(failure.error)}`);
    step += 1;
  }
  for (const provider of translation.skipped || []) {
    lines.push(`${step}. ${providerLabel(provider)} — пропущен, нет доступа`);
    step += 1;
  }
  if (translation.provider) {
    lines.push(`${step}. ${providerLabel(translation.provider)} — получилось`);
  }
  return lines.join("\n");
}

function providerLabel(provider) {
  return { "workers-ai": "Cloudflare", groq: "Groq", gemini: "Gemini" }[provider] || provider || "неизвестно";
}

function cleanError(error) {
  return String(error).replace(/^Error:\s*/, "").slice(0, 300);
}

function reportKey(text) {
  let value = 0;
  for (const char of text) value = (value * 33 + char.codePointAt(0)) >>> 0;
  return value.toString(16);
}

function createMaterialSummary() {
  return { status: "ready", sent: 0, skipped: 0, errors: 0 };
}

function markMaterialError(material, error) {
  material.status = "error";
  material.errors += 1;
  material.error = String(error).slice(0, 300);
}

async function claimDailyBroadcastCommand(env, command, updateId) {
  if (!Number.isInteger(updateId)) return false;
  const marker = `command:${command.slice(1)}:${updateId}`;
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO sent_reminders (reminder_key) VALUES (?)"
  ).bind(marker).run();
  return result.meta.changes === 1;
}

export function formatBroadcastSummary(command, summary) {
  const materialLines = (title, material) => {
    const status = material.status === "not_updated"
      ? "\nstatus: ещё не обновлён"
      : material.status === "error"
        ? "\nstatus: ошибка источника/обработки"
        : "";
    const dateMismatch = material.status === "not_updated" && material.sourceDate !== undefined
      ? `\nsource date: ${material.sourceDate}\nworker today: ${material.todayKey}\nworker hour: ${material.todayHour}`
      : "";
    return `${title}:${status}${dateMismatch}\nsent: ${material.sent}\nskipped: ${material.skipped}\nerrors: ${material.errors}`;
  };
  return [
    `✅ ${command} завершена`,
    `Active subscribers: ${summary.activeSubscribers}`,
    ...(summary.force ? ["Mode: FORCE"] : []),
    materialLines("Ежедневник", summary.russian),
    materialLines("Духовные принципы", summary.spiritual),
    `deactivated: ${summary.deactivated}`
  ].join("\n\n");
}

export async function prepareDailyCache(
  env,
  today = getBishkekDate(),
  requested = { russian: true, spiritual: true }
) {
  const cache = await getDailyCache(env, today);
  const errors = {};
  const notUpdated = {};
  const tasks = [];
  let translation = null;

  if (requested.russian && !cache.russian) {
    tasks.push((async () => {
      try {
        const meditation = parseRussianMeditation(await fetchPage(RUSSIAN_SOURCE_URL));
        if (!isCurrentRussianDate(meditation.date, today)) {
          notUpdated.russian = meditation.date;
          return;
        }
        await saveDailyCache(env, "russian", today.key, meditation.date, meditation);
        cache.russian = { sourceDate: meditation.date, payload: meditation };
      } catch (error) {
        errors.russian = error;
      }
    })());
  }

  if (requested.spiritual && !cache.spiritual) {
    tasks.push((async () => {
      try {
        const principle = parseSpiritualPrinciple(
          await fetchPage(SPIRITUAL_SOURCE_URL, { bypassCache: true })
        );
        if (!isCurrentEnglishDate(principle.date, today)) {
          notUpdated.spiritual = principle.date;
          console.log(JSON.stringify({
            event: "spiritual_date_mismatch",
            source_date: principle.date,
            today_key: today.key,
            today_hour: today.hour
          }));
          return;
        }
        const translated = await translateForDaily(env, principle.raw);
        translation = translated;
        const payload = splitDailyText(translated.text);
        await saveDailyCache(env, "spiritual", today.key, principle.date, payload);
        cache.spiritual = { sourceDate: principle.date, payload };
      } catch (error) {
        errors.spiritual = error;
        translation = {
          provider: null,
          failures: error.failures || [],
          skipped: error.skipped || []
        };
      }
    })());
  }

  await Promise.all(tasks);
  return { ...cache, errors, notUpdated, translation };
}

export async function getDailyCache(env, today = getBishkekDate()) {
  const result = await env.DB.prepare(
    "SELECT content_type, source_date, payload FROM daily_cache WHERE date_key = ?"
  ).bind(today.key).all();
  const cache = {};
  for (const row of result.results) {
    const isCurrent = row.content_type === "russian"
      ? isCurrentRussianDate(row.source_date, today)
      : row.content_type === "spiritual" && isCurrentEnglishDate(row.source_date, today);
    if (!isCurrent) continue;
    try {
      cache[row.content_type] = {
        sourceDate: row.source_date,
        payload: JSON.parse(row.payload)
      };
    } catch (error) {
      console.error(JSON.stringify({
        event: "daily_cache_invalid",
        content_type: row.content_type,
        date_key: today.key,
        error: String(error)
      }));
    }
  }
  return cache;
}

async function saveDailyCache(env, contentType, dateKey, sourceDate, payload) {
  await env.DB.prepare(`
    INSERT INTO daily_cache (content_type, date_key, source_date, payload)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(content_type, date_key) DO UPDATE SET
      source_date = excluded.source_date,
      payload = excluded.payload,
      created_at = CURRENT_TIMESTAMP
  `).bind(contentType, dateKey, sourceDate, JSON.stringify(payload)).run();
}

export async function processSpiritualDaily(env, html, today, subscribers) {
  const spiritualPrinciple = parseSpiritualPrinciple(html);
  if (!isCurrentEnglishDate(spiritualPrinciple.date, today)) return;

  const pendingSubscribers = await getPendingSubscribers(env, "spiritual", today.key, subscribers);
  if (!pendingSubscribers.length) return;

  const translation = await translateToRussian(env, spiritualPrinciple.raw);
  await sendDailyToSubscribers(
    env,
    "spiritual",
    today.key,
    "ДУХОВНЫЕ ПРИНЦИПЫ",
    splitDailyText(translation),
    pendingSubscribers
  );
}

export function getBishkekDate(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: BISHKEK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));

  return {
    key: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

export function isCurrentRussianDate(value, today) {
  const months = {
    января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
    июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12
  };
  const match = /(\d{1,2})\s+([а-яё]+)/iu.exec(value.toLowerCase());
  return Boolean(match) && Number(match[1]) === today.day && months[match[2]] === today.month;
}

export function isCurrentEnglishDate(value, today) {
  const match = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/.exec(value.trim());
  if (!match) return false;
  const months = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
  };
  return Number(match[3]) === today.year
    && months[match[1].toLowerCase()] === today.month
    && Number(match[2]) === today.day;
}

async function getActiveSubscribers(env) {
  const result = await env.DB.prepare("SELECT chat_id FROM subscribers WHERE active = 1").all();
  return result.results.map((row) => row.chat_id);
}

async function wasSent(env, key) {
  return Boolean(await env.DB.prepare("SELECT 1 FROM sent_reminders WHERE reminder_key = ?").bind(key).first());
}

async function getPendingSubscribers(env, contentType, dateKey, subscribers, deactivatedChatIds = new Set()) {
  const pending = [];
  for (const chatId of subscribers) {
    if (deactivatedChatIds.has(chatId)) continue;
    if (!await wasSent(env, `daily:${contentType}:${dateKey}:${chatId}`)) pending.push(chatId);
  }
  return pending;
}

async function sendDailyOnce(env, key, send) {
  const result = await env.DB.prepare("INSERT OR IGNORE INTO sent_reminders (reminder_key) VALUES (?)").bind(key).run();
  if (!result.meta.changes) return false;
  try {
    await send();
    return true;
  } catch (error) {
    await env.DB.prepare("DELETE FROM sent_reminders WHERE reminder_key = ?").bind(key).run();
    throw error;
  }
}

export async function sendDailyToSubscribers(
  env,
  contentType,
  dateKey,
  heading,
  content,
  subscribers,
  { force = false, deactivatedChatIds = new Set(), deliveryProblems = [] } = {}
) {
  const stats = { sent: 0, skipped: 0, errors: 0 };
  for (const chatId of subscribers) {
    if (deactivatedChatIds.has(chatId)) {
      stats.skipped += 1;
      continue;
    }
    const marker = `daily:${contentType}:${dateKey}:${chatId}`;
    if (!force && await wasSent(env, marker)) {
      stats.skipped += 1;
      continue;
    }

    try {
      if (force) {
        await sendDailyPost(env, chatId, heading, content);
        await env.DB.prepare("INSERT OR IGNORE INTO sent_reminders (reminder_key) VALUES (?)").bind(marker).run();
      } else {
        await sendDailyOnce(env, marker, () => sendDailyPost(env, chatId, heading, content));
      }
      stats.sent += 1;
    } catch (error) {
      stats.errors += 1;
      deliveryProblems.push(`${heading} не дошёл в чат ${chatId}: ${String(error).replace(/^Error:\s*/, "").slice(0, 180)}`);
      console.error(JSON.stringify({ event: "daily_recipient_failed", chat_id: chatId, error: String(error) }));
      if (isInactiveRecipientError(error)) {
        deactivatedChatIds.add(chatId);
        try {
          await env.DB.prepare("UPDATE subscribers SET active = 0 WHERE chat_id = ?").bind(chatId).run();
        } catch (deactivationError) {
          console.error(JSON.stringify({ event: "subscriber_deactivation_failed", chat_id: chatId, error: String(deactivationError) }));
        }
      }
    }
  }
  return stats;
}

function isInactiveRecipientError(error) {
  return /bot was blocked|chat not found|user is deactivated|bot was kicked/i.test(String(error));
}

async function sendDailyPreviewFromCache(env, chatId, today) {
  const cache = await getDailyCache(env, today);
  const missing = [];
  if (cache.russian) {
    await sendDailyPost(env, chatId, "ЕЖЕДНЕВНИК", cache.russian.payload);
  } else {
    missing.push("Ежедневник");
  }
  if (cache.spiritual) {
    await sendDailyPost(env, chatId, "ДУХОВНЫЕ ПРИНЦИПЫ", cache.spiritual.payload);
  } else {
    missing.push("Духовные принципы");
  }
  return { missing };
}

async function fetchPage(url, { bypassCache = false } = {}) {
  const response = await fetch(url, {
    ...(bypassCache ? { cache: "no-store" } : {}),
    headers: { "user-agent": "FreedomHelperBot/1.0" }
  });
  if (!response.ok) throw new Error(`Источник недоступен: ${url} (${response.status})`);
  return response.text();
}

function parseRussianMeditation(html) {
  const dateIndex = html.indexOf('data-qa="meditation-date"');
  const bodyClassIndex = html.indexOf('class="text-md mt-8">', dateIndex);
  const endIndex = html.indexOf('<div class="order-2', bodyClassIndex);
  if (dateIndex < 0 || bodyClassIndex < 0 || endIndex < 0) throw new Error("Не найдена медитация на na-russia.org");
  const beforeDate = html.slice(Math.max(0, dateIndex - 3000), dateIndex);
  const title = extractFirst(beforeDate.slice(beforeDate.lastIndexOf('class="text-lg font-bold">')), /class="text-lg font-bold">([\s\S]*?)<\/div>/);
  const date = extractFirst(html.slice(dateIndex), /data-qa="meditation-date">([\s\S]*?)<\/div>/);
  const afterDate = html.slice(dateIndex, bodyClassIndex);
  const quote = extractFirst(afterDate, /class="text-md italic">([\s\S]*?)<\/div>/);
  const source = extractFirst(afterDate, /class="text-md text-secondary-blue[^>]*">([\s\S]*?)<\/div>/);
  const body = htmlToText(html.slice(html.lastIndexOf("<div", bodyClassIndex), endIndex));
  return { date, title, body: [quote, source, body].filter(Boolean).join("\n\n") };
}

export function parseSpiritualPrinciple(html) {
  const table = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1];
  if (!table) throw new Error("Не найдена таблица Spiritual Principle на spadna.org");

  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => ({
    html: match[1],
    text: htmlToText(match[1])
  })).filter((row) => row.text);

  const dateRow = rows.find((row) => /<h2\b/i.test(row.html));
  const titleRow = rows.find((row) => /<h1\b/i.test(row.html)
    || /<h2\b[^>]*class=["'][^"']*\bheading1\b[^"']*["']/i.test(row.html));
  if (!dateRow || !titleRow) throw new Error("Не найдены дата или заголовок Spiritual Principle на spadna.org");

  const titleIndex = rows.indexOf(titleRow);
  const contentRows = rows.slice(titleIndex + 1);
  const separatorIndex = contentRows.findIndex((row) => /^[-—\s]+$/.test(row.text.replace(/\u00a0/g, " ")));
  if (separatorIndex < 0 || !contentRows[separatorIndex + 1]) {
    throw new Error("Не найдена заключительная ежедневная мысль на spadna.org");
  }

  const beforeThought = contentRows.slice(0, separatorIndex);
  const pageRow = beforeThought.find((row) => /^Page\s+\d+$/i.test(row.text));
  const quoteRow = beforeThought.find((row) => /^['“\"]/.test(row.text));
  const quoteIndex = quoteRow ? beforeThought.indexOf(quoteRow) : -1;
  const afterQuote = quoteIndex >= 0 ? beforeThought.slice(quoteIndex + 1) : [];
  const detectedBodyIndex = afterQuote.findIndex((row) => row.text.includes("\n\n") || row.text.length >= 300);
  const bodyIndex = detectedBodyIndex >= 0 ? detectedBodyIndex : Math.max(0, afterQuote.length - 1);
  const sourceRow = bodyIndex > 0 ? afterQuote[0] : null;
  const body = afterQuote.slice(bodyIndex).map((row) => row.text).join("\n\n").trim();
  const thought = contentRows[separatorIndex + 1].text;

  if (!quoteRow || !body || !thought) throw new Error("Структура Spiritual Principle на spadna.org неполна");

  const result = {
    date: dateRow.text,
    title: titleRow.text,
    page: pageRow?.text || "",
    quote: quoteRow.text,
    source: sourceRow?.text || "",
    body,
    thought
  };
  result.raw = [result.date, result.title, result.page, result.quote, result.source, result.body, result.thought]
    .filter(Boolean).join("\n\n");
  return result;
}

function splitDailyText(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 3) throw new Error("Не удалось разделить ежедневный текст на дату, тему и содержание");
  const [date, title, ...body] = lines;
  const content = body.filter((line) => !/^(?:Page|Страница)\s+\d+$/iu.test(line));
  return { date, title, body: content.join("\n\n"), raw: text };
}

function extractFirst(value, pattern) {
  const match = pattern.exec(value);
  return match ? htmlToText(match[1]) : "";
}

function htmlToText(value) {
  return decodeHtml(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/tr>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtml(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&#8217;/g, "’").replace(/&#8220;|&#8221;/g, '"');
}

async function sendDailyPost(env, chatId, heading, { date, title, body }) {
  const header = `<b>${escapeHtml(heading)}</b>\n\n${escapeHtml(date)}\n<u>${escapeHtml(title)}</u>`;
  const chunks = splitMessage(body, 3600);
  for (const [index, chunk] of chunks.entries()) {
    const prefix = index === 0 ? header : "Продолжение";
    await sendMessage(env, chatId, `${prefix}\n<blockquote expandable>${escapeHtml(chunk)}</blockquote>`, { parse_mode: "HTML" });
  }
}

async function sendMessage(env, chatId, text, options = {}) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...options })
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(`Telegram API: ${payload.description || response.status}`);
}

function splitMessage(text, limit) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    const boundary = Math.max(remaining.lastIndexOf("\n", limit), remaining.lastIndexOf(" ", limit));
    const index = boundary > limit / 2 ? boundary : limit;
    chunks.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
}
