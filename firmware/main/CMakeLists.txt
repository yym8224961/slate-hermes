set(SOURCES
    "main.cc"

    "app/app.cc"
    "app/boot_mode.cc"
    "app/combo_key.cc"
    "app/event_bus.cc"
    "app/power_state.cc"
    "app/scene.cc"
    "app/scene_stack.cc"
    "app/shutdown_subsystems.cc"
    "app/setup_flow.cc"
    "app/sleep_manager.cc"
    "app/system_restart.cc"
    "app/time_tick.cc"

    "bsp/board.cc"
    "bsp/board_power.cc"

    "drivers/input/button.cc"
    "drivers/power/charge_status.cc"
    "drivers/bus/i2c_device.cc"
    "drivers/bus/i2c_bus_lock.cc"
    "drivers/display/epd_ssd1683.cc"
    "drivers/display/epd_ssd1683_commands.cc"
    "drivers/display/epd_ssd1683_spi.cc"
    "drivers/display/epd_utils.cc"
    "drivers/audio/audio_player.cc"
    "drivers/audio/volume_store.cc"

    "network/wifi.cc"
    "network/captive_portal.cc"
    "network/cred_store.cc"
    "network/sntp.cc"
    "network/dns_hijack.cc"

    "sync/api_client.cc"
    "sync/sync_service.cc"

    "chat/config/xiaozhi_config_client.cc"
    "chat/config/xiaozhi_settings.cc"
    "chat/mcp/mcp_dispatcher.cc"
    "chat/mcp/mcp_tools.cc"
    "chat/protocol/audio_stream_packet.cc"
    "chat/protocol/xiaozhi_mqtt_protocol.cc"
    "chat/protocol/xiaozhi_protocol.cc"
    "chat/protocol/xiaozhi_websocket_protocol.cc"
    "chat/service/xiaozhi_audio_service.cc"
    "chat/service/xiaozhi_chat_service.cc"
    "chat/service/xiaozhi_message_handler.cc"

    "scenes/boot/boot_splash_scene.cc"
    "scenes/bg_refresh/bg_refresh_scene.cc"
    "scenes/chat/chat_scene.cc"
    "scenes/frame/frame_scene.cc"
    "scenes/settings/settings_scene.cc"
    "scenes/settings/settings_page_base.cc"
    "scenes/settings/confirm_action_page.cc"
    "scenes/settings/volume_page.cc"
    "scenes/settings/device_info_page.cc"
    "scenes/settings/restart_device_page.cc"
    "scenes/settings/factory_reset_page.cc"

    "ui/status_bar.cc"
    "ui/frame_view.cc"
    "ui/menu_list.cc"

    "storage/cache.cc"
    "storage/cache_staging.cc"
    "storage/nvs_store.cc"

    "generated/fonts/zfull_16.c"
    "generated/fonts/zfull_12.c"
    "generated/fonts/font_awesome_14_1.c"
    "generated/fonts/font_awesome_30_1.c"
)

set(INCLUDE_DIRS
    "."
)

set(PRIVATE_INCLUDE_DIRS
    "app"
    "bsp"
    "chat/config"
    "chat/mcp"
    "chat/protocol"
    "chat/service"
    "drivers"
    "drivers/audio"
    "drivers/bus"
    "drivers/display"
    "drivers/input"
    "drivers/power"
    "generated"
    "generated/fonts"
    "network"
    "sync"
    "scenes/boot"
    "scenes/bg_refresh"
    "scenes/chat"
    "scenes/frame"
    "scenes/settings"
    "storage"
    "ui"
    "utils"
)

idf_component_register(
    SRCS ${SOURCES}
    INCLUDE_DIRS ${INCLUDE_DIRS}
    PRIV_INCLUDE_DIRS ${PRIVATE_INCLUDE_DIRS}
    PRIV_REQUIRES
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
