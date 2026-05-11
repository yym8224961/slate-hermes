-- Migration: add username to users, remove kind from groups
-- Step 1: add username column (nullable, unique) to users
ALTER TABLE `users` ADD COLUMN `username` VARCHAR(32) NULL;
ALTER TABLE `users` ADD UNIQUE INDEX `users_username_key`(`username`);

-- Step 2: drop kind column from groups
ALTER TABLE `groups` DROP COLUMN `kind`;
