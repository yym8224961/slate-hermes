#include "app.h"

#include <esp_log.h>
#include <esp_mac.h>
#include <esp_pm.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <nvs_flash.h>
#include <sdkconfig.h>

#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <utility>

#include "board.h"
#include "bg_refresh_scene.h"
#include "boot_mode.h"
#include "button.h"
#include "config.h"
#include "epd_ssd1683.h"

#include "api_client.h"
#include "audio_player.h"
#include "boot_splash_scene.h"
#include "cache.h"
#include "captive_portal.h"
#include "chat_scene.h"
#include "cred_store.h"
#include "event_bus.h"
#include "frame_scene.h"
#include "power_state.h"
#include "sntp.h"
#include "sync_service.h"
#include "wifi.h"
#include "xiaozhi_chat_service.h"

namespace {
constexpr char kTag[]                  = "App";
constexpr int  kSaveSecretRetryCount   = 3;
constexpr int  kSaveSecretRetryDelayMs = 200;

// 组合键 UP+DOWN 同时按下 = 全屏刷新（清残影）。仅依赖按下/释放瞬间事件维护
// 「当前按住中」标志：两个键都处于按住中时立即触发 + 标记 consumed，本次按键
// 周期内的 OnClick / OnLongPress 一律 skip,避免组合键又触发单按动作。
// 下一次 OnPressDown 来时清 consumed,开新会话。
struct ComboState {
    bool up_held       = false;
    bool down_held     = false;
    bool up_consumed   = false;
    bool down_consumed = false;
};
ComboState g_combo;

bool IsSettingsSceneName(const char* name) {
    return name && (std::strcmp(name, "Settings") == 0 || std::strcmp(name, "Volume") == 0 ||
                    std::strcmp(name, "DeviceInfo") == 0 || std::strcmp(name, "RestartDevice") == 0 ||
                    std::strcmp(name, "FactoryReset") == 0);
}

void TryFireCombo() {
    if (!g_combo.up_held || !g_combo.down_held)
        return;
    if (g_combo.up_consumed && g_combo.down_consumed)
        return;  // 已触发过
    g_combo.up_consumed   = true;
    g_combo.down_consumed = true;
    ESP_LOGI(kTag, "Combo UP+DOWN -> urgent full refresh");
    if (auto* epd = Board::Get().epd())
        epd->RequestUrgentFullRefresh();
}

std::string MacString() {
    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    char buf[18];
    std::snprintf(buf, sizeof(buf), "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return buf;
}

// 各 boot 阶段 emit 给 splash 用,空 ssid/pair_code 传 nullptr。
void EmitBootStage(BootStage stage, const char* ssid, const char* pair_code) {
    UiEvent e{};
    e.kind               = UiEventKind::kBootStage;
    e.u.boot_stage.stage = stage;
    if (ssid)
        std::snprintf(e.u.boot_stage.ssid, sizeof(e.u.boot_stage.ssid), "%s", ssid);
    else
        e.u.boot_stage.ssid[0] = 0;
    if (pair_code)
        std::snprintf(e.u.boot_stage.pair_code, sizeof(e.u.boot_stage.pair_code), "%s", pair_code);
    else
        e.u.boot_stage.pair_code[0] = 0;
    evt::Post(e);
}

// 联网 + 注册流程。c 是 in/out:首次 register 成功后会回填 device_id/device_secret,
// 调用方据此判断是不是首次启动 (是 → 跳过 PostCachedGroupReadyIfAny,让 splash 显示
// 「配对码」或「等待相册」,而不是先闪一下旧 cache 的 FrameScene)。
bool TryConnectAndSetup(cred::Credentials& c) {
    EmitBootStage(BootStage::kWifiConnecting, c.wifi_ssid.c_str(), nullptr);
    if (!Wifi::Get().Connect(c.wifi_ssid, c.wifi_pwd, 20000)) {
        ESP_LOGW(kTag, "WiFi STA connect failed");
        EmitBootStage(BootStage::kWifiFailed, nullptr, nullptr);
        return false;
    }

    EmitBootStage(BootStage::kSntp, nullptr, nullptr);
    sntp::Init();
    api::Init(c.server_url, MacString(), c.device_secret);

    // HTTPS 必须等系统时间对上才能校验证书。HTTP 这步没意义但也不亏。
    // 上限 10s:超时则继续,Register 失败由 SyncService 后续 poll 接管重试。
    constexpr int kSntpWaitMs = 10000;
    int           waited      = 0;
    while (!sntp::TimeSynced() && waited < kSntpWaitMs) {
        vTaskDelay(pdMS_TO_TICKS(200));
        waited += 200;
    }
    if (!sntp::TimeSynced()) {
        ESP_LOGW(kTag, "SNTP not synced after %dms; HTTPS register may fail", kSntpWaitMs);
    } else {
        ESP_LOGI(kTag, "SNTP synced in %dms", waited);
    }

    if (c.device_secret.empty()) {
        // 首次启动 / 工厂重置后:NVS 没 secret,调 register 拿。
        // 后端只允许新设备或无主设备注册；已绑定设备必须先在 Web 端解绑。
        EmitBootStage(BootStage::kRegistering, nullptr, nullptr);
        api::RegisterResult rr;
        if (!api::Register(rr)) {
            ESP_LOGW(kTag, "Register failed (server unreachable?)");
            EmitBootStage(BootStage::kServerUnreachable, nullptr, nullptr);
            return false;
        }
        // SaveSecret 是 NVS 单独 commit;短暂失败先重试,避免一次写盘抖动放大成重注册。
        bool saved = false;
        for (int attempt = 1; attempt <= kSaveSecretRetryCount; ++attempt) {
            if (cred::SaveSecret(rr.id, rr.device_secret)) {
                saved = true;
                break;
            }
            ESP_LOGW(kTag, "SaveSecret failed attempt %d/%d", attempt, kSaveSecretRetryCount);
            vTaskDelay(pdMS_TO_TICKS(kSaveSecretRetryDelayMs));
        }
        if (!saved) {
            ESP_LOGE(kTag, "Fatal: SaveSecret failed, restarting");
            esp_restart();
        }
        c.device_id     = rr.id;
        c.device_secret = rr.device_secret;
        api::SetSecret(rr.device_secret);
        ESP_LOGI(kTag, "Registered: id=%s pair=%s", rr.id.c_str(), rr.pair_code.c_str());
        // splash 立即显示配对码 —— 用户看屏抄码是关键体验。bound 状态由后续 poll 决定。
        EmitBootStage(BootStage::kAwaitingPair, nullptr, rr.pair_code.c_str());
    } else {
        ESP_LOGI(kTag, "Have device_secret, skip register (id=%s)", c.device_id.c_str());
        // 不 emit kRegistering / kAwaitingPair,让 sync_service 第一轮 poll 拿到真实
        // bound/group 状态后再决定 splash 显示什么(已绑且有相册 → kSyncedGroupReady 切 FrameScene;
        // 已绑无相册 → kBound 切「等待相册」;远程被踢 → kUnbound 切「配对码」)。
    }
    return true;
}

void PostWifiState(bool connected, int rssi) {
    UiEvent e{};
    e.kind             = UiEventKind::kWifiStateChanged;
    e.u.wifi.connected = connected;
    e.u.wifi.rssi      = rssi;
    evt::Post(e);
}

bool PostCachedGroupReadyIfAny() {
    std::string gid, etag;
    if (!cache::ReadStateMeta(gid, etag) || gid.empty())
        return false;
    int content_count = 0;
    if (!cache::ReadManifestContentCount(gid, content_count) || content_count <= 0)
        return false;

    UiEvent e{};
    e.kind = UiEventKind::kCachedGroupReady;
    std::strncpy(e.u.group.gid, gid.c_str(), sizeof(e.u.group.gid) - 1);
    e.u.group.gid[sizeof(e.u.group.gid) - 1] = '\0';
    // cache 不存 group name；SyncService 下一轮拉到 manifest 后会 Post 带 name 的事件。
    e.u.group.name[0]         = '\0';
    e.u.group.content_count   = content_count;
    e.u.group.content_changed = false;
    evt::Post(e);
    ESP_LOGI(kTag, "Cached group ready gid=%s count=%d", gid.c_str(), content_count);
    return true;
}

}  // namespace

App::App()  = default;
App::~App() = default;

// ── 子系统初始化 ─────────────────────────────────────────────────────

void App::InitStorage() {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }
    cache::Init();
}

