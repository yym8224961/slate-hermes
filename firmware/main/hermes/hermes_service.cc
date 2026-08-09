#include "hermes/hermes_service.h"

#include <cJSON.h>
#include <esp_crt_bundle.h>
#include <esp_http_client.h>
#include <esp_log.h>
#include <mbedtls/base64.h>

#include <algorithm>
#include <cstdio>
#include <cstring>

#include "bsp/config.h"
#include "drivers/audio/audio_player.h"
#include "events/event_bus.h"
#include "network/cred_store.h"
#include "storage/nvs/volume_store.h"

namespace {
constexpr char   kTag[]              = "hermes";
constexpr int    kMaxRecordSec       = 15;  // max recording duration
constexpr int    kSampleRate         = 16000;
constexpr int    kBufSizeBytes       = 4096;
constexpr int    kHttpTimeoutMs      = 75000;
constexpr size_t kMaxReplyAudioBytes = static_cast<size_t>(kSampleRate) * AUDIO_PCM_BYTES_PER_SAMPLE * 20;
constexpr size_t kMaxResponseBytes   = ((kMaxReplyAudioBytes + 2) / 3) * 4 + 8192;

const char* StateName(hermes::HermesState state) {
    switch (state) {
        case hermes::HermesState::kIdle:
            return "idle";
        case hermes::HermesState::kRecording:
            return "recording";
        case hermes::HermesState::kSending:
            return "sending";
        case hermes::HermesState::kThinking:
            return "thinking";
        case hermes::HermesState::kSpeaking:
            return "speaking";
        case hermes::HermesState::kError:
            return "error";
    }
    return "unknown";
}

// Simple base64 encode using mbedtls
std::string Base64Encode(const uint8_t* data, size_t len) {
    size_t out_len = 0;
    mbedtls_base64_encode(nullptr, 0, &out_len, data, len);
    std::string result(out_len, '\0');
    mbedtls_base64_encode(reinterpret_cast<unsigned char*>(&result[0]), result.size(), &out_len, data, len);
    // Remove trailing nulls/newlines that mbedtls might add
    while (!result.empty() && (result.back() == '\0' || result.back() == '\n'))
        result.pop_back();
    return result;
}
}  // namespace

namespace hermes {

HermesService& HermesService::Get() {
    static HermesService s;
    return s;
}

bool HermesService::Start(AudioPlayer* player) {
    if (!player)
        return false;
    player_ = player;

    if (started_.load(std::memory_order_relaxed))
        return true;

    saved_volume_ = vol::Get();
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.volume = saved_volume_;
        snapshot_.state  = HermesState::kIdle;
        snapshot_.status = "Hermes待机";
    }

    started_.store(true, std::memory_order_relaxed);
    ESP_LOGI(kTag, "hermes service started");
    return true;
}

void HermesService::EnterMode() {
    in_mode_.store(true, std::memory_order_relaxed);
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.volume = vol::Get();
        snapshot_.messages.clear();
        snapshot_.error.clear();
        snapshot_.record_sec = 0;
    }
    SetState(HermesState::kIdle, "Hermes - 按确认说话");
    ESP_LOGI(kTag, "enter mode");
}

void HermesService::LeaveMode() {
    in_mode_.store(false, std::memory_order_relaxed);
    StopConversation();
    ESP_LOGI(kTag, "leave mode");
}

void HermesService::ToggleChat() {
    const HermesState state = CurrentState();
    ESP_LOGI(kTag, "toggle state=%s", StateName(state));

    switch (state) {
        case HermesState::kIdle:
        case HermesState::kError:
            StartRecording();
            break;
        case HermesState::kRecording:
            StopAndSend();
            break;
        case HermesState::kSending:
        case HermesState::kThinking:
        case HermesState::kSpeaking:
            StopConversation();
            break;
    }
}

