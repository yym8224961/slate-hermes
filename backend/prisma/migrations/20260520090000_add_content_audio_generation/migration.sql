ALTER TABLE `contents`
    ADD COLUMN `audio_status` ENUM('none', 'pending', 'generating', 'ready', 'failed') NOT NULL DEFAULT 'none',
    ADD COLUMN `audio_source` ENUM('upload', 'tts') NULL,
    ADD COLUMN `audio_voice` VARCHAR(32) NULL,
    ADD COLUMN `audio_text` VARCHAR(512) NULL,
    ADD COLUMN `audio_last_error` VARCHAR(512) NULL,
    ADD COLUMN `audio_updated_at` DATETIME(3) NULL;

UPDATE `contents`
SET `audio_status` = 'ready',
    `audio_source` = 'upload',
    `audio_updated_at` = CURRENT_TIMESTAMP(3)
WHERE `audio_etag` IS NOT NULL;

UPDATE `contents`
SET `audio_status` = 'none',
    `audio_source` = NULL
WHERE `audio_etag` IS NULL;
