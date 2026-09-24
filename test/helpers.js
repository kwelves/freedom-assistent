export class FakeDB {
  constructor() {
    this.subscribers = new Map();
    this.markers = new Set();
    this.usernames = new Set();
    this.dailyCache = new Map();
    this.settings = new Map();
  }

  prepare(sql) {
    const db = this;
    const normalized = sql.replace(/\s+/g, " ").trim();
    let values = [];
    return {
      bind(...bound) {
        values = bound;
        return this;
      },
      async first() {
        if (normalized.startsWith("SELECT 1 FROM sent_reminders")) {
          return db.markers.has(String(values[0])) ? { 1: 1 } : null;
        }
        if (normalized.startsWith("SELECT value FROM settings")) {
          const value = db.settings.get(String(values[0]));
          return value === undefined ? null : { value };
        }
        return null;
      },
      async all() {
        if (normalized.startsWith("SELECT content_type, source_date, payload FROM daily_cache")) {
          return {
            results: [...db.dailyCache.values()]
              .filter((row) => row.date_key === values[0])
              .map(({ content_type, source_date, payload }) => ({ content_type, source_date, payload }))
          };
        }
        if (normalized.startsWith("SELECT chat_id FROM subscribers")) {
          return { results: [...db.subscribers.values()].filter((row) => row.active === 1).map(({ chat_id }) => ({ chat_id })) };
        }
        if (normalized.startsWith("SELECT username FROM usernames")) {
          return { results: [...db.usernames].sort().map((username) => ({ username })) };
        }
        return { results: [] };
      },
      async run() {
        if (normalized.startsWith("INSERT INTO settings")) {
          db.settings.set(String(values[0]), String(values[1]));
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith("INSERT INTO daily_cache")) {
          const [content_type, date_key, source_date, payload] = values;
          db.dailyCache.set(`${content_type}:${date_key}`, {
            content_type,
            date_key,
            source_date,
            payload
          });
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith("INSERT INTO subscribers")) {
          const [chat_id, username, first_name, created_at] = values;
          const previous = db.subscribers.get(chat_id);
          db.subscribers.set(chat_id, {
            chat_id,
            username,
            first_name,
            active: 1,
            created_at: previous?.created_at || created_at
          });
          return { meta: { changes: 1 } };
        }
        if (normalized.startsWith("INSERT OR IGNORE INTO usernames")) {
          const size = db.usernames.size;
          db.usernames.add(values[0]);
          return { meta: { changes: db.usernames.size - size } };
        }
        if (normalized.startsWith("INSERT OR IGNORE INTO sent_reminders")) {
          const key = String(values[0]);
          const changes = db.markers.has(key) ? 0 : 1;
          db.markers.add(key);
          return { meta: { changes } };
        }
        if (normalized.startsWith("DELETE FROM sent_reminders")) {
          const changes = db.markers.delete(String(values[0])) ? 1 : 0;
          return { meta: { changes } };
        }
        if (normalized.startsWith("UPDATE subscribers SET active = 0")) {
          const row = db.subscribers.get(values[0]);
          if (row) row.active = 0;
          return { meta: { changes: row ? 1 : 0 } };
        }
        return { meta: { changes: 0 } };
      }
    };
  }
}

export function telegramFetch(sent, failures = new Map()) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    sent.push(body);
    const failure = failures.get(body.chat_id);
    if (failure) {
      return new Response(JSON.stringify({ ok: false, description: failure }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), {
      headers: { "content-type": "application/json" }
    });
  };
}

export const currentSpadnaFixture = `
<html><body><table align="center">
<tr><td align="left"><h2>September 08, 2026</h2></td></tr>
<tr><td align="center"><h2 class="heading1">Gratitude Transforms Us</h2></td></tr>
<tr><td align="center">Page 260<br><br></td></tr>
<tr><td align="left">"Gratitude in action is an engine for change: As we carry the message, our own lives transform."<br><br></td></tr>
<tr><td align="center">Guiding Principles, Tradition Five, Opening Reflection<br><br></td></tr>
<tr><td align="left">First main paragraph.<br><br>Second main paragraph.<br><br></td></tr>
<tr><td align="center">——— &nbsp; ——— &nbsp; ——— &nbsp; ——— &nbsp; ———<br><br></td></tr>
<tr><td align="left">I will look for opportunities to give of myself today.<br><br></td></tr>
<tr><td align="center">Copyright</td></tr>
</table></body></html>`;