void HermesService::StartRecording() {
    if (!player_ || !started_.load(std::memory_order_relaxed))
        return;

    // Take exclusive audio control
    if (!player_->BeginXiaozhi()) {
        ESP_LOGE(kTag, "failed to begin voice mode");
        SetError("麦克风启动失败");
        return;
    }

    {
        std::lock_guard<std::mutex> lock(pcm_mutex_);
        pcm_buffer_.clear();
        pcm_buffer_.reserve(kSampleRate * kMaxRecordSec);  // pre-allocate
    }

    record_stop_.store(false, std::memory_order_relaxed);
    recording_.store(true, std::memory_order_relaxed);

    // Start recording task
    BaseType_t ok =
        xTaskCreatePinnedToCore(&HermesService::RecordTaskEntry, "hermes_rec", 8 * 1024, this, 5, &record_task_, 0);

    if (ok != pdPASS) {
        ESP_LOGE(kTag, "record task create failed");
        recording_.store(false, std::memory_order_relaxed);
        player_->EndXiaozhi();
        SetError("录音任务启动失败");
        return;
    }

    SetState(HermesState::kRecording, "正在听...");
    ESP_LOGI(kTag, "recording started");
}

void HermesService::StopAndSend() {
    if (!recording_.load(std::memory_order_relaxed))
        return;

    ESP_LOGI(kTag, "stopping recording");

    // Signal record task to stop
    record_stop_.store(true, std::memory_order_relaxed);

    // Wait briefly for task to finish
    vTaskDelay(pdMS_TO_TICKS(200));

    recording_.store(false, std::memory_order_relaxed);

    // Get recorded PCM
    std::vector<int16_t> pcm;
    {
        std::lock_guard<std::mutex> lock(pcm_mutex_);
        pcm = std::move(pcm_buffer_);
        pcm_buffer_.clear();
    }

    // Release audio hardware
    if (player_)
        player_->EndXiaozhi();

    if (pcm.empty()) {
        ESP_LOGW(kTag, "no audio recorded");
        SetState(HermesState::kIdle, "没录到声音，再试一次？");
        return;
    }

    ESP_LOGI(kTag, "recorded %d samples (%.1fs)", (int)pcm.size(), (float)pcm.size() / kSampleRate);

    SetState(HermesState::kSending, "发送中...");
    SendAudioToBackend(pcm);
}

