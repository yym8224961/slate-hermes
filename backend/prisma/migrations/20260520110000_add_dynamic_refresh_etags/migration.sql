ALTER TABLE `groups`
    ADD COLUMN `structure_etag` VARCHAR(64) NOT NULL DEFAULT 'empty',
    ADD COLUMN `manifest_etag` VARCHAR(64) NOT NULL DEFAULT 'empty';

UPDATE `groups`
SET `structure_etag` = 'empty',
    `manifest_etag` = 'empty';

ALTER TABLE `groups`
    DROP COLUMN `etag`;

ALTER TABLE `contents`
    ADD COLUMN `content_etag` VARCHAR(64) NOT NULL DEFAULT 'empty',
    ADD COLUMN `audio_lease_until` DATETIME(3) NULL,
    ADD COLUMN `audio_attempts` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `dynamic_refresh_due_at` DATETIME(3) NULL,
    ADD COLUMN `dynamic_refresh_lease_until` DATETIME(3) NULL,
    ADD COLUMN `dynamic_refresh_attempts` INTEGER NOT NULL DEFAULT 0;

UPDATE `contents`
SET `dynamic_refresh_due_at` = `dynamic_next_run_at`
WHERE `kind` = 'dynamic';

UPDATE `contents`
SET `content_etag` = CONCAT('content-migration-', SUBSTRING(COALESCE(`image_etag`, 'empty'), 1, 14));

CREATE INDEX `contents_dynamic_refresh_due_at_idx`
    ON `contents`(`dynamic_refresh_due_at`);

CREATE INDEX `contents_kind_dynamic_refresh_due_at_idx`
    ON `contents`(`kind`, `dynamic_refresh_due_at`);

CREATE INDEX `contents_audio_status_audio_lease_until_idx`
    ON `contents`(`audio_status`, `audio_lease_until`);

CREATE TABLE `tts_audio_cache` (
    `id` VARCHAR(191) NOT NULL,
    `cache_key` CHAR(64) NOT NULL,
    `text` VARCHAR(512) NOT NULL,
    `voice` VARCHAR(32) NOT NULL,
    `model` VARCHAR(64) NOT NULL,
    `style` VARCHAR(128) NOT NULL DEFAULT '',
    `etag` VARCHAR(64) NOT NULL,
    `size` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `tts_audio_cache_cache_key_key`(`cache_key`),
    INDEX `tts_audio_cache_etag_idx`(`etag`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
