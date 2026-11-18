CREATE TABLE IF NOT EXISTS daily_cache (
  content_type TEXT NOT NULL,
  date_key TEXT NOT NULL,
  source_date TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (content_type, date_key)
);