void HermesService::SendAudioToBackend(const std::vector<int16_t>& pcm) {
    cred::Credentials creds;
    if (!cred::Load(creds) || creds.server_url.empty() || creds.device_secret.empty()) {
        SetError("设备未绑定");
        return;
    }

    // Base64 encode the PCM data
    std::string audio_b64 = Base64Encode(reinterpret_cast<const uint8_t*>(pcm.data()), pcm.size() * sizeof(int16_t));

    ESP_LOGI(kTag, "pcm encoded base64_len=%d", (int)audio_b64.size());

    // Build JSON body
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "audio", audio_b64.c_str());

    // Add history
    cJSON* history = cJSON_AddArrayToObject(root, "history");
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        for (const auto& msg : snapshot_.messages) {
            cJSON* item = cJSON_CreateObject();
            cJSON_AddStringToObject(item, "role", msg.role.c_str());
            cJSON_AddStringToObject(item, "content", msg.text.c_str());
            cJSON_AddItemToArray(history, item);
        }
    }

    char* body_str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!body_str) {
        SetError("请求编码失败");
        return;
    }

    // Build URL
    std::string url = creds.server_url;
    if (url.back() == '/')
        url.pop_back();
    url += "/api/v1/hermes/chat";

    std::string auth = "Bearer " + creds.device_secret;

    ESP_LOGI(kTag, "POST to %s body_len=%d", url.c_str(), (int)strlen(body_str));

    esp_http_client_config_t config = {};
    config.url                      = url.c_str();
    config.method                   = HTTP_METHOD_POST;
    config.timeout_ms               = kHttpTimeoutMs;
    config.buffer_size              = 8192;
    config.disable_auto_redirect    = true;
    config.crt_bundle_attach        = esp_crt_bundle_attach;

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) {
        free(body_str);
        SetError("网络连接失败");
        return;
    }
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_header(client, "Authorization", auth.c_str());

    SetState(HermesState::kThinking, "Hermes思考中...");

    const size_t body_len = strlen(body_str);
    esp_err_t    err      = esp_http_client_open(client, body_len);
    if (err == ESP_OK) {
        const int written = esp_http_client_write(client, body_str, body_len);
        if (written != static_cast<int>(body_len))
            err = ESP_FAIL;
    }
    int64_t content_length = -1;
    if (err == ESP_OK)
        content_length = esp_http_client_fetch_headers(client);

    if (err == ESP_OK && content_length >= 0) {
        int status = esp_http_client_get_status_code(client);
        ESP_LOGI(kTag, "response status=%d", status);

        if (status == 200 && content_length <= static_cast<int64_t>(kMaxResponseBytes)) {
            std::string resp_body;
            if (content_length > 0)
                resp_body.reserve(static_cast<size_t>(content_length));
            char chunk[1024];
            int  read;
            while ((read = esp_http_client_read(client, chunk, sizeof(chunk))) > 0) {
                resp_body.append(chunk, read);
                if (resp_body.size() > kMaxResponseBytes) {
                    resp_body.clear();
                    break;
                }
            }

            cJSON* resp = resp_body.empty() ? nullptr : cJSON_ParseWithLength(resp_body.data(), resp_body.size());
            if (resp) {
                cJSON* text_item  = cJSON_GetObjectItem(resp, "text");
                cJSON* audio_item = cJSON_GetObjectItem(resp, "audio");

                std::string response_text;
                if (text_item && cJSON_IsString(text_item) && text_item->valuestring)
                    response_text = text_item->valuestring;

                if (!response_text.empty()) {
                    {
                        std::lock_guard<std::mutex> lock(snapshot_mutex_);
                        snapshot_.messages.push_back({"user", "（语音消息）"});
                        snapshot_.messages.push_back({"assistant", response_text});
                        while (snapshot_.messages.size() > 20)
                            snapshot_.messages.erase(snapshot_.messages.begin());
                    }

                    SetState(HermesState::kSpeaking, response_text);
                    if (audio_item && cJSON_IsString(audio_item) && audio_item->valuestring) {
                        const auto*  audio_b64     = reinterpret_cast<const unsigned char*>(audio_item->valuestring);
                        const size_t audio_b64_len = strlen(audio_item->valuestring);
                        size_t       out_len       = 0;
                        mbedtls_base64_decode(nullptr, 0, &out_len, audio_b64, audio_b64_len);

                        if (out_len > 0 && out_len <= kMaxReplyAudioBytes && player_) {
                            std::vector<uint8_t> pcm_data(out_len);
                            int ret = mbedtls_base64_decode(pcm_data.data(), pcm_data.size(), &out_len, audio_b64,
                                                            audio_b64_len);
                            if (ret == 0 && out_len > 0 && player_->BeginXiaozhi()) {
                                pcm_data.resize(out_len);
                                player_->WriteXiaozhiPcm(reinterpret_cast<const int16_t*>(pcm_data.data()),
                                                         out_len / sizeof(int16_t));
                                player_->EndXiaozhi();
                                ESP_LOGI(kTag, "tts played %d bytes", (int)out_len);
                            }
                        }
                    }
                    SetState(HermesState::kIdle, response_text);
                } else {
                    SetState(HermesState::kIdle, "Hermes没听清，再说一次？");
                }
                cJSON_Delete(resp);
            } else {
                ESP_LOGW(kTag, "invalid or oversized JSON response");
                SetError("后端响应异常");
            }
        } else if (status == 401) {
            SetError("设备认证失败");
        } else if (content_length > static_cast<int64_t>(kMaxResponseBytes)) {
            ESP_LOGW(kTag, "response too large: %lld", (long long)content_length);
            SetError("Hermes回复太长了");
        } else {
            ESP_LOGW(kTag, "backend error %d", status);
            SetError("Hermes暂时连不上...");
        }
    } else {
        ESP_LOGE(kTag, "http failed: %s", esp_err_to_name(err));
        SetError("网络连接失败");
    }

    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    free(body_str);
}

