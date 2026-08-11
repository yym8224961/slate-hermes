import asyncio
import base64
import importlib.util
import sys
import tempfile
import types
import wave
from dataclasses import dataclass, field
from pathlib import Path


def _load_adapter_module():
    gateway = types.ModuleType("gateway")
    gateway_config = types.ModuleType("gateway.config")
    gateway_platforms = types.ModuleType("gateway.platforms")
    gateway_base = types.ModuleType("gateway.platforms.base")

    class Platform:
        def __init__(self, value):
            self.value = value

    @dataclass
    class PlatformConfig:
        extra: dict = field(default_factory=dict)

    class MessageType:
        TEXT = "text"
        VOICE = "voice"

    @dataclass
    class MessageEvent:
        text: str
        message_type: str
        source: object
        message_id: str
        raw_message: dict
        timestamp: object
        media_urls: list[str] = field(default_factory=list)
        media_types: list[str] = field(default_factory=list)

    class SendResult:
        def __init__(self, success, error=None, message_id=None, retryable=False):
            self.success = success
            self.error = error
            self.message_id = message_id
            self.retryable = retryable

    class BasePlatformAdapter:
        def __init__(self, config, platform):
            self.config = config
            self.platform = platform
            self._running = True

        def _mark_connected(self):
            pass

        def _mark_disconnected(self):
            pass

        def build_source(self, **kwargs):
            return kwargs

        def _set_fatal_error(self, *args, **kwargs):
            pass

    def cache_audio_from_bytes(data, ext=".wav"):
        fd, path = tempfile.mkstemp(suffix=ext)
        with open(fd, "wb", closefd=True) as handle:
            handle.write(data)
        return path

    gateway_config.Platform = Platform
    gateway_config.PlatformConfig = PlatformConfig
    gateway_base.BasePlatformAdapter = BasePlatformAdapter
    gateway_base.MessageEvent = MessageEvent
    gateway_base.MessageType = MessageType
    gateway_base.SendResult = SendResult
    gateway_base.cache_audio_from_bytes = cache_audio_from_bytes

    sys.modules.update(
        {
            "gateway": gateway,
            "gateway.config": gateway_config,
            "gateway.platforms": gateway_platforms,
            "gateway.platforms.base": gateway_base,
        }
    )

    module_path = Path(__file__).with_name("adapter.py")
    spec = importlib.util.spec_from_file_location("slate_adapter_under_test", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module, PlatformConfig, MessageType


def test_dispatches_pcm_audio_as_a_voice_event():
    adapter_module, platform_config, message_type = _load_adapter_module()
    adapter = adapter_module.SlateAdapter(platform_config())
    captured = []

    async def capture(event):
        captured.append(event)

    adapter.handle_message = capture
    pcm = b"\x01\x02\x03\x04"

    asyncio.run(
        adapter._dispatch(
            {
                "requestId": "hermes-voice-1",
                "text": "",
                "audio": base64.b64encode(pcm).decode("ascii"),
            }
        )
    )

    assert len(captured) == 1
    event = captured[0]
    assert event.message_type == message_type.VOICE
    assert event.text == ""
    assert len(event.media_urls) == 1
    with wave.open(event.media_urls[0], "rb") as wav:
        assert wav.getframerate() == 16000
        assert wav.getnchannels() == 1
        assert wav.getsampwidth() == 2
        assert wav.readframes(wav.getnframes()) == pcm


if __name__ == "__main__":
    test_dispatches_pcm_audio_as_a_voice_event()