void App::InitDevices() {
    Board::Get().Init();
    AudioPlayer::Get().Init(Board::Get().i2c_bus());
}

void App::InitEventBus() {
    evt::Init();
}

void App::InitSceneStack() {
    SceneContext ctx;
    ctx.epd   = Board::Get().epd();
    ctx.audio = &AudioPlayer::Get();
    ctx.stack = &scene_stack_;

    ctx.read_battery = [](int* mv, int* pct) -> bool {
        uint16_t   mv16 = 0;
        uint8_t    p8   = 0;
        const bool ok   = Board::Get().ReadBattery(&mv16, &p8);
        if (mv)
            *mv = mv16;
        if (pct)
            *pct = p8;
        return ok;
    };
    ctx.read_charge    = []() { return Board::Get().charge()->Get(); };
    ctx.wifi_connected = []() { return Wifi::Get().IsConnected(); };
    ctx.wifi_rssi      = []() -> int { return Wifi::Get().GetRssi(); };

    scene_stack_.SetContext(ctx);
}

void App::StartUiLoop() {
    ui_loop_running_ = true;
    // ui_loop 8 KB：与 home_worker 一致；LVGL render+flush_cb 调用栈装得下，
    // esp_timer task / button cb task 装不下（栈 3584 B）。
    BaseType_t ok = xTaskCreatePinnedToCore(&App::UiLoopEntry, "ui_loop", 8 * 1024, this, 5, nullptr, 0);
    configASSERT(ok == pdPASS);
}

