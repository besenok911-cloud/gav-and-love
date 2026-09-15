CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  pet TEXT,
  service TEXT,
  breed TEXT,
  name TEXT,
  phone TEXT,
  date TEXT,
  time TEXT,
  note TEXT,
  is_request INTEGER DEFAULT 0,
  event_link TEXT,
  status TEXT DEFAULT 'new'
);
CREATE INDEX IF NOT EXISTS idx_bookings_created ON bookings (created_at DESC);
