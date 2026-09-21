-- Прибрати демо-дані в день, коли салон починає працювати по-справжньому.
--
-- НЕОБОРОТНО. Спершу зніміть копію бази:
--   npx wrangler d1 export gavlove-crm --remote --env="" --output before-demo-clear.sql
-- і тільки потім:
--   npx wrangler d1 execute gavlove-crm --remote --env="" --file tools/demo-clear.sql
--
-- ЧОМУ САМЕ ЦЕЙ МАРКЕР. Усі демо-клієнти мають телефон з префіксом +38067111: це двадцять
-- послідовних номерів +380671110001…0020 плюс +380671111111. Перевірено на боєві — жоден
-- справжній клієнт під нього не підпадає, а справжні записи (інші префікси) лишаються цілі.
-- Якщо демо колись досіюватимуть, тримайтеся цього ж префікса, інакше цей файл перестане
-- працювати мовчки.
--
-- ЩО ЛИШАЄТЬСЯ НЕЗМІННИМ: прайс, майстри, налаштування, тексти сайту, акаунти. Прибираються
-- тільки вигадані клієнти, їхні улюбленці, фото і записи.
--
-- Порядок видалення — від дітей до батьків, інакше лишаються висячі рядки.

DELETE FROM pet_photos WHERE pet_id IN (
  SELECT id FROM pets WHERE client_id IN (SELECT id FROM clients WHERE phone LIKE '+38067111%')
);
DELETE FROM pets     WHERE client_id IN (SELECT id FROM clients WHERE phone LIKE '+38067111%');
DELETE FROM bookings WHERE phone LIKE '+38067111%';
DELETE FROM bookings WHERE client_id IN (SELECT id FROM clients WHERE phone LIKE '+38067111%');
DELETE FROM clients  WHERE phone LIKE '+38067111%';

-- Скільки лишилось справжнього — щоб одразу побачити, що видалилось не все підряд.
SELECT (SELECT COUNT(*) FROM clients)  AS clients_left,
       (SELECT COUNT(*) FROM bookings) AS bookings_left,
       (SELECT COUNT(*) FROM pets)     AS pets_left;

-- Кілька старіших демо-рядків сіялися до того, як зʼявився префікс +38067111, і мають телефони
-- з однакових цифр. Їх п'ять, по одному запису, і під шаблон вище вони не підпадають. Видаляти
-- їх автоматично небезпечно: справжній номер теоретично може так виглядати. Тому просто
-- показуємо — подивіться на імена і приберіть руками, якщо це справді демо.
SELECT id, date, name, phone, service FROM bookings
 WHERE phone LIKE '+38067222%' OR phone LIKE '+38067333%' OR phone LIKE '+38067444%'
    OR phone LIKE '+380999999%' OR phone LIKE '+38050412%'
 ORDER BY phone;
