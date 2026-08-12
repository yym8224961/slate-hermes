import asyncio
import base64
import importlib.util
import os
import shlex
import sys
import tempfile
import time
import types
import unittest
import wave
from dataclasses import dataclass, field
from pathlib import Path


def _load_adapter_module():
    gateway = types.ModuleType("gateway")
    gateway_config = types.ModuleType("gateway.config")
    gateway_platforms = types.ModuleType("gateway.platforms")
    gateway_base = types.ModuleType("gateway.platforms.base")
    tools_module = types.ModuleType("tools")
    transcription_tools = types.ModuleType("tools.transcription_tools")
    tools_environments = types.ModuleType("tools.environments")
    tools_environments_local = types.ModuleType("tools.environments.local")
    agent_module = types.ModuleType("agent")
    delegation_context = types.ModuleType("agent.delegation_context")

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
            self._running = False
            self.connected = False

        def _mark_connected(self):
            self.connected = True

        def _mark_disconnected(self):
            self.connected = False
            self._running = False

        def build_source(self, **kwargs):
            return kwargs

        def _set_fatal_error(self, *args, **kwargs):
            self._running = False

    def cache_audio_from_bytes(data, ext=".wav"):
        fd, path = tempfile.mkstemp(suffix=ext)
        with open(fd, "wb", closefd=True) as handle:
            handle.write(data)
        return path

    transcription_state = {
        "result": {"success": True, "transcript": "请打开今天的天气", "provider": "test"},
        "calls": 0,
        "language": None,
        "timeout": None,
    }

    def load_stt_config():
        return {
            "provider": "sensevoice",
            "providers": {
                "sensevoice": {
                    "type": "command",
                    "command": "sensevoice {input_path}",
                    "language": "en",
                    "timeout": 300,
                }
            },
        }

    def get_provider(stt_config):
        return stt_config["provider"]

    def resolve_command(provider, stt_config):
        return stt_config["providers"].get(provider)

    transcription_tools._load_stt_config = load_stt_config
    transcription_tools._get_provider = get_provider
    transcription_tools._resolve_command_stt_provider_config = resolve_command

    def render_command(_template, placeholders):
        transcription_state["language"] = placeholders["language"]
        return "mock-sensevoice"

    def get_output_format(_config):
        return "txt"

    def get_env_passthrough(_config):
        return []

    def read_output(_path, stdout, _format):
        if stdout:
            return stdout
        raise RuntimeError("no transcript")

    transcription_tools._render_command_stt_template = render_command
    transcription_tools._get_command_stt_output_format = get_output_format
    transcription_tools._command_stt_env_passthrough = get_env_passthrough
    transcription_tools._read_command_stt_output = read_output
    tools_environments_local.hermes_subprocess_env = lambda **_kwargs: {}
    delegation_context.delegated_child_subprocess_env = lambda env: env
    tools_module.transcription_tools = transcription_tools

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
            "tools": tools_module,
            "tools.transcription_tools": transcription_tools,
            "tools.environments": tools_environments,
            "tools.environments.local": tools_environments_local,
            "agent": agent_module,
            "agent.delegation_context": delegation_context,
        }
    )

    module_path = Path(__file__).with_name("adapter.py")
    spec = importlib.util.spec_from_file_location("slate_adapter_under_test", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    module._real_run_stt_process = module._run_stt_process

    async def fake_run_stt_process(_command, _env, timeout):
        transcription_state["calls"] += 1
        transcription_state["timeout"] = timeout
        result = transcription_state["result"]
        if result.get("success"):
            return str(result.get("transcript") or ""), "", 0, False
        return "", str(result.get("error") or "STT failed"), 1, False

    module._run_stt_process = fake_run_stt_process
    module._test_transcription_state = transcription_state
    return module, PlatformConfig, MessageType


class Response:
    def __init__(self, data=None):
        self._data = {"ok": True} if data is None else data

    def raise_for_status(self):
        return None

    def json(self):
        return self._data


class Client:
    def __init__(self, response=None):
        self.payloads = []
        self.response = response or Response()
        self.closed = False

    async def post(self, url, *, json, timeout):
        del url, timeout
        self.payloads.append(json)
        return self.response

    async def aclose(self):
        self.closed = True


class SlateAdapterVoiceTests(unittest.TestCase):
    def setUp(self):
        self.adapter_module, self.platform_config, self.message_type = _load_adapter_module()

    def test_dispatch_pretranscribes_once_in_chinese_and_uses_device_session(self):
        adapter = self.adapter_module.SlateAdapter(self.platform_config())
        captured = []

        async def capture(event):
            captured.append(event)

        adapter.handle_message = capture
        pcm = b"\x01\x02\x03\x04"
        asyncio.run(
            adapter._dispatch(
                {
                    "requestId": "hermes-voice-1",
                    "sessionId": "slate:device-1",
                    "userId": "admin-1",
                    "text": "",
                    "audio": base64.b64encode(pcm).decode("ascii"),
                }
            )
        )

        self.assertEqual(len(captured), 1)
        event = captured[0]
        self.assertEqual(event.message_type, self.message_type.VOICE)
        self.assertEqual(event.text, "请打开今天的天气")
        self.assertEqual(event.raw_message["userText"], "请打开今天的天气")
        self.assertEqual(event.source["chat_id"], "slate:device-1")
        self.assertEqual(event.source["user_id"], "admin-1")
        self.assertEqual(event._gateway_pending_stt_text, "请打开今天的天气")
        self.assertEqual(event._gateway_pending_stt_transcripts, ["请打开今天的天气"])
        self.assertEqual(self.adapter_module._test_transcription_state["calls"], 1)
        self.assertEqual(self.adapter_module._test_transcription_state["language"], "zh")
        self.assertEqual(self.adapter_module._test_transcription_state["timeout"], 25.0)
        with wave.open(event.media_urls[0], "rb") as wav:
            self.assertEqual(wav.getframerate(), 16000)
            self.assertEqual(wav.getnchannels(), 1)
            self.assertEqual(wav.getsampwidth(), 2)
            self.assertEqual(wav.readframes(wav.getnframes()), pcm)

    def test_punctuation_only_pretranscript_is_not_cached_as_user_text(self):
        adapter = self.adapter_module.SlateAdapter(self.platform_config())
        captured = []
        client = Client()
        adapter._client = client
        self.adapter_module._test_transcription_state["result"] = {
            "success": True,
            "transcript": "？？",
            "provider": "test",
        }

        async def capture(event):
            captured.append(event)

        adapter.handle_message = capture
        asyncio.run(
            adapter._dispatch(
                {
                    "requestId": "hermes-punctuation-only",
                    "sessionId": "slate:device-1",
                    "userId": "admin-1",
                    "text": "",
                    "audio": base64.b64encode(b"\x01\x02").decode("ascii"),
                }
            )
        )

        self.assertEqual(captured, [])
        self.assertEqual(
            client.payloads,
            [
                {
                    "requestId": "hermes-punctuation-only",
                    "text": "这段语音没有识别清楚，请再说一次。",
                }
            ],
        )
        self.assertEqual(adapter._event_transcript("hermes-punctuation-only"), "")

    def test_punctuation_only_gateway_echo_is_not_user_text(self):
        self.assertEqual(self.adapter_module._stt_echo_transcript('🎙️ "？？"'), "")

    def test_stt_process_timeout_is_total_and_kills_child_process_group(self):
        if os.name == "nt":
            self.skipTest("POSIX process-group behavior")
        with tempfile.TemporaryDirectory() as tmpdir:
            marker = Path(tmpdir) / "orphan-child-ran"
            child_code = (
                "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                "time.sleep(1.0); "
                f"open({str(marker)!r}, 'w').write('alive')"
            )
            parent_code = (
                "import subprocess, sys, time; "
                f"subprocess.Popen([sys.executable, '-c', {child_code!r}]); "
                "\nwhile True: print('progress', flush=True); time.sleep(0.01)"
            )
            command = (
                f"{shlex.quote(sys.executable)} -c {shlex.quote(parent_code)}"
            )
            _stdout, _stderr, _returncode, timed_out = asyncio.run(
                self.adapter_module._real_run_stt_process(
                    command, os.environ.copy(), 0.08
                )
            )
            time.sleep(1.1)

            self.assertTrue(timed_out)
            self.assertFalse(marker.exists())

    def test_stt_process_cancellation_kills_child_process_group(self):
        if os.name == "nt":
            self.skipTest("POSIX process-group behavior")
        with tempfile.TemporaryDirectory() as tmpdir:
            marker = Path(tmpdir) / "cancelled-child-ran"
            child_code = (
                "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                "time.sleep(1.0); "
                f"open({str(marker)!r}, 'w').write('alive')"
            )
            parent_code = (
                "import subprocess, sys, time; "
                f"subprocess.Popen([sys.executable, '-c', {child_code!r}]); "
                "time.sleep(10)"
            )
            command = (
                f"{shlex.quote(sys.executable)} -c {shlex.quote(parent_code)}"
            )

            async def exercise():
                task = asyncio.create_task(
                    self.adapter_module._real_run_stt_process(
                        command, os.environ.copy(), 10
                    )
                )
                await asyncio.sleep(0.08)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task

            asyncio.run(exercise())
            time.sleep(1.1)

            self.assertFalse(marker.exists())

    def test_connect_starts_the_first_poll_before_reporting_connected(self):
        adapter = self.adapter_module.SlateAdapter(
            self.platform_config(
                extra={"backend": "https://slate.example.com", "token": "t" * 64}
            )
        )
        polls = []

        class HttpClient(Client):
            pass

        async def get_pending():
            polls.append(True)
            adapter._polling = False
            return None

        self.adapter_module.HTTPX_AVAILABLE = True
        self.adapter_module.httpx = types.SimpleNamespace(
            AsyncClient=lambda **_kwargs: HttpClient(),
            Timeout=lambda **kwargs: kwargs,
            HTTPStatusError=type("HTTPStatusError", (Exception,), {}),
            HTTPError=type("HTTPError", (Exception,), {}),
        )
        adapter._get_pending = get_pending

        async def exercise():
            self.assertTrue(await adapter.connect())
            self.assertFalse(adapter.connected)
            await adapter._poll_task

        asyncio.run(exercise())

        self.assertEqual(polls, [True])
        self.assertTrue(adapter.connected)

    def test_final_send_returns_gateway_transcript_with_agent_reply(self):
        adapter = self.adapter_module.SlateAdapter(self.platform_config())
        captured = []

        async def capture(event):
            captured.append(event)

        adapter.handle_message = capture
        asyncio.run(
            adapter._dispatch(
                {
                    "requestId": "hermes-voice-2",
                    "sessionId": "slate:device-1",
                    "userId": "admin-1",
                    "text": "",
                    "audio": base64.b64encode(b"\x01\x02").decode("ascii"),
                }
            )
        )
        setattr(captured[0], "_gateway_pending_stt_transcripts", ["请打开今天的天气"])
        client = Client()
        adapter._client = client

        result = asyncio.run(
            adapter.send(
                "slate:device-1",
                "今天晴天",
                reply_to="hermes-voice-2",
                metadata={"notify": True},
            )
        )

        self.assertTrue(result.success)
        self.assertEqual(
            client.payloads,
            [
                {
                    "requestId": "hermes-voice-2",
                    "text": "今天晴天",
                    "userText": "请打开今天的天气",
                }
            ],
        )
        self.assertNotIn("hermes-voice-2", adapter._events)

    def test_stt_echo_is_cached_for_final_send_without_consuming_request(self):
        adapter = self.adapter_module.SlateAdapter(self.platform_config())
        # Simulate an older Gateway without the bounded named-command API. Its
        # normal voice pipeline remains the compatibility fallback.
        for name in (
            "_load_stt_config",
            "_get_provider",
            "_resolve_command_stt_provider_config",
        ):
            delattr(sys.modules["tools.transcription_tools"], name)
        self.adapter_module._test_transcription_state["result"] = {
            "success": False,
            "error": "primary STT unavailable",
        }

        async def capture(_event):
            return None

        adapter.handle_message = capture
        asyncio.run(
            adapter._dispatch(
                {
                    "requestId": "hermes-voice-echo",
                    "sessionId": "slate:device-1",
                    "userId": "admin-1",
                    "text": "",
                    "audio": base64.b64encode(b"\x01\x02").decode("ascii"),
                }
            )
        )
        client = Client()
        adapter._client = client

        echo_result = asyncio.run(
            adapter.send(
                "slate:device-1",
                '🎙️ "赫妹你好，今天是几号"',
                metadata=None,
            )
        )
        final_result = asyncio.run(
            adapter.send(
                "slate:device-1",
                "今天是八月十二日。",
                reply_to="hermes-voice-echo",
                metadata={"notify": True},
            )
        )

        self.assertTrue(echo_result.success)
        self.assertTrue(final_result.success)
        self.assertEqual(
            client.payloads,
            [
                {
                    "requestId": "hermes-voice-echo",
                    "text": "今天是八月十二日。",
                    "userText": "赫妹你好，今天是几号",
                }
            ],
        )

    def test_streaming_preview_does_not_consume_the_pending_request(self):
        adapter = self.adapter_module.SlateAdapter(self.platform_config())
        client = Client()
        adapter._client = client
        adapter._events["request-1"] = object()

        result = asyncio.run(
            adapter.send(
                "slate:device-1",
                "partial preview",
                reply_to="request-1",
                metadata={"notify": True, "expect_edits": True},
            )
        )

        self.assertTrue(result.success)
        self.assertEqual(client.payloads, [])
        self.assertIn("request-1", adapter._events)

    def test_terminal_not_pending_response_clears_voice_context(self):
        adapter = self.adapter_module.SlateAdapter(self.platform_config())
        adapter._client = Client(Response({"ok": False}))
        adapter._events["request-1"] = object()

        result = asyncio.run(
            adapter.send("slate", "reply", reply_to="request-1", metadata={"notify": True})
        )

        self.assertFalse(result.success)
        self.assertNotIn("request-1", adapter._events)

    def test_env_enablement_preserves_configured_poll_timeout(self):
        previous = {
            name: os.environ.get(name)
            for name in ("SLATE_BACKEND", "SLATE_AGENT_TOKEN", "SLATE_POLL_TIMEOUT_SECONDS")
        }
        os.environ["SLATE_BACKEND"] = "https://slate.example.com"
        os.environ["SLATE_AGENT_TOKEN"] = "t" * 64
        os.environ["SLATE_POLL_TIMEOUT_SECONDS"] = "47"
        try:
            self.assertEqual(self.adapter_module._env_enablement()["poll_timeout"], 47)
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def test_successful_empty_poll_does_not_add_an_extra_sleep(self):
        adapter = self.adapter_module.SlateAdapter(self.platform_config())
        adapter._running = True
        adapter._polling = True
        sleeps = []

        async def get_pending():
            adapter._polling = False
            return None

        async def sleep(delay):
            sleeps.append(delay)

        adapter._get_pending = get_pending
        original_sleep = self.adapter_module.asyncio.sleep
        self.adapter_module.asyncio.sleep = sleep
        try:
            asyncio.run(adapter._poll_loop())
        finally:
            self.adapter_module.asyncio.sleep = original_sleep

        self.assertEqual(sleeps, [])

    def test_repeated_dispatch_failures_use_increasing_backoff(self):
        adapter = self.adapter_module.SlateAdapter(self.platform_config())
        adapter._running = True
        adapter._polling = True
        sleeps = []
        dispatch_attempts = 0
        self.adapter_module.httpx = types.SimpleNamespace(
            HTTPStatusError=type("HTTPStatusError", (Exception,), {}),
            HTTPError=type("HTTPError", (Exception,), {}),
        )

        async def get_pending():
            return {"requestId": "request-1", "text": "hello"}

        async def dispatch(_request):
            nonlocal dispatch_attempts
            dispatch_attempts += 1
            if dispatch_attempts < 3:
                raise ValueError("dispatch failed")
            adapter._polling = False

        async def sleep(delay):
            sleeps.append(delay)

        adapter._get_pending = get_pending
        adapter._dispatch = dispatch
        original_sleep = self.adapter_module.asyncio.sleep
        self.adapter_module.asyncio.sleep = sleep
        try:
            asyncio.run(adapter._poll_loop())
        finally:
            self.adapter_module.asyncio.sleep = original_sleep

        self.assertEqual(sleeps, [1, 2])

    def test_disconnect_drops_cached_voice_context(self):
        adapter = self.adapter_module.SlateAdapter(self.platform_config())
        client = Client()
        adapter._client = client
        adapter._events["request-1"] = object()

        asyncio.run(adapter.disconnect())

        self.assertEqual(adapter._events, {})
        self.assertTrue(client.closed)


if __name__ == "__main__":
    unittest.main()
