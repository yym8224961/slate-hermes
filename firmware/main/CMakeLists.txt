set(SOURCES
    "main.cc"

    "app/app.cc"
    "app/board.cc"
    "app/event_bus.cc"
    "app/scene_stack.cc"
    "app/sleep_manager.cc"
    "app/time_tick.cc"

    "scenes/boot_splash_scene.cc"
    "scenes/frame_scene.cc"
    "scenes/settings_scene.cc"
    "scenes/volume_page.cc"
    "scenes/poll_interval_page.cc"
    "scenes/device_info_page.cc"
    "scenes/data_sync_page.cc"
    "scenes/font_demo_page.cc"
    "scenes/restart_device_page.cc"
    "scenes/factory_reset_page.cc"

    "ui/status_bar.cc"
    "ui/frame_view.cc"
    "ui/menu_list.cc"

    "display/epd_ssd1683.cc"

    "hal/board_power.cc"
    "hal/charge_status.cc"
    "hal/i2c_power_hook.cc"
    "hal/i2c_device.cc"
    "hal/i2c_bus_lock.cc"
    "hal/button.cc"

    "net/wifi.cc"
    "net/captive_portal.cc"
    "net/cred_store.cc"
    "net/api_client.cc"
    "net/sntp.cc"
    "net/sync_service.cc"
    "net/dns_hijack.cc"

    "storage/cache.cc"

    "audio/audio_player.cc"
    "audio/volume_store.cc"

    "net/poll_interval_store.cc"

    "fonts/SourceHanSansSC_Regular_slim.c"
    "fonts/FusionPixel_12.c"
)

set(INCLUDE_DIRS
    "."
    "app"
    "audio"
    "display"
    "hal"
    "fonts"
    "net"
    "scenes"
    "storage"
    "ui"
)

idf_component_register(
    SRCS ${SOURCES}
    INCLUDE_DIRS ${INCLUDE_DIRS}
    PRIV_REQUIRES
        xiaozhi-fonts
        nvs_flash
        esp_wifi
        esp_event
        esp_netif
        esp_http_server
        esp_http_client
        esp-tls
        mbedtls
        json
        lwip
        esp_psram
        driver
        esp_adc
        esp_lcd
        esp_timer
        esp_pm
        spi_flash
)
