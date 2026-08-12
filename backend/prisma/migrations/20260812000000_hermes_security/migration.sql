ALTER TABLE `users`
  ADD COLUMN `is_admin` BOOLEAN NOT NULL DEFAULT false AFTER `password`;

UPDATE `users`
SET `is_admin` = true
WHERE `id` = (
  SELECT `oldest_user`.`id`
  FROM (
    SELECT `id`
    FROM `users`
    ORDER BY `created_at` ASC, `id` ASC
    LIMIT 1
  ) AS `oldest_user`
);
