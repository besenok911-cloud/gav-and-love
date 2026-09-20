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
  r2_key TEXT,             -- full photo in the bucket
  size INTEGER,
  thumb_key TEXT,          -- small copy for grids and avatars
  thumb_size INTEGER,
  token TEXT,                -- 16 hex, makes /photo/<id>/<token> unguessable
  created_at TEXT,
  note TEXT,
  published INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pet_photos_pet ON pet_photos(pet_id);

-- Photos of the public site itself, replaced from the CRM «Сайт» tab (hero, team, interior, hotel).
-- The slot -> {id, token} map lives in settings.site_cms; the bytes always live in the R2 bucket
-- (there is no `data` column on purpose — a hero served from a database row is worse than refusing
-- the upload). `unref_at` is stamped when a slot stops pointing at the row; the daily cron deletes
-- rows that have been unreferenced for a week, together with their objects.
CREATE TABLE IF NOT EXISTS site_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cms_key TEXT,
  mime TEXT,
  r2_key TEXT,
  size INTEGER,
  thumb_key TEXT,
  thumb_size INTEGER,
  w INTEGER,
  h INTEGER,
  tw INTEGER,
  th INTEGER,
  token TEXT,
  created_at TEXT,
  unref_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_site_media_unref ON site_media(unref_at);
