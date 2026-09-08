import worker from "./schedule-fix.js";

export const HOURLY_CRON = "0 * * * *";
const BISHKEK_TIME_ZONE = "Asia/Bishkek";
const DAILY_START_HOUR = 9;
const GEMINI_MODEL = "gemini-3.6-flash";
const RUSSIAN_SOURCE_URL = "https://na-russia.org/";
export const SPIRITUAL_SOURCE_URL = "https://www.spadna.org/";

export default {
  async fetch(request, env, ctx) {
    const workerResponse = await worker.fetch(request.clone(), env, ctx);
    if (!workerResponse.ok) return workerResponse;

    const update = await request.json().catch(() => null);
    const message = update?.message;
    const command = message?.text?.trim().toLowerCase().split(/\s+/)[0]?.split("@")[0];
    if (command !== "/daily" || String(message?.from?.id) !== String(env.OWNER_ID)) return workerResponse;

    await sendMessage(env, message.chat.id, "⏳ Получил команду. Готовлю ежедневные тексты и перевод.");
    ctx.waitUntil(sendDailyPreview(env, message.chat.id));
    return new Response("OK");
  },

  scheduled(controller, env, ctx) {
    if (controller.cron === HOURLY_CRON) {
      ctx.waitUntil(checkScheduledDaily(env));
      return;
    }
    return worker.scheduled(controller, env, ctx);
  }
};

export async function checkScheduledDaily(env) {
  const today = getBishkekDate();
  if (today.hour < DAILY_START_HOUR) return;

  const subscribers = await getActiveSubscribers(env);
  if (!subscribers.length) return;

  try {
    const [russianHtml, spiritualHtml] = await Promise.all([
      fetchPage(RUSSIAN_SOURCE_URL),
      fetchPage(SPIRITUAL_SOURCE_URL)
    ]);

    const russianMeditation = parseRussianMeditation(russianHtml);
    if (isCurrentRussianDate(russianMeditation.date, today)) {
      const pendingSubscribers = await getPendingSubscribers(env, "russian", today.key, subscribers);
      if (pendingSubscribers.length) {
        await sendDailyToSubscribers(env, "russian", today.key, "ЕЖЕДНЕВНИК", russianMeditation, pendingSubscribers);
      }
    } else {
      await sendMessage(env, env.OWNER_ID, "⌛ Дата Ежедневника ещё не изменилась. Проверю снова через час.");
    }

    await processSpiritualDaily(env, spiritualHtml, today, subscribers);
  } catch (error) {
    console.error(JSON.stringify({ event: "scheduled_daily_check_failed", error: String(error) }));
  }
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
    hourCycle: "h23"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));

  return {
    key: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour)
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

async function getPendingSubscribers(env, contentType, dateKey, subscribers) {
  const pending = [];
  for (const chatId of subscribers) {
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

export async function sendDailyToSubscribers(env, contentType, dateKey, heading, content, subscribers) {
  for (const chatId of subscribers) {
    const marker = `daily:${contentType}:${dateKey}:${chatId}`;
    if (await wasSent(env, marker)) continue;

    try {
      await sendDailyOnce(env, marker, () => sendDailyPost(env, chatId, heading, content));
    } catch (error) {
      console.error(JSON.stringify({ event: "daily_recipient_failed", chat_id: chatId, error: String(error) }));
      if (isInactiveRecipientError(error)) {
        try {
          await env.DB.prepare("UPDATE subscribers SET active = 0 WHERE chat_id = ?").bind(chatId).run();
        } catch (deactivationError) {
          console.error(JSON.stringify({ event: "subscriber_deactivation_failed", chat_id: chatId, error: String(deactivationError) }));
        }
      }
    }
  }
}

function isInactiveRecipientError(error) {
  return /bot was blocked|chat not found|user is deactivated|bot was kicked/i.test(String(error));
}

async function sendDailyPreview(env, chatId) {
  try {
    const [russianHtml, spiritualHtml] = await Promise.all([
      fetchPage(RUSSIAN_SOURCE_URL),
      fetchPage(SPIRITUAL_SOURCE_URL)
    ]);
    const russianMeditation = parseRussianMeditation(russianHtml);
    const spiritualPrinciple = parseSpiritualPrinciple(spiritualHtml);
    await sendDailyPost(env, chatId, "ЕЖЕДНЕВНИК", russianMeditation);
    const translation = await translateToRussian(env, spiritualPrinciple.raw);
    await sendDailyPost(env, chatId, "ДУХОВНЫЕ ПРИНЦИПЫ", splitDailyText(translation));
  } catch (error) {
    console.error(JSON.stringify({ event: "daily_preview_failed", error: String(error) }));
    await sendMessage(env, chatId, `⚠️ Ежедневные тексты не подготовлены: ${String(error).slice(0, 1000)}`);
  }
}

async function fetchPage(url) {
  const response = await fetch(url, { headers: { "user-agent": "FreedomHelperBot/1.0" } });
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
  const titleRow = rows.find((row) => /<h1\b/i.test(row.html));
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

async function translateToRussian(env, text) {
  if (!env.GEMINI_API_KEY) throw new Error("В Cloudflare не найден секрет GEMINI_API_KEY");
  const input = [
    "Переведи приведённый ниже текст с английского на русский.",
    "Переведи весь текст без сокращений, пересказа, комментариев и добавлений.",
    "Сохраняй абзацы, даты, цитаты, названия литературы и терминологию Анонимных Наркоманов.",
    "Верни только готовый русский перевод.",
    "",
    text
  ].join("\n");
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ model: GEMINI_MODEL, input })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Gemini API: ${payload.error?.message || response.status}`);
  const translation = payload.steps?.filter((step) => step.type === "model_output")
    .flatMap((step) => step.content || []).filter((item) => item.type === "text")
    .map((item) => item.text).join("").trim();
  if (!translation) throw new Error("Gemini не вернул текст перевода");
  return translation;
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
