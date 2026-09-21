#!/usr/bin/env node
/* Робить SQL, який заводить власника нового салону.
 *
 * Навіщо окремий скрипт: пароль зберігається як PBKDF2-HMAC-SHA256, 100 000 ітерацій, 256 біт,
 * сіль — 16 випадкових байтів. У чистому SQL це не порахувати, а ручки «створити власника» у
 * воркері немає навмисно — це крок розгортання, а не дія, доступна ззовні.
 *
 *   node worker/tools/owner-sql.js vlasnyk "Ганна" > owner.sql
 *   npx wrangler d1 execute <база> --remote --file owner.sql
 *
 * Пароль друкується в консоль ОДИН раз — збережіть його і віддайте власниці. Після першого входу
 * CRM попросить змінити (must_change=1).
 */
const crypto = require("crypto");

const username = (process.argv[2] || "").trim().toLowerCase();
const name = (process.argv[3] || "Власниця").trim();
if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
  console.error("Використання: node owner-sql.js <логін: a-z 0-9 _ . - > <ім'я>");
  process.exit(1);
}

// Читабельний пароль: його доведеться диктувати по телефону, тож без схожих символів.
const ABC = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const password = Array.from(crypto.randomBytes(16)).map(b => ABC[b % ABC.length]).join("");

const salt = crypto.randomBytes(16).toString("hex");
const hash = crypto.pbkdf2Sync(password, Buffer.from(salt, "hex"), 100000, 32, "sha256").toString("hex");
const q = v => "'" + String(v).replace(/'/g, "''") + "'";

process.stdout.write(
  "-- власник салону, створено " + new Date().toISOString() + "\n" +
  "INSERT INTO users (company_id,username,name,pass_hash,pass_salt,role,master_id,active,must_change,created_at)\n" +
  "VALUES (1," + q(username) + "," + q(name) + "," + q(hash) + "," + q(salt) + ",'owner',NULL,1,1," +
  q(new Date().toISOString()) + ");\n");

console.error("\n  логін:  " + username + "\n  пароль: " + password +
  "\n\n  Пароль більше ніде не зберігається. Передайте його власниці — при першому вході CRM попросить змінити.\n");
