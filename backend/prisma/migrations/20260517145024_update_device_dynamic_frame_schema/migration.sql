ALTER TABLE `devices`
    ADD COLUMN `free_heap` INTEGER NULL,
    ADD COLUMN `fw_build_ts` VARCHAR(32) NULL,
    ADD COLUMN `last_registered_at` DATETIME(3) NULL;

CREATE INDEX `devices_secret_hash_idx` ON `devices`(`secret_hash`);

ALTER TABLE `contents` CHANGE `caption` `frame_name` VARCHAR(64) NULL;

-- Dynamic content no longer owns uploaded audio; clear stale audio metadata.
UPDATE `contents`
SET `audio_etag` = NULL,
    `audio_size` = NULL
WHERE `kind` = 'dynamic';
