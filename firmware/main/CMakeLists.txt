set(SOURCES
    "main.cc"

    "app/app.cc"
    "app/boot_mode.cc"
    "app/event_bus.cc"
    "app/power_state.cc"
    "app/scene_stack.cc"
    "app/sleep_manager.cc"
    "app/time_tick.cc"

    "bsp/board.cc"
    "bsp/board_power.cc"

    "drivers/button.cc"
    "drivers/charge_status.cc"
    "drivers/i2c_power_hook.cc"
    "drivers/i2c_device.cc"
    "drivers/i2c_bus_lock.cc"
    "drivers/display/epd_ssd1683.cc"
    "drivers/audio/audio_player.cc"
    "drivers/audio/volume_store.cc"

    "network/wifi.cc"
    "network/captive_portal.cc"
    "network/cred_store.cc"
    "network/sntp.cc"
    "network/dns_hijack.cc"

    "protocol/api_client.cc"
    "protocol/sync_service.cc"

    "chat/xiaozhi_audio_service.cc"
    "chat/xiaozhi_chat_service.cc"
    "chat/xiaozhi_config_client.cc"
    "chat/xiaozhi_mqtt_protocol.cc"
    "chat/xiaozhi_protocol.cc"
    "chat/xiaozhi_settings.cc"
    "chat/xiaozhi_websocket_protocol.cc"

    "scenes/boot/boot_splash_scene.cc"
    "scenes/bg_refresh/bg_refresh_scene.cc"
    "scenes/chat/chat_scene.cc"
    "scenes/frame/frame_scene.cc"
    "scenes/settings/settings_scene.cc"
    "scenes/settings/volume_page.cc"
    "scenes/settings/device_info_page.cc"
    "scenes/settings/restart_device_page.cc"
    "scenes/settings/factory_reset_page.cc"

    "ui/status_bar.cc"
    "ui/frame_view.cc"
    "ui/menu_list.cc"

    "storage/cache.cc"
    "storage/nvs_store.cc"

    "generated/fonts/source_han_sans_sc_regular_slim.c"
    "generated/fonts/fusion_pixel_12.c"
)

set(INCLUDE_DIRS
    "."
    "app"
    "bsp"
    "chat"
    "drivers"
    "drivers/audio"
    "drivers/display"
    "generated"
    "generated/fonts"
    "network"
    "protocol"
    "scenes/boot"
    "scenes/bg_refresh"
    "scenes/chat"
    "scenes/frame"
    "scenes/settings"
    "storage"
    "ui"
)

idf_component_register(
    SRCS ${SOURCES}
    INCLUDE_DIRS ${INCLUDE_DIRS}
    PRIV_REQUIRES
        xiaozhi-fonts
        78__esp-ml307
        espressif__esp_audio_codec
        espressif__esp_audio_effects
        nvs_flash
        esp_wifi
        esp_event
        esp_netif
        esp_http_server
        esp_http_client
        esp-tls
        esp_app_format
        app_update
        efuse
        mbedtls
        json
        lwip
        esp_psram
        driver
        esp_adc
        esp_lcd
        esp_timer
        esp_pm
        mqtt
        pthread
        spi_flash
)