void HermesService::StopConversation() {
    ESP_LOGI(kTag, "stop conversation");

    recording_.store(false, std::memory_order_relaxed);
    record_stop_.store(true, std::memory_order_relaxed);

    // Clear PCM buffer
    {
        std::lock_guard<std::mutex> lock(pcm_mutex_);
        pcm_buffer_.clear();
    }

    if (player_ && player_->IsXiaozhiActive())
        player_->EndXiaozhi();

    if (CurrentState() != HermesState::kIdle)
        SetState(HermesState::kIdle, "Hermes - 按确认说话");
}

void HermesService::AdjustVolume(int delta) {
    const int level = std::clamp(saved_volume_ + delta, 0, vol::kMax);
    SetVolume(level);
}

void HermesService::SetVolume(int level) {
    level         = std::clamp(level, 0, vol::kMax);
    saved_volume_ = level;
    vol::Set(level);
    if (player_)
        player_->SetVolume(vol::ToCodec(level));
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.volume = level;
    }
    PostChanged();
}

bool HermesService::BlocksSleep() const {
    return in_mode_.load(std::memory_order_relaxed) && CurrentState() != HermesState::kIdle;
}

void HermesService::SuspendForSleep() {
    in_mode_.store(false, std::memory_order_relaxed);
    StopConversation();
}

HermesSnapshot HermesService::Snapshot() {
    std::lock_guard<std::mutex> lock(snapshot_mutex_);
    return snapshot_;
}

HermesState HermesService::CurrentState() const {
    std::lock_guard<std::mutex> lock(snapshot_mutex_);
    return snapshot_.state;
}

void HermesService::SetState(HermesState state, const std::string& status) {
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.state  = state;
        snapshot_.status = status;
    }
    ESP_LOGD(kTag, "state -> %s", StateName(state));
    PostChanged();
}

void HermesService::SetError(const std::string& error) {
    {
        std::lock_guard<std::mutex> lock(snapshot_mutex_);
        snapshot_.state  = HermesState::kError;
        snapshot_.error  = error;
        snapshot_.status = "出错了";
    }
    ESP_LOGW(kTag, "error: %s", error.c_str());
    PostChanged();
}

void HermesService::PostChanged() {
    evt::PostSimple(UiEventKind::kHermesChanged);
}

// ── Recording Task ──────────────────────────────────────────────────

void HermesService::RecordTaskEntry(void* arg) {
    auto* self = static_cast<HermesService*>(arg);
    self->RecordTask();
    self->record_task_ = nullptr;
    vTaskDelete(nullptr);
}

void HermesService::RecordTask() {
    ESP_LOGI(kTag, "record task started");
    std::vector<int16_t> chunk(512);  // 32ms at 16kHz

    int       total_samples = 0;
    const int max_samples   = kSampleRate * kMaxRecordSec;

    while (!record_stop_.load(std::memory_order_relaxed) && total_samples < max_samples) {
        if (!player_ || !player_->IsXiaozhiActive()) {
            ESP_LOGW(kTag, "player not active during record");
            break;
        }

        if (!player_->ReadXiaozhiPcm(chunk.data(), chunk.size())) {
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }

        {
            std::lock_guard<std::mutex> lock(pcm_mutex_);
            pcm_buffer_.insert(pcm_buffer_.end(), chunk.begin(), chunk.end());
        }

        total_samples += chunk.size();

        // Update recording seconds
        int sec = total_samples / kSampleRate;
        {
            std::lock_guard<std::mutex> lock(snapshot_mutex_);
            snapshot_.record_sec = sec;
        }
        // Post change every second
        if (sec > 0 && (total_samples % kSampleRate) < (int)chunk.size())
            PostChanged();
    }

    ESP_LOGI(kTag, "record task stopped samples=%d sec=%d", total_samples, total_samples / kSampleRate);
}

}  // namespace hermes
