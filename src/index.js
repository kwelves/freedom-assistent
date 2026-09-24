const GREETINGS = [
  "Привет, {name}! Рады видеть тебя здесь. Ты не один — мы все здесь ради одной цели. Добро пожаловать в семью! 🤝",
  "Добро пожаловать, {name}! Здесь безопасное место, где тебя поймут и поддержат. Мы рады, что ты с нами! 💚",
  "Приветствуем тебя, {name}! Помни, что здесь тебя всегда выслушают и примут. Ты сделал важный шаг! 💪",
  "Рады, что ты нашёл дорогу к нам, {name}. Мы здесь, чтобы поддерживать друг друга на пути к свободе. Добро пожаловать! ✨",
  "{name}, привет! Ты в безопасности. Здесь нет осуждения, только поддержка и понимание. Рады твоему присутствию! 🤗",
  "Добро пожаловать в наше сообщество, {name}! Пусть этот чат станет для тебя источником сил и надежды. Мы вместе! 🙏",
  "Привет, {name}! Мы рады каждому новому участнику. Здесь ты найдёшь людей, которые понимают. Мы с тобой! 🫂",
  "{name}, добро пожаловать! Каждый из нас когда-то сделал первый шаг — и ты его уже сделал. Мы рядом! 🌱",
  "Привет, {name}! Здесь не нужно притворяться кем-то другим. Ты среди своих. Рады тебе! 🕊",
  "Рады тебе, {name}! Этот чат — место, где можно быть собой. Мы все идём одним путём. Добро пожаловать! 🛤"
];

const REMINDERS = [
  "🕊 Друзья, собрание через 2 часа — в {time}. Ждём каждого из вас!",
  "💚 Напоминание: через 2 часа наше собрание ({time}). Приходите, мы вместе!",
  "🙏 До собрания осталось 2 часа (начало в {time}). Будем рады видеть всех!",
  "✨ Сегодня собрание в {time} — через 2 часа. Приходите, каждый голос важен!",
  "🕊 Не забудьте — собрание в {time}! Через 2 часа встречаемся. Ждём вас!",
  "💪 Собрание сегодня в {time} (через 2 часа). Вместе мы сильнее — приходите!",
  "🤝 Напоминаем: через 2 часа собрание ({time}). Ваше присутствие важно для всех нас!"
];

const FORMAT4_TEXTS = [
  "📖 Сегодня формат нашего собрания — чтение анонимной литературы. Ждём каждого!",
  "📖 Формат сегодняшнего собрания — чтение литературы АН. Приходите, будем читать вместе!",
  "📖 Сегодня читаем анонимную литературу. Присоединяйтесь!",
  "📖 Формат на сегодня — чтение литературы. Каждый голос важен!",
  "📖 Друзья, сегодня мы читаем литературу АН. Будем рады видеть вас!",
  "📖 Сегодняшний формат — чтение анонимной литературы. Приходите, делимся опытом!"
];

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("Freedom Helper Bot is running.");
    if (!await hasValidWebhookSecret(request, env.TELEGRAM_WEBHOOK_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      await handleUpdate(await request.json(), env);
      return new Response("OK");
    } catch (error) {
      console.error(JSON.stringify({ event: "telegram_update_failed", error: String(error) }));
      return new Response("Internal Server Error", { status: 500 });
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(sendScheduledReminder(env, "19:00", controller.scheduledTime));
  }
};

export async function handleUpdate(update, env) {
  const message = update.message;
  if (!message) return;
  if (message.new_chat_members) return welcomeNewMembers(message, env);
  if (!message.text) return;
  if (message.chat.type === "private" && message.text.trim().toLowerCase().split(/\s+/)[0]?.split("@")[0] === "/start") {
    return handleCommand(message, env);
  }
  await rememberUsername(message.from?.username, env);
  if (message.text.startsWith("/")) return handleCommand(message, env);
  if (isAuthorized(message.from?.id, env) && isAssistantMentioned(message.text, env.BOT_USERNAME)) {
    await sendReply(env, message, "Я здесь, чем помочь? 🤝");
  }
}

async function welcomeNewMembers(message, env) {
  for (const member of message.new_chat_members) {
    if (member.is_bot) continue;
    await rememberUsername(member.username, env);
    await sendReply(env, message, choose(GREETINGS).replace("{name}", escapeHtml(member.first_name || "друг")));
  }
}