void App::UiLoopEntry(void* arg) {
    static_cast<App*>(arg)->UiLoopTask();
}

void App::PostWakeupKeyEvent(uint64_t ext1_mask) {
    if (ext1_mask == 0)
        return;
    ButtonId btn;
    if (ext1_mask & (1ULL << DOWN_BUTTON_GPIO))
        btn = ButtonId::kDown;
    else if (ext1_mask & (1ULL << BOOT_BUTTON_GPIO))
        btn = ButtonId::kEnter;
    else
        return;
    UiEvent e{};
    e.kind         = UiEventKind::kButtonShort;
    e.u.button.btn = btn;
    evt::Post(e);
    ESP_LOGI(kTag, "Wakeup by btn=%d -> posted ButtonShort", static_cast<int>(btn));
}

void App::PromoteToFrameSceneFromCache() {
    if (!PostCachedGroupReadyIfAny()) {
        scene_stack_.Push(std::make_unique<BootSplashScene>());
    }
}

void App::UiLoopTask() {
    switch (decision_.mode) {
        case boot_mode::Mode::kPortal:
        case boot_mode::Mode::kFullActive:
            scene_stack_.Push(std::make_unique<BootSplashScene>());
            break;
        case boot_mode::Mode::kBackgroundRefresh:
            scene_stack_.Push(std::make_unique<BgRefreshScene>());
            break;
    }

    while (ui_loop_running_) {
        UiEvent e;
        if (!evt::Wait(&e, pdMS_TO_TICKS(1000))) {
            // 1s 超时只是为了让 SleepManager 有机会做 Tick；不强制每秒做事。
            sleep_mgr_.Tick(esp_timer_get_time() / 1000);
            continue;
        }
        // 401 self-reset:把擦 NVS + 重启放到 ui_loop 主线程做,避免在 HTTP 回调
        // 里直接 esp_restart 撕坏 socket 导致 mbedtls 内部 panic。
        if (e.kind == UiEventKind::kSecretInvalid) {
            ESP_LOGI(kTag, "Secret invalid -> clear + restart");
            cred::ClearSecret();
            vTaskDelay(pdMS_TO_TICKS(200));
            esp_restart();
        }
        if (e.kind == UiEventKind::kBgRefreshDone) {
            auto d = sleep_mgr_.TryEnterDeepSleep();
            switch (d.outcome) {
                case SleepManager::SleepOutcome::kSlept:
                    break;
                case SleepManager::SleepOutcome::kPausedByCharge:
                    scene_stack_.Pop();
                    PromoteToFrameSceneFromCache();
                    SyncService::Get().TriggerNow();
                    break;
                case SleepManager::SleepOutcome::kUnboundGrace:
                    scene_stack_.Pop();
                    scene_stack_.Push(std::make_unique<BootSplashScene>());
                    SyncService::Get().TriggerNow();
                    break;
                case SleepManager::SleepOutcome::kDisabled:
                    ESP_LOGW(kTag, "Sleep disabled after background refresh; promote active");
                    scene_stack_.Pop();
                    PromoteToFrameSceneFromCache();
                    break;
            }
            continue;
        }
        if (e.kind == UiEventKind::kXiaozhiChannelClosed) {
            xiaozhi::ChatService::Get().NotifyNetworkClosed(e.u.xiaozhi_channel.token);
            continue;
        }
        if ((e.kind == UiEventKind::kCachedGroupReady || e.kind == UiEventKind::kSyncedGroupReady) &&
            scene_stack_.Empty()) {
            scene_stack_.Push(std::make_unique<FrameScene>(e.u.group.gid, e.u.group.content_count));
            scene_stack_.ApplyPending();
            continue;
        }
        if (e.kind == UiEventKind::kButtonDouble && e.u.button.btn == ButtonId::kEnter) {
            Scene* top = scene_stack_.Top();
            if (top && IsSettingsSceneName(top->Name())) {
                sleep_mgr_.OnEvent(e);
                continue;
            }
            if (!top || std::strcmp(top->Name(), "Xiaozhi") != 0) {
                scene_stack_.Push(std::make_unique<ChatScene>());
                scene_stack_.ApplyPending();
                sleep_mgr_.OnEvent(e);
                continue;
            }
        }
        scene_stack_.Dispatch(e);
        sleep_mgr_.OnEvent(e);
        scene_stack_.ApplyPending();
    }
    vTaskDelete(nullptr);
}

