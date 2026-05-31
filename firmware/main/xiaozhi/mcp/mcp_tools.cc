#include "xiaozhi/mcp/mcp_tools.h"

#include <cJSON.h>

#include <cstdint>

#include "bsp/board.h"
#include "bsp/charge_status.h"
#include "network/wifi.h"
#include "storage/nvs/volume_store.h"
#include "utils/json_utils.h"
#include "xiaozhi/config/settings.h"
#include "xiaozhi/service/audio_service.h"
#include "xiaozhi/service/chat_service.h"

namespace xiaozhi::mcp {
namespace {

using json_utils::JsonId;
using json_utils::PrintAndDelete;

std::string ChatStateName(ChatState state) {
    switch (state) {
        case ChatState::kCheckingConfig:
            return "checking_config";
        case ChatState::kAwaitingActivation:
            return "awaiting_activation";
        case ChatState::kReadyIdle:
            return "ready_idle";
        case ChatState::kConnecting:
            return "connecting";
        case ChatState::kListening:
            return "listening";
        case ChatState::kSpeaking:
            return "speaking";
        case ChatState::kStopping:
            return "stopping";
        case ChatState::kError:
            return "error";
    }
    return "unknown";
}

std::string ChargeStateName(ChargeStatus::State state) {
    switch (state) {
        case ChargeStatus::State::kNoPower:
            return "no_power";
        case ChargeStatus::State::kCharging:
            return "charging";
        case ChargeStatus::State::kFull:
            return "full";
        case ChargeStatus::State::kNoBattery:
            return "no_battery";
    }
    return "unknown";
}

cJSON* MakeObjectSchema() {
    cJSON* schema = cJSON_CreateObject();
    cJSON_AddStringToObject(schema, "type", "object");
    cJSON_AddItemToObject(schema, "properties", cJSON_CreateObject());
    return schema;
}

}  // namespace

std::string BuildDeviceStatusJson() {
    cJSON* root = cJSON_CreateObject();

    cJSON*    audio      = cJSON_CreateObject();
    const int chat_level = settings::GetVolume();
    cJSON_AddNumberToObject(audio, "volume", vol::ToCodec(chat_level));
    cJSON_AddNumberToObject(audio, "level", chat_level);
    cJSON_AddNumberToObject(audio, "max_level", vol::kMax);
    cJSON_AddBoolToObject(audio, "chat_active", AudioService::Get().IsActive());
    cJSON_AddBoolToObject(audio, "voice_processing", AudioService::Get().IsVoiceProcessing());
    cJSON_AddItemToObject(root, "audio_speaker", audio);

    auto& board = Board::Get();
    if (auto* charge = board.charge()) {
        const auto snap         = charge->Get();
        cJSON*     battery      = cJSON_CreateObject();
        uint16_t   mv           = 0;
        uint8_t    pct          = 0;
        const bool have_battery = board.ReadBattery(&mv, &pct);
        cJSON_AddStringToObject(battery, "state", ChargeStateName(snap.state).c_str());
        cJSON_AddBoolToObject(battery, "power_present", snap.power_present);
        cJSON_AddBoolToObject(battery, "charging", snap.charging);
        cJSON_AddBoolToObject(battery, "full", snap.full);
        cJSON_AddBoolToObject(battery, "no_battery", snap.no_battery);
        if (have_battery) {
            cJSON_AddNumberToObject(battery, "voltage_mv", mv);
            cJSON_AddNumberToObject(battery, "level", pct);
        }
        cJSON_AddItemToObject(root, "battery", battery);
    }

    cJSON* network = cJSON_CreateObject();
    cJSON_AddStringToObject(network, "type", "wifi");
    cJSON_AddBoolToObject(network, "connected", Wifi::Get().IsConnected());
    if (Wifi::Get().IsConnected()) {
        cJSON_AddNumberToObject(network, "rssi", Wifi::Get().GetRssi());
        cJSON_AddStringToObject(network, "ip", Wifi::Get().GetIp().c_str());
    }
    cJSON_AddItemToObject(root, "network", network);

    const auto snap = ChatService::Get().Snapshot();
    cJSON*     chat = cJSON_CreateObject();
    cJSON_AddStringToObject(chat, "state", ChatStateName(snap.state).c_str());
    cJSON_AddStringToObject(chat, "status", snap.status.c_str());
    cJSON_AddBoolToObject(chat, "has_protocol", snap.has_protocol);
    cJSON_AddNumberToObject(chat, "volume", vol::ToCodec(snap.volume));
    cJSON_AddNumberToObject(chat, "level", snap.volume);
    if (!snap.user_text.empty())
        cJSON_AddStringToObject(chat, "user_text", snap.user_text.c_str());
    if (!snap.assistant_text.empty())
        cJSON_AddStringToObject(chat, "assistant_text", snap.assistant_text.c_str());
    if (!snap.error.empty())
        cJSON_AddStringToObject(chat, "error", snap.error.c_str());
    cJSON_AddItemToObject(root, "xiaozhi", chat);

    return PrintAndDelete(root);
}

std::string TextResultJson(const std::string& text) {
    cJSON* result  = cJSON_CreateObject();
    cJSON* content = cJSON_CreateArray();
    cJSON* item    = cJSON_CreateObject();
    cJSON_AddStringToObject(item, "type", "text");
    cJSON_AddStringToObject(item, "text", text.c_str());
    cJSON_AddItemToArray(content, item);
    cJSON_AddItemToObject(result, "content", content);
    cJSON_AddBoolToObject(result, "isError", false);
    return PrintAndDelete(result);
}

std::string ToolListResultJson() {
    cJSON* result = cJSON_CreateObject();
    cJSON* tools  = cJSON_CreateArray();

    cJSON* status_tool = cJSON_CreateObject();
    cJSON_AddStringToObject(status_tool, "name", "self.get_device_status");
    cJSON_AddStringToObject(
        status_tool, "description",
        "Provides the real-time information of the device, including the current status of the audio speaker, screen, "
        "battery, network, etc.\n"
        "Use this tool for: \n"
        "1. Answering questions about current condition (e.g. what is the current volume of the audio speaker?)\n"
        "2. As the first step to control the device (e.g. turn up / down the volume of the audio speaker, etc.)");
    cJSON_AddItemToObject(status_tool, "inputSchema", MakeObjectSchema());
    cJSON_AddItemToArray(tools, status_tool);

    cJSON* volume_tool = cJSON_CreateObject();
    cJSON_AddStringToObject(volume_tool, "name", "self.audio_speaker.set_volume");
    cJSON_AddStringToObject(volume_tool, "description",
                            "Set the volume of the audio speaker. If the current volume is unknown, you must call "
                            "`self.get_device_status` tool first and then call this tool.");
    cJSON* volume_schema = cJSON_CreateObject();
    cJSON_AddStringToObject(volume_schema, "type", "object");
    cJSON* properties  = cJSON_CreateObject();
    cJSON* volume_prop = cJSON_CreateObject();
    cJSON_AddStringToObject(volume_prop, "type", "integer");
    cJSON_AddNumberToObject(volume_prop, "minimum", 0);
    cJSON_AddNumberToObject(volume_prop, "maximum", 100);
    cJSON_AddItemToObject(properties, "volume", volume_prop);
    cJSON_AddItemToObject(volume_schema, "properties", properties);
    cJSON* required = cJSON_CreateArray();
    cJSON_AddItemToArray(required, cJSON_CreateString("volume"));
    cJSON_AddItemToObject(volume_schema, "required", required);
    cJSON_AddItemToObject(volume_tool, "inputSchema", volume_schema);
    cJSON_AddItemToArray(tools, volume_tool);

    cJSON_AddItemToObject(result, "tools", tools);
    return PrintAndDelete(result);
}

std::string JsonRpcResult(const std::string& id, const std::string& result) {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "jsonrpc", "2.0");
    cJSON* parsed_id = cJSON_Parse(id.c_str());
    if (parsed_id) {
        cJSON_AddItemToObject(root, "id", parsed_id);
    } else {
        cJSON_AddStringToObject(root, "id", id.c_str());
    }
    cJSON_AddRawToObject(root, "result", result.c_str());
    return PrintAndDelete(root);
}

std::string JsonRpcError(const std::string& id, int code, const std::string& message) {
    cJSON* root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "jsonrpc", "2.0");
    cJSON* parsed_id = cJSON_Parse(id.c_str());
    if (parsed_id) {
        cJSON_AddItemToObject(root, "id", parsed_id);
    } else {
        cJSON_AddStringToObject(root, "id", id.c_str());
    }
    cJSON* error = cJSON_CreateObject();
    cJSON_AddNumberToObject(error, "code", code);
    cJSON_AddStringToObject(error, "message", message.c_str());
    cJSON_AddItemToObject(root, "error", error);
    return PrintAndDelete(root);
}

}  // namespace xiaozhi::mcp
