CREATE TABLE IF NOT EXISTS subscribers (
  chat_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