async function handleCommand(message, env) {
  const [commandToken, ...args] = message.text.trim().split(/\s+/);
  const command = commandToken.toLowerCase().split("@")[0];

  if (command === "/start" && message.chat.type === "private") {
    await subscribePrivateChat(message, env);
    return sendReply(env, message, "✅ Вы подписаны на ежедневные материалы.");
  }

  if (!isAuthorized(message.from?.id, env)) return;
  if (command === "/start" || command === "/help") return sendReply(env, message, helpText());
  if (command === "/add" || command === "/remove") {
    if (!args.length) return sendReply(env, message, `Использование: ${command} @username`);
    const resultLines = [];
    for (const argument of args) {
      const username = normalizeUsername(argument);
      if (!username) {
        resultLines.push(`⚠️ ${escapeHtml(argument)} — некорректный username.`);
        continue;
      }
      const result = command === "/add"
        ? await env.DB.prepare("INSERT OR IGNORE INTO usernames (username) VALUES (?)").bind(username).run()
        : await env.DB.prepare("DELETE FROM usernames WHERE username = ?").bind(username).run();
      resultLines.push(command === "/add"
        ? result.meta.changes ? `✅ ${username} добавлен.` : `ℹ️ ${username} уже в списке.`
        : result.meta.changes ? `✅ ${username} удалён.` : `ℹ️ ${username} не найден.`);
    }
    return sendReply(env, message, resultLines.join("\n"));
  }
  if (command === "/list") {
    const usernames = await getUsernames(env);
    return sendReply(env, message, usernames.length
      ? `📋 Список участников (${usernames.length}):\n\n${usernames.join("\n")}`
      : "Список пуст.");
  }
  if (command === "/test") {
    await sendReminder(env, "21:00", true);
    return sendReply(env, message, "✅ Тестовое напоминание отправлено в группу.");
  }
  if (command === "/format4") {
    const state = await env.DB.prepare("SELECT value FROM settings WHERE key = 'last_reminder_message_id'").first();
    await sendMessage(env, env.CHAT_ID, choose(FORMAT4_TEXTS), state ? { reply_parameters: { message_id: Number(state.value) } } : {});
    return sendReply(env, message, "✅ Формат собрания отправлен в группу.");
  }
}

async function subscribePrivateChat(message, env) {
  await env.DB.prepare(`
    INSERT INTO subscribers (chat_id, username, first_name, active, created_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      active = 1
  `).bind(
    message.chat.id,
    message.from?.username || null,
    message.from?.first_name || null,
    new Date().toISOString()
  ).run();
}

async function sendScheduledReminder(env, meetingTime, scheduledTime) {
  const reminderKey = `${meetingTime}:${new Date(scheduledTime).toISOString().slice(0, 10)}`;
  const result = await env.DB.prepare("INSERT OR IGNORE INTO sent_reminders (reminder_key) VALUES (?)").bind(reminderKey).run();
  if (result.meta.changes) await sendReminder(env, meetingTime, false);
}

async function sendReminder(env, meetingTime, isTest) {
  const usernames = await getUsernames(env);
  const reminder = choose(REMINDERS).replace("{time}", meetingTime);
  const tags = usernames.join(" ").slice(0, 3500);
  const sent = await sendMessage(env, env.CHAT_ID, `${isTest ? "[ТЕСТ] " : ""}${reminder}\n\n<blockquote expandable>📢 ${tags}</blockquote>`, { parse_mode: "HTML" });
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('last_reminder_message_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(sent.message_id)).run();
}

async function getUsernames(env) {
  const result = await env.DB.prepare("SELECT username FROM usernames ORDER BY username COLLATE NOCASE").all();
  return result.results.map((row) => row.username);
}

async function rememberUsername(username, env) {
  const normalized = normalizeUsername(username);
  if (normalized) await env.DB.prepare("INSERT OR IGNORE INTO usernames (username) VALUES (?)").bind(normalized).run();
}

function sendReply(env, message, text) {
  return sendMessage(env, message.chat.id, text, { reply_parameters: { message_id: message.message_id } });
}

async function sendMessage(env, chatId, text, options = {}) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...options })
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(`Telegram API error: ${payload.description || response.status}`);
  return payload.result;
}

function isAuthorized(userId, env) {
  const userIds = [env.OWNER_ID, ...(env.ALLOWED_USERS || "").split(",")]
    .map((value) => String(value).trim()).filter(Boolean);
  return Boolean(userId) && userIds.includes(String(userId));
}

function isAssistantMentioned(text, botUsername) {
  const normalized = text.toLowerCase();
  return normalized.includes("хелпер") || Boolean(botUsername && normalized.includes(`@${botUsername.toLowerCase()}`));
}

function normalizeUsername(value) {
  if (!value) return null;
  const username = value.startsWith("@") ? value : `@${value}`;
  return /^@[A-Za-z0-9_]{1,32}$/.test(username) ? username : null;
}

function choose(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
}

async function hasValidWebhookSecret(request, expectedSecret) {
  if (!expectedSecret) return false;
  const encoder = new TextEncoder();
  const [receivedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "")),
    crypto.subtle.digest("SHA-256", encoder.encode(expectedSecret))
  ]);
  return crypto.subtle.timingSafeEqual(receivedHash, expectedHash);
}

function helpText() {
  return [
    "🤖 Команды бота:",
    "/add @username — добавить в список тегов",
    "/remove @username — удалить из списка тегов",
    "/list — показать список участников",
    "/test — отправить тестовое напоминание",
    "/format4 — отправить формат собрания",
    "/help — показать эту справку"
  ].join("\n");
}