void App::AttachInputs() {
    auto post_short = [](ButtonId b) {
        return [b]() {
            UiEvent e{};
            e.kind         = UiEventKind::kButtonShort;
            e.u.button.btn = b;
            evt::Post(e);
        };
    };
    auto post_long = [](ButtonId b) {
        return [b]() {
            UiEvent e{};
            e.kind         = UiEventKind::kButtonLong;
            e.u.button.btn = b;
            evt::Post(e);
        };
    };
    auto post_double = [](ButtonId b) {
        return [b]() {
            UiEvent e{};
            e.kind         = UiEventKind::kButtonDouble;
            e.u.button.btn = b;
            evt::Post(e);
        };
    };

    auto* board = &Board::Get();

    // UP/DOWN 走组合键拦截: PressDown 维护 held + 检测组合; Click/LongPress
    // 检查 consumed,若组合键已触发则 skip 单按动作。ENTER 不参与组合,直走。
    board->up_btn()->OnPressDown([] {
        g_combo.up_held     = true;
        g_combo.up_consumed = false;  // 新会话
        TryFireCombo();
    });
    board->up_btn()->OnPressUp([] { g_combo.up_held = false; });
    board->up_btn()->OnClick([cb = post_short(ButtonId::kUp)] {
        if (g_combo.up_consumed)
            return;
        cb();
    });
    board->up_btn()->OnLongPress([cb = post_long(ButtonId::kUp)] {
        if (g_combo.up_consumed)
            return;
        cb();
    });

    board->down_btn()->OnPressDown([] {
        g_combo.down_held     = true;
        g_combo.down_consumed = false;
        TryFireCombo();
    });
    board->down_btn()->OnPressUp([] { g_combo.down_held = false; });
    board->down_btn()->OnClick([cb = post_short(ButtonId::kDown)] {
        if (g_combo.down_consumed)
            return;
        cb();
    });
    board->down_btn()->OnLongPress([cb = post_long(ButtonId::kDown)] {
        if (g_combo.down_consumed)
            return;
        cb();
    });

    board->boot_btn()->OnClick(post_short(ButtonId::kEnter));
    board->boot_btn()->OnDoubleClick(post_double(ButtonId::kEnter));
    // ENTER 长按 1s → frame_scene 接 ButtonLong{kEnter} push SettingsScene。
    board->boot_btn()->OnLongPress(post_long(ButtonId::kEnter));

    // 充电状态变化转发到 EventBus（HAL 不直接知道 EventBus 存在）
    Board::Get().charge()->OnStateChanged([](const ChargeStatus::Snapshot& snap) {
        UiEvent e{};
        e.kind                = UiEventKind::kChargeChanged;
        e.u.charge.state      = static_cast<uint8_t>(snap.state);
        e.u.charge.present    = snap.power_present;
        e.u.charge.charging   = snap.charging;
        e.u.charge.full       = snap.full;
        e.u.charge.no_battery = snap.no_battery;
        evt::Post(e);
    });

    // WiFi 断线转 EventBus（重连成功事件 wifi.cc 内部已处理；这里只接 disconnect）
    Wifi::Get().OnDisconnected([](int /*reason*/) { PostWifiState(false, 0); });
}

