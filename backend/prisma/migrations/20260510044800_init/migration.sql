-- CreateTable
CREATE TABLE `users` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `password` VARCHAR(255) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `devices` (
    `id` VARCHAR(191) NOT NULL,
    `mac` VARCHAR(17) NOT NULL,
    `secret_hash` CHAR(64) NOT NULL,
    `pair_code` CHAR(6) NOT NULL,
    `name` VARCHAR(64) NULL,
    `owner_user_id` VARCHAR(191) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `selected_group_id` VARCHAR(191) NULL,
    `last_seen_at` DATETIME(3) NULL,
    `battery_pct` INTEGER NULL,
    `rssi_dbm` INTEGER NULL,
    `fw_version` VARCHAR(32) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `devices_mac_key`(`mac`),
    UNIQUE INDEX `devices_pair_code_key`(`pair_code`),
    INDEX `devices_owner_user_id_sort_order_idx`(`owner_user_id`, `sort_order`),
    INDEX `devices_selected_group_id_idx`(`selected_group_id`),
    INDEX `devices_last_seen_at_idx`(`last_seen_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `groups` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `etag` VARCHAR(64) NOT NULL,
    `kind` ENUM('static', 'dynamic') NOT NULL DEFAULT 'static',
    `owner_user_id` VARCHAR(191) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `groups_owner_user_id_sort_order_idx`(`owner_user_id`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `frames` (
    `id` VARCHAR(191) NOT NULL,
    `group_id` VARCHAR(191) NOT NULL,
    `sort_order` INTEGER NOT NULL,
    `caption` VARCHAR(64) NULL,
    `image_etag` VARCHAR(64) NOT NULL,
    `audio_etag` VARCHAR(64) NULL,
    `image_size` INTEGER NOT NULL,
    `audio_size` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `frames_group_id_sort_order_key`(`group_id`, `sort_order`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `devices` ADD CONSTRAINT `devices_owner_user_id_fkey` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `devices` ADD CONSTRAINT `devices_selected_group_id_fkey` FOREIGN KEY (`selected_group_id`) REFERENCES `groups`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `groups` ADD CONSTRAINT `groups_owner_user_id_fkey` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `frames` ADD CONSTRAINT `frames_group_id_fkey` FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
