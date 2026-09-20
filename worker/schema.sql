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
  status TEXT DEFAULT 'new',
  source TEXT DEFAULT 'site'
);
CREATE INDEX IF NOT EXISTS idx_bookings_created ON bookings (created_at DESC);

-- Photos from the pet card. The bytes live in the R2 bucket (binding PHOTOS) under r2_key;
-- `data` is the legacy column for installations without R2 and stays NULL once migrated.
CREATE TABLE IF NOT EXISTS pet_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pet_id INTEGER,
  client_id INTEGER,
  booking_id INTEGER,
  kind TEXT,                 -- before | after
  mime TEXT,
  data BLOB,
  r2_key TEXT,
  size INTEGER,
  token TEXT,                -- 16 hex, makes /photo/<id>/<token> unguessable
  created_at TEXT,
  note TEXT,
  published INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pet_photos_pet ON pet_photos(pet_id);
