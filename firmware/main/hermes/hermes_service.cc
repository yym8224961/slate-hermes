     1|#include "hermes/hermes_service.h"
     2|
     3|#include <cJSON.h>
     4|#include <esp_http_client.h>
     5|#include <esp_log.h>
     6|#include <mbedtls/base64.h>
     7|
     8|#include <algorithm>
     9|#include <cstdio>
    10|#include <cstring>
    11|
    12|#include "drivers/audio/audio_player.h"
    13|#include "events/event_bus.h"
    14|#include "network/cred_store.h"
    15|#include "storage/nvs/volume_store.h"
    16|
    17|namespace {
    18|constexpr char kTag[]         = "hermes";
    19|constexpr int  kMaxRecordSec  = 15;   // max recording duration
    20|constexpr int  kSampleRate    = 16000;
    21|constexpr int  kBufSizeBytes  = 4096;
    22|
    23|const char* StateName(hermes::HermesState state) {
    24|    switch (state) {
    25|        case hermes::HermesState::kIdle:      return "idle";
    26|        case hermes::HermesState::kRecording:  return "recording";
    27|        case hermes::HermesState::kSending:    return "sending";
    28|        case hermes::HermesState::kThinking:   return "thinking";
    29|        case hermes::HermesState::kSpeaking:   return "speaking";
    30|        case hermes::HermesState::kError:      return "error";
    31|    }
    32|    return "unknown";
    33|}
    34|
    35|// Simple base64 encode using mbedtls
    36|std::string Base64Encode(const uint8_t* data, size_t len) {
    37|    size_t out_len = 0;
    38|    mbedtls_base64_encode(nullptr, 0, &out_len, data, len);
    39|    std::string result(out_len, '\0');
    40|    mbedtls_base64_encode(reinterpret_cast<unsigned char*>(&result[0]), result.size(), &out_len, data, len);
    41|    // Remove trailing nulls/newlines that mbedtls might add
    42|    while (!result.empty() && (result.back() == '\0' || result.back() == '\n'))
    43|        result.pop_back();
    44|    return result;
    45|}
    46|}  // namespace
    47|
    48|namespace hermes {
    49|
    50|HermesService& HermesService::Get() {
    51|    static HermesService s;
    52|    return s;
    53|}
    54|
    55|bool HermesService::Start(AudioPlayer* player) {
    56|    if (!player) return false;
    57|    player_ = player;
    58|
    59|    if (started_.load(std::memory_order_relaxed))
    60|        return true;
    61|
    62|    saved_volume_ = vol::GetVolume();
    63|    {
    64|        std::lock_guard<std::mutex> lock(snapshot_mutex_);
    65|        snapshot_.volume = saved_volume_;
    66|        snapshot_.state  = HermesState::kIdle;
    67|        snapshot_.status = "Hermes待机";
    68|    }
    69|
    70|    started_.store(true, std::memory_order_relaxed);
    71|    ESP_LOGI(kTag, "hermes service started");
    72|    return true;
    73|}
    74|
    75|void HermesService::EnterMode() {
    76|    in_mode_.store(true, std::memory_order_relaxed);
    77|    {
    78|        std::lock_guard<std::mutex> lock(snapshot_mutex_);
    79|        snapshot_.volume     = vol::GetVolume();
    80|        snapshot_.messages.clear();
    81|        snapshot_.error.clear();
    82|        snapshot_.record_sec = 0;
    83|    }
    84|    SetState(HermesState::kIdle, "Hermes - 按确认说话");
    85|    ESP_LOGI(kTag, "enter mode");
    86|}
    87|
    88|void HermesService::LeaveMode() {
    89|    in_mode_.store(false, std::memory_order_relaxed);
    90|    StopConversation();
    91|    ESP_LOGI(kTag, "leave mode");
    92|}
    93|
    94|void HermesService::ToggleChat() {
    95|    const HermesState state = CurrentState();
    96|    ESP_LOGI(kTag, "toggle state=%s", StateName(state));
    97|
    98|    switch (state) {
    99|        case HermesState::kIdle:
   100|        case HermesState::kError:
   101|            StartRecording();
   102|            break;
   103|        case HermesState::kRecording:
   104|            StopAndSend();
   105|            break;
   106|        case HermesState::kSending:
   107|        case HermesState::kThinking:
   108|        case HermesState::kSpeaking:
   109|            StopConversation();
   110|            break;
   111|    }
   112|}
   113|
   114|void HermesService::StartRecording() {
   115|    if (!player_ || !started_.load(std::memory_order_relaxed))
   116|        return;
   117|
   118|    // Take exclusive audio control
   119|    if (!player_->BeginXiaozhi()) {
   120|        ESP_LOGE(kTag, "failed to begin voice mode");
   121|        SetError("麦克风启动失败");
   122|        return;
   123|    }
   124|
   125|    {
   126|        std::lock_guard<std::mutex> lock(pcm_mutex_);
   127|        pcm_buffer_.clear();
   128|        pcm_buffer_.reserve(kSampleRate * kMaxRecordSec);  // pre-allocate
   129|    }
   130|
   131|    record_stop_.store(false, std::memory_order_relaxed);
   132|    recording_.store(true, std::memory_order_relaxed);
   133|
   134|    // Start recording task
   135|    BaseType_t ok = xTaskCreatePinnedToCore(
   136|        &HermesService::RecordTaskEntry, "hermes_rec", 8 * 1024,
   137|        this, 5, &record_task_, 0);
   138|
   139|    if (ok != pdPASS) {
   140|        ESP_LOGE(kTag, "record task create failed");
   141|        recording_.store(false, std::memory_order_relaxed);
   142|        player_->EndXiaozhi();
   143|        SetError("录音任务启动失败");
   144|        return;
   145|    }
   146|
   147|    SetState(HermesState::kRecording, "正在听...");
   148|    ESP_LOGI(kTag, "recording started");
   149|}
   150|
   151|void HermesService::StopAndSend() {
   152|    if (!recording_.load(std::memory_order_relaxed))
   153|        return;
   154|
   155|    ESP_LOGI(kTag, "stopping recording");
   156|
   157|    // Signal record task to stop
   158|    record_stop_.store(true, std::memory_order_relaxed);
   159|
   160|    // Wait briefly for task to finish
   161|    vTaskDelay(pdMS_TO_TICKS(200));
   162|
   163|    recording_.store(false, std::memory_order_relaxed);
   164|
   165|    // Get recorded PCM
   166|    std::vector<int16_t> pcm;
   167|    {
   168|        std::lock_guard<std::mutex> lock(pcm_mutex_);
   169|        pcm = std::move(pcm_buffer_);
   170|        pcm_buffer_.clear();
   171|    }
   172|
   173|    // Release audio hardware
   174|    if (player_)
   175|        player_->EndXiaozhi();
   176|
   177|    if (pcm.empty()) {
   178|        ESP_LOGW(kTag, "no audio recorded");
   179|        SetState(HermesState::kIdle, "没录到声音，再试一次？");
   180|        return;
   181|    }
   182|
   183|    ESP_LOGI(kTag, "recorded %d samples (%.1fs)", (int)pcm.size(), (float)pcm.size() / kSampleRate);
   184|
   185|    SetState(HermesState::kSending, "发送中...");
   186|    SendAudioToBackend(pcm);
   187|}
   188|
   189|void HermesService::SendAudioToBackend(const std::vector<int16_t>& pcm) {
   190|    cred::Credentials creds;
   191|    if (!cred::Load(creds) || creds.server_url.empty() || creds.device_secret.empty()) {
   192|        SetError("设备未绑定");
   193|        return;
   194|    }
   195|
   196|    // Base64 encode the PCM data
   197|    std::string audio_b64 = Base64Encode(
   198|        reinterpret_cast<const uint8_t*>(pcm.data()),
   199|        pcm.size() * sizeof(int16_t));
   200|
   201|    ESP_LOGI(kTag, "pcm encoded base64_len=%d", (int)audio_b64.size());
   202|
   203|    // Build JSON body
   204|    cJSON* root = cJSON_CreateObject();
   205|    cJSON_AddStringToObject(root, "audio", audio_b64.c_str());
   206|
   207|    // Add history
   208|    cJSON* history = cJSON_AddArrayToObject(root, "history");
   209|    {
   210|        std::lock_guard<std::mutex> lock(snapshot_mutex_);
   211|        for (const auto& msg : snapshot_.messages) {
   212|            cJSON* item = cJSON_CreateObject();
   213|            cJSON_AddStringToObject(item, "role", msg.role.c_str());
   214|            cJSON_AddStringToObject(item, "content", msg.text.c_str());
   215|            cJSON_AddItemToArray(history, item);
   216|        }
   217|    }
   218|
   219|    char* body_str = cJSON_PrintUnformatted(root);
   220|    cJSON_Delete(root);
   221|
   222|    // Build URL
   223|    std::string url = creds.server_url;
   224|    if (url.back() == '/') url.pop_back();
   225|    url += "/api/v1/hermes/chat";
   226|
   227|    std::string auth = "Bearer " + creds.device_secret;
   228|
   229|    ESP_LOGI(kTag, "POST to %s body_len=%d", url.c_str(), (int)strlen(body_str));
   230|
   231|    esp_http_client_config_t config = {};
   232|    config.url                     = url.c_str();
   233|    config.method                  = HTTP_METHOD_POST;
   234|    config.timeout_ms              = 30000;
   235|    config.buffer_size             = 8192;
   236|    config.disable_auto_redirect   = true;
   237|
   238|    esp_http_client_handle_t client = esp_http_client_init(&config);
   239|    esp_http_client_set_header(client, "Content-Type", "application/json");
   240|    esp_http_client_set_header(client, "Authorization", auth.c_str());
   241|    esp_http_client_set_post_field(client, body_str, strlen(body_str));
   242|
   243|    SetState(HermesState::kThinking, "Hermes思考中...");
   244|
   245|    esp_err_t err = esp_http_client_perform(client);
   246|
   247|    if (err == ESP_OK) {
   248|        int status = esp_http_client_get_status_code(client);
   249|        ESP_LOGI(kTag, "response status=%d", status);
   250|
   251|        if (status == 200) {
   252|            // Read response body
   253|            std::string resp_body;
   254|            char chunk[1024];
   255|            int read;
   256|            while ((read = esp_http_client_read(client, chunk, sizeof(chunk) - 1)) > 0) {
   257|                chunk[read] = '\0';
   258|                resp_body += chunk;
   259|                if (resp_body.size() > 8192) break;
   260|            }
   261|
   262|            cJSON* resp = cJSON_Parse(resp_body.c_str());
   263|            if (resp) {
   264|                cJSON* text_item  = cJSON_GetObjectItem(resp, "text");
   265|                cJSON* audio_item = cJSON_GetObjectItem(resp, "audio");
   266|
   267|                std::string response_text;
   268|                if (text_item && cJSON_IsString(text_item) && text_item->valuestring)
   269|                    response_text = text_item->valuestring;
   270|
   271|                if (!response_text.empty()) {
   272|                    // Add to message history
   273|                    {
   274|                        std::lock_guard<std::mutex> lock(snapshot_mutex_);
   275|                        // We don't have transcription yet, so use placeholder
   276|                        snapshot_.messages.push_back({"user", "（语音消息）"});
   277|                        snapshot_.messages.push_back({"assistant", response_text});
   278|                        while (snapshot_.messages.size() > 20)
   279|                            snapshot_.messages.erase(snapshot_.messages.begin());
   280|                    }
   281|
   282|                    // Play TTS audio if available
   283|                    if (audio_item && cJSON_IsString(audio_item) && audio_item->valuestring) {
   284|                        // Decode base64 audio
   285|                        std::string audio_b64 = audio_item->valuestring;
   286|                        size_t out_len = 0;
   287|                        mbedtls_base64_decode(nullptr, 0, &out_len,
   288|                            reinterpret_cast<const unsigned char*>(audio_b64.data()), audio_b64.size());
   289|
   290|                        if (out_len > 0 && player_) {
   291|                            std::vector<uint8_t> pcm_data(out_len);
   292|                            int ret = mbedtls_base64_decode(
   293|                                pcm_data.data(), pcm_data.size(), &out_len,
   294|                                reinterpret_cast<const unsigned char*>(audio_b64.data()), audio_b64.size());
   295|                            if (ret == 0 && out_len > 0) {
   296|                                pcm_data.resize(out_len);
   297|                                // Play via Xiaozhi interface
   298|                                player_->BeginXiaozhi();
   299|                                player_->WriteXiaozhiPcm(
   300|                                    reinterpret_cast<const int16_t*>(pcm_data.data()),
   301|                                    out_len / sizeof(int16_t));
   302|                                vTaskDelay(pdMS_TO_TICKS(500));  // brief delay for playback
   303|                                player_->EndXiaozhi();
   304|                                ESP_LOGI(kTag, "tts played %d bytes", (int)out_len);
   305|                            }
   306|                        }
   307|                    }
   308|
   309|                    SetState(HermesState::kSpeaking, response_text);
   310|                } else {
   311|                    SetState(HermesState::kIdle, "Hermes没听清，再说一次？");
   312|                }
   313|                cJSON_Delete(resp);
   314|            } else {
   315|                ESP_LOGW(kTag, "bad json: %s", resp_body.c_str());
   316|                SetError("后端响应异常");
   317|            }
   318|        } else if (status == 401) {
   319|            SetError("设备认证失败");
   320|        } else {
   321|            ESP_LOGW(kTag, "backend error %d", status);
   322|            SetError("Hermes暂时连不上...");
   323|        }
   324|    } else {
   325|        ESP_LOGE(kTag, "http failed: %s", esp_err_to_name(err));
   326|        SetError("网络连接失败");
   327|    }
   328|
   329|    esp_http_client_cleanup(client);
   330|    free(body_str);
   331|}
   332|
   333|void HermesService::StopConversation() {
   334|    ESP_LOGI(kTag, "stop conversation");
   335|
   336|    recording_.store(false, std::memory_order_relaxed);
   337|    record_stop_.store(true, std::memory_order_relaxed);
   338|
   339|    // Clear PCM buffer
   340|    {
   341|        std::lock_guard<std::mutex> lock(pcm_mutex_);
   342|        pcm_buffer_.clear();
   343|    }
   344|
   345|    if (player_ && player_->IsXiaozhiActive())
   346|        player_->EndXiaozhi();
   347|
   348|    if (CurrentState() != HermesState::kIdle)
   349|        SetState(HermesState::kIdle, "Hermes - 按确认说话");
   350|}
   351|
   352|void HermesService::AdjustVolume(int delta) {
   353|    const int level = std::clamp(saved_volume_ + delta, 0, vol::kMax);
   354|    SetVolume(level);
   355|}
   356|
   357|void HermesService::SetVolume(int level) {
   358|    level = std::clamp(level, 0, vol::kMax);
   359|    saved_volume_ = level;
   360|    vol::SetVolume(level);
   361|    if (player_)
   362|        player_->SetVolume(vol::ToCodec(level));
   363|    {
   364|        std::lock_guard<std::mutex> lock(snapshot_mutex_);
   365|        snapshot_.volume = level;
   366|    }
   367|    PostChanged();
   368|}
   369|
   370|bool HermesService::BlocksSleep() const {
   371|    return in_mode_.load(std::memory_order_relaxed) &&
   372|           CurrentState() != HermesState::kIdle;
   373|}
   374|
   375|void HermesService::SuspendForSleep() {
   376|    in_mode_.store(false, std::memory_order_relaxed);
   377|    StopConversation();
   378|}
   379|
   380|HermesSnapshot HermesService::Snapshot() {
   381|    std::lock_guard<std::mutex> lock(snapshot_mutex_);
   382|    return snapshot_;
   383|}
   384|
   385|HermesState HermesService::CurrentState() const {
   386|    std::lock_guard<std::mutex> lock(snapshot_mutex_);
   387|    return snapshot_.state;
   388|}
   389|
   390|void HermesService::SetState(HermesState state, const std::string& status) {
   391|    {
   392|        std::lock_guard<std::mutex> lock(snapshot_mutex_);
   393|        snapshot_.state  = state;
   394|        snapshot_.status = status;
   395|    }
   396|    ESP_LOGD(kTag, "state -> %s", StateName(state));
   397|    PostChanged();
   398|}
   399|
   400|void HermesService::SetError(const std::string& error) {
   401|    {
   402|        std::lock_guard<std::mutex> lock(snapshot_mutex_);
   403|        snapshot_.state  = HermesState::kError;
   404|        snapshot_.error  = error;
   405|        snapshot_.status = "出错了";
   406|    }
   407|    ESP_LOGW(kTag, "error: %s", error.c_str());
   408|    PostChanged();
   409|}
   410|
   411|void HermesService::PostChanged() {
   412|    evt::PostSimple(UiEventKind::kHermesChanged);
   413|}
   414|
   415|// ── Recording Task ──────────────────────────────────────────────────
   416|
   417|void HermesService::RecordTaskEntry(void* arg) {
   418|    auto* self = static_cast<HermesService*>(arg);
   419|    self->RecordTask();
   420|    self->record_task_ = nullptr;
   421|    vTaskDelete(nullptr);
   422|}
   423|
   424|void HermesService::RecordTask() {
   425|    ESP_LOGI(kTag, "record task started");
   426|    std::vector<int16_t> chunk(512);  // 32ms at 16kHz
   427|
   428|    int        total_samples = 0;
   429|    const int  max_samples   = kSampleRate * kMaxRecordSec;
   430|
   431|    while (!record_stop_.load(std::memory_order_relaxed) && total_samples < max_samples) {
   432|        if (!player_ || !player_->IsXiaozhiActive()) {
   433|            ESP_LOGW(kTag, "player not active during record");
   434|            break;
   435|        }
   436|
   437|        if (!player_->ReadXiaozhiPcm(chunk.data(), chunk.size())) {
   438|            vTaskDelay(pdMS_TO_TICKS(10));
   439|            continue;
   440|        }
   441|
   442|        {
   443|            std::lock_guard<std::mutex> lock(pcm_mutex_);
   444|            pcm_buffer_.insert(pcm_buffer_.end(), chunk.begin(), chunk.end());
   445|        }
   446|
   447|        total_samples += chunk.size();
   448|
   449|        // Update recording seconds
   450|        int sec = total_samples / kSampleRate;
   451|        {
   452|            std::lock_guard<std::mutex> lock(snapshot_mutex_);
   453|            snapshot_.record_sec = sec;
   454|        }
   455|        // Post change every second
   456|        if (sec > 0 && (total_samples % kSampleRate) < (int)chunk.size())
   457|            PostChanged();
   458|    }
   459|
   460|    ESP_LOGI(kTag, "record task stopped samples=%d sec=%d", total_samples, total_samples / kSampleRate);
   461|}
   462|
   463|}  // namespace hermes
   464|