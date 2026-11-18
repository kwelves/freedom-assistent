export async function sendMessage(env, chatId, text, options = {}) {
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, ...options })
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(`Telegram API: ${payload.description || response.status}`);
  return payload.result;
}

export function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
}