void App::StartTimeTick() {
    time_tick_.Start();
}

bool App::InitWifiAndSync(cred::Credentials& creds) {
    Wifi::Get().Init();

    // poll 收 401 → emit kSecretInvalid;UiLoop 拦下来在主线程清 NVS + esp_restart。
    api::SetUnauthorizedHandler([]() {
        UiEvent e{};
        e.kind = UiEventKind::kSecretInvalid;
        evt::Post(e);
    });

    ESP_LOGI(kTag, "Found NVS credentials: ssid=%s have_secret=%d", creds.wifi_ssid.c_str(),
             (int)!creds.device_secret.empty());
    if (TryConnectAndSetup(creds)) {
        // 连上 → 状态栏立即显示 wifi 图标
        PostWifiState(true, Wifi::Get().GetRssi());

        // 启动 SyncService（依赖注入）。首轮同步由 App 根据 boot_mode 显式 Trigger。
        SyncDeps deps;
        deps.read_battery = [](int* mv, int* pct) -> bool {
            uint16_t   mv16 = 0;
            uint8_t    p8   = 0;
            const bool ok   = Board::Get().ReadBattery(&mv16, &p8);
            if (mv)
                *mv = mv16;
            if (pct)
                *pct = p8;
            return ok;
        };
        deps.read_rssi     = []() -> int { return Wifi::Get().GetRssi(); };
        deps.current_group = []() -> std::string {
            std::string gid, etag;
            if (!cache::ReadStateMeta(gid, etag))
                return "";
            return gid;
        };
        // 只有当前帧确实需要定时刷新时才上报 seq，避免静态帧/推送型 dashboard
        // 在每次 poll 时触发后端 current-frame 动态刷新查询。
        deps.current_content_seq = []() -> int {
            return power_state::CurrentFrameNeedsTimerWake() ? power_state::GetCurrentFrameSeq() : -1;
        };
        deps.current_content_etag = []() -> std::string {
            std::string gid;
            std::string manifest_etag;
            if (!cache::ReadStateMeta(gid, manifest_etag) || gid.empty())
                return "";
            cache::FrameMeta meta;
            if (!cache::ReadFrameMeta(gid, power_state::GetCurrentFrameSeq(), meta))
                return "";
            return meta.content_etag;
        };
        deps.manifest_etag = []() -> std::string { return cache::ReadCurrentManifestEtag(); };
        deps.wake_reason   = [this]() -> std::string { return decision_.wake_reason; };
        SyncService::Get().Start(std::move(deps));
        return true;
    } else {
        return false;
    }
}

void App::StartPortal() {
    portal_ = std::make_unique<CaptivePortal>();

    portal_->OnSubmit([](const CaptivePortal::Submission& s, std::string& out_error) -> bool {
        ESP_LOGI(kTag, "Portal /submit: ssid=%s", s.ssid.c_str());
        std::string reason;
        if (!Wifi::Get().TryConnect(s.ssid, s.password, 10000, reason)) {
            out_error = reason;
            ESP_LOGW(kTag, "TryConnect failed: %s", reason.c_str());
            return false;
        }
        cred::Credentials c;
        c.wifi_ssid  = s.ssid;
        c.wifi_pwd   = s.password;
        c.server_url = s.server_url;
        // device_id/device_secret 留空:配网完成 esp_restart 后 InitWifiAndSync 看到无 secret
        // → 走 register 流。设备命名留到 Web 端 PUT /devices/:id 完成绑定后再做。
        if (!cred::Save(c)) {
            out_error = "凭据保存失败,请重试";
            ESP_LOGE(kTag, "Credential save failed");
            return false;
        }
        ESP_LOGI(kTag, "Credentials saved, will reboot soon");
        return true;
    });

    portal_->OnFinished([this](bool success) {
        if (!success)
            return;
        ESP_LOGI(kTag, "Portal finished, stopping AP and rebooting in 500ms");
        portal_->Stop();
        vTaskDelay(pdMS_TO_TICKS(500));
        esp_restart();
    });

    portal_->Start();
}

void App::StartSleep() {
    // 注册 charge callback 时设备可能已经在充电(USB 接着启动),但 ChargeStatus
    // 内部已经在 Init 时把 snapshot 设到 kCharging,callback 不会因"未变化"而再触发。
    // 这里主动 Post 一次让 SleepManager 同步初始 paused_ 状态,免得"开机就充电"
    // 场景被误判为闲置 5min 后睡。
    auto    snap = Board::Get().charge()->Get();
    UiEvent e{};
    e.kind                = UiEventKind::kChargeChanged;
    e.u.charge.state      = static_cast<uint8_t>(snap.state);
    e.u.charge.present    = snap.power_present;
    e.u.charge.charging   = snap.charging;
    e.u.charge.full       = snap.full;
    e.u.charge.no_battery = snap.no_battery;
    evt::Post(e);
}

void App::FinalizePm() {
    // light_sleep_enable=false：USB CDC/JTAG 在用时 ESP32-S3 不允许 CPU power down，
    // sleep_cpu_configure 会打 E 级 log。DFS（80~240 MHz）仍开，空闲时降频省电。
    // 阶段 4 进 deep sleep 替代 light sleep。
    esp_pm_config_t pm = {
        .max_freq_mhz       = 240,
        .min_freq_mhz       = 80,
        .light_sleep_enable = false,
    };
    ESP_ERROR_CHECK(esp_pm_configure(&pm));
    ESP_LOGI(kTag, "PM configured: 80-240MHz DFS, light sleep off");
}

void App::Init() {
    InitStorage();
    InitDevices();
    InitEventBus();
    xiaozhi::ChatService::Get().Start(&AudioPlayer::Get());
    InitSceneStack();

    cred::Credentials creds;
    cred::Load(creds);
    decision_ = boot_mode::Decide(creds);

    SleepManager::Policy policy;
    policy.idle_timeout_min = CONFIG_SLATE_IDLE_DEEP_SLEEP_MIN;
    policy.disabled         = (decision_.mode == boot_mode::Mode::kPortal);
    sleep_mgr_.Init(policy);

    StartUiLoop();
    AttachInputs();
    StartTimeTick();
    StartSleep();

    switch (decision_.mode) {
        case boot_mode::Mode::kPortal:
            ESP_LOGI(kTag, "No credentials -> captive portal");
            Wifi::Get().Init();
            StartPortal();
            break;
        case boot_mode::Mode::kBackgroundRefresh: {
            const bool net_ok = InitWifiAndSync(creds);
            if (net_ok) {
                SyncService::Get().TriggerWakeRefresh();
            } else {
                ESP_LOGW(kTag, "Background refresh network setup failed -> deep sleep");
                UiEvent e{};
                e.kind = UiEventKind::kBgRefreshDone;
                evt::Post(e, portMAX_DELAY);
            }
            break;
        }
        case boot_mode::Mode::kFullActive: {
            const bool net_ok = InitWifiAndSync(creds);
            if (net_ok && !decision_.first_register) {
                PostCachedGroupReadyIfAny();
                if (decision_.wake_cause == boot_mode::WakeCause::kButton) {
                    PostWakeupKeyEvent(decision_.ext1_mask);
                }
            }
            if (net_ok) {
                SyncService::Get().TriggerNow();
            } else {
                ESP_LOGW(kTag, "Fallback to captive portal");
                StartPortal();
                sleep_mgr_.Disable();
            }
            break;
        }
    }

    FinalizePm();
}

void App::Run() {
    // main task Init 完毕。释放栈，让 ui_loop / sync / charge_tick / audio / epd_refresh
    // 各自后台跑。直接 return 会被 IDF abort，必须 vTaskDelete。
    vTaskDelete(nullptr);
}
