"""Hermes Gateway platform adapter for Slate ink-screen devices."""

import asyncio
import base64
import binascii
import io
import logging
import os
import signal
import subprocess
import tempfile
import time
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

try:
    import httpx

    HTTPX_AVAILABLE = True
except ImportError:
    HTTPX_AVAILABLE = False
    httpx = None  # type: ignore[assignment]

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, MessageEvent, MessageType, SendResult

try:
    from gateway.platforms.base import cache_audio_from_bytes
except ImportError:
    cache_audio_from_bytes = None


logger = logging.getLogger(__name__)
MAX_MESSAGE_LENGTH = 512
RECONNECT_BACKOFF_SECONDS = (1, 2, 5, 10, 30)
EVENT_CONTEXT_TTL_SECONDS = 10 * 60
STT_ECHO_PREFIX = '🎙️ "'
SLATE_STT_TIMEOUT_SECONDS = 25


def _pcm16_base64_to_wav(audio_base64: str) -> bytes:
    try:
        pcm = base64.b64decode(audio_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("invalid base64 audio payload") from exc
    if not pcm or len(pcm) % 2:
        raise ValueError("audio payload is not non-empty PCM16")

    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(pcm)
    return output.getvalue()


def _stt_echo_transcript(content: str) -> str:
    """Extract the raw transcript from Hermes' user-visible STT echo."""
    stripped = content.strip()
    if not stripped.startswith(STT_ECHO_PREFIX) or not stripped.endswith('"'):
        return ""
    return _clean_transcript(stripped[len(STT_ECHO_PREFIX) : -1])


def _clean_transcript(value: Any) -> str:
    """Return a displayable speech transcript, rejecting punctuation-only noise."""
    if not isinstance(value, str):
        return ""
    transcript = value.strip()[:512]
    return transcript if transcript and any(char.isalnum() for char in transcript) else ""


def _stt_language() -> str:
    value = os.getenv("SLATE_STT_LANGUAGE", "zh").strip()
    return "" if value.lower() == "auto" else value


async def _terminate_stt_process(proc: asyncio.subprocess.Process) -> None:
    if os.name == "nt":
        if proc.returncode is not None:
            return
        try:
            proc.terminate()
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(proc.wait(), timeout=2)
            return
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return

    process_group = proc.pid
    try:
        os.killpg(process_group, signal.SIGTERM)
    except ProcessLookupError:
        return

    # The shell can exit before descendants that ignore SIGTERM. Wait for the
    # process *group*, not only the shell parent, then kill every survivor.
    deadline = time.monotonic() + 0.5
    while time.monotonic() < deadline:
        try:
            os.killpg(process_group, 0)
        except ProcessLookupError:
            break
        await asyncio.sleep(0.05)
    try:
        os.killpg(process_group, 0)
    except ProcessLookupError:
        pass
    else:
        try:
            os.killpg(process_group, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if proc.returncode is None:
        await proc.wait()


async def _run_stt_process(
    command: str, env: Dict[str, str], timeout: float
) -> tuple[str, str, int, bool]:
    """Run one command with a hard wall-clock timeout and process-group cleanup."""
    process_options: Dict[str, Any] = {}
    if os.name == "nt":
        process_options["creationflags"] = getattr(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0
        )
    else:
        process_options["start_new_session"] = True
    proc = await asyncio.create_subprocess_shell(
        command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.DEVNULL,
        env=env,
        **process_options,
    )
    communicate_task = asyncio.create_task(proc.communicate())
    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            asyncio.shield(communicate_task), timeout=timeout
        )
        return (
            stdout_bytes.decode("utf-8", errors="replace"),
            stderr_bytes.decode("utf-8", errors="replace"),
            int(proc.returncode or 0),
            False,
        )
    except asyncio.TimeoutError:
        await _terminate_stt_process(proc)
        stdout_bytes, stderr_bytes = await communicate_task
        return (
            stdout_bytes.decode("utf-8", errors="replace"),
            stderr_bytes.decode("utf-8", errors="replace"),
            int(proc.returncode or -1),
            True,
        )
    except asyncio.CancelledError:
        await asyncio.shield(_terminate_stt_process(proc))
        await communicate_task
        raise


async def _run_bounded_command_stt(
    transcription_tools: Any,
    path: str,
    provider: str,
    command_config: Dict[str, Any],
    stt_config: Dict[str, Any],
    language_override: str,
) -> Dict[str, Any]:
    """Run Hermes' configured command provider with a hard total timeout."""
    try:
        from agent.delegation_context import delegated_child_subprocess_env
        from tools.environments.local import hermes_subprocess_env

        render_command = transcription_tools._render_command_stt_template
        get_output_format = transcription_tools._get_command_stt_output_format
        get_env_passthrough = transcription_tools._command_stt_env_passthrough
        read_output = transcription_tools._read_command_stt_output
    except (AttributeError, ImportError):
        return {"success": False, "transcript": "", "compatible": False}

    output_format = get_output_format(command_config)
    provider_language = command_config.get("language")
    if not provider_language:
        resolve_language = getattr(transcription_tools, "_resolve_stt_language", None)
        if callable(resolve_language):
            provider_language = resolve_language(provider, stt_config)
    language = language_override or provider_language or "en"
    model = command_config.get("model") or ""

    with tempfile.TemporaryDirectory(prefix=f"slate-stt-{provider}-") as tmpdir:
        output_path = Path(tmpdir) / f"transcript.{output_format}"
        placeholders = {
            "input_path": str(Path(path).resolve()),
            "output_path": str(output_path),
            "output_dir": str(output_path.parent),
            "format": output_format,
            "language": str(language),
            "model": str(model),
        }
        command = render_command(str(command_config.get("command") or ""), placeholders)
        child_env = hermes_subprocess_env(inherit_credentials=False)
        for key in get_env_passthrough(command_config):
            value = os.environ.get(key)
            if value is not None:
                child_env[key] = value
        child_env = delegated_child_subprocess_env(child_env)
        stdout, stderr, returncode, timed_out = await _run_stt_process(
            command, child_env, float(SLATE_STT_TIMEOUT_SECONDS)
        )
        if timed_out:
            return {
                "success": False,
                "transcript": "",
                "provider": provider,
                "error": f"STT command exceeded {SLATE_STT_TIMEOUT_SECONDS}s total timeout",
            }
        if returncode:
            detail = stderr.strip() or stdout.strip() or "no command output"
            return {
                "success": False,
                "transcript": "",
                "provider": provider,
                "error": f"STT command exited with code {returncode}: {detail}",
            }
        try:
            transcript = read_output(output_path, stdout, output_format)
        except RuntimeError as exc:
            return {
                "success": False,
                "transcript": "",
                "provider": provider,
                "error": str(exc),
            }
        return {"success": True, "transcript": transcript, "provider": provider}


async def _transcribe_cached_audio(path: str) -> tuple[str, bool]:
    """Return ``(transcript, definitive)`` from a compatible command STT."""
    try:
        from tools import transcription_tools
    except ImportError:
        logger.warning("[slate] Hermes STT module is unavailable")
        return "", False

    helpers = (
        getattr(transcription_tools, "_load_stt_config", None),
        getattr(transcription_tools, "_get_provider", None),
        getattr(transcription_tools, "_resolve_command_stt_provider_config", None),
    )
    if not all(callable(helper) for helper in helpers):
        return "", False
    load_config, get_provider, resolve_command = helpers
    try:
        stt_config = load_config()
        provider = get_provider(stt_config)
        command_config = resolve_command(provider, stt_config)
        if not isinstance(command_config, dict):
            return "", False
        result = await _run_bounded_command_stt(
            transcription_tools,
            path,
            provider,
            command_config,
            stt_config,
            _stt_language(),
        )
    except Exception as exc:
        logger.warning("[slate] STT failed for %s: %s", path, exc)
        return "", False

    if not isinstance(result, dict) or not result.get("success"):
        if isinstance(result, dict) and result.get("compatible") is False:
            return "", False
        if isinstance(result, dict):
            logger.info(
                "[slate] STT did not produce a transcript: %s",
                result.get("error", "unknown error"),
            )
        return "", True
    return _clean_transcript(result.get("transcript")), True


def _settings(config: PlatformConfig) -> tuple[str, str, int]:
    extra = config.extra or {}
    backend = str(extra.get("backend") or os.getenv("SLATE_BACKEND", "")).strip().rstrip("/")
    token = str(extra.get("token") or os.getenv("SLATE_AGENT_TOKEN", "")).strip()
    raw_timeout = extra.get("poll_timeout") or os.getenv("SLATE_POLL_TIMEOUT_SECONDS", "30")
    try:
        timeout = int(raw_timeout)
    except (TypeError, ValueError):
        timeout = 30
    return backend, token, min(max(timeout, 1), 60)


def check_requirements() -> bool:
    return HTTPX_AVAILABLE and bool(os.getenv("SLATE_BACKEND", "").strip()) and bool(
        os.getenv("SLATE_AGENT_TOKEN", "").strip()
    )


def validate_config(config: PlatformConfig) -> bool:
    backend, token, _ = _settings(config)
    return backend.startswith(("http://", "https://")) and bool(token)


def is_connected(config: PlatformConfig) -> bool:
    return validate_config(config)


class SlateAdapter(BasePlatformAdapter):
    """Bridge Slate's request/response queue into a Hermes conversation."""

    MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH
    supports_async_delivery = False
    interactive_resume = False

    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform("slate"))
        self._backend, self._token, self._poll_timeout = _settings(config)
        self._client: Optional["httpx.AsyncClient"] = None
        self._poll_task: Optional[asyncio.Task] = None
        self._polling = False
        self._events: Dict[str, MessageEvent] = {}
        self._event_created_at: Dict[str, float] = {}
        self._request_ids_by_chat: Dict[str, str] = {}

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if not HTTPX_AVAILABLE:
            logger.error("[slate] httpx is not installed")
            return False
        if not validate_config(self.config):
            logger.error("[slate] SLATE_BACKEND or SLATE_AGENT_TOKEN is invalid")
            return False

        self._client = httpx.AsyncClient(
            headers={"Authorization": f"Bearer {self._token}"},
            timeout=httpx.Timeout(connect=15, read=self._poll_timeout + 10, write=15, pool=15),
        )
        self._polling = True
        self._poll_task = asyncio.create_task(self._poll_loop())
        logger.info("[slate] Polling %s", self._backend)
        return True

    async def disconnect(self) -> None:
        self._polling = False
        self._mark_disconnected()
        if self._poll_task:
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
            self._poll_task = None
        if self._client:
            await self._client.aclose()
            self._client = None
        self._events.clear()
        self._event_created_at.clear()
        self._request_ids_by_chat.clear()
        logger.info("[slate] Disconnected")

    async def _poll_loop(self) -> None:
        backoff_index = 0
        while self._polling:
            try:
                request = await self._get_pending()
                self._mark_connected()
                if request:
                    await self._dispatch(request)
                backoff_index = 0
                continue
            except asyncio.CancelledError:
                return
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                if status in (401, 403):
                    message = "Slate backend rejected SLATE_AGENT_TOKEN"
                    logger.error("[slate] %s", message)
                    self._polling = False
                    self._set_fatal_error("slate_unauthorized", message, retryable=False)
                    return
                logger.warning("[slate] Poll failed with HTTP %d", status)
            except (httpx.HTTPError, ValueError) as exc:
                logger.warning("[slate] Poll failed: %s", exc)
            except Exception:
                logger.exception("[slate] Unexpected poll failure")

            if not self._polling:
                return
            delay = RECONNECT_BACKOFF_SECONDS[
                min(backoff_index, len(RECONNECT_BACKOFF_SECONDS) - 1)
            ]
            backoff_index += 1
            await asyncio.sleep(delay)

    async def _get_pending(self) -> Optional[Dict[str, Any]]:
        if not self._client:
            return None
        response = await self._client.get(
            f"{self._backend}/api/v1/hermes/agent/pending",
            params={"timeout": str(self._poll_timeout * 1000)},
        )
        response.raise_for_status()
        if not response.content:
            return None
        data = response.json()
        if data is None:
            return None
        if not isinstance(data, dict) or not data.get("requestId"):
            raise ValueError("invalid pending-request response")
        text = data.get("text")
        audio = data.get("audio")
        if not (isinstance(text, str) and text.strip()) and not (
            isinstance(audio, str) and audio.strip()
        ):
            raise ValueError("pending request has neither text nor audio")
        return data

    async def _dispatch(self, request: Dict[str, Any]) -> None:
        self._prune_event_contexts()
        request_id = str(request["requestId"])
        text = str(request.get("text") or "").strip()
        message_type = MessageType.TEXT
        media_urls = []
        media_types = []

        audio_base64 = request.get("audio")
        if isinstance(audio_base64, str) and audio_base64.strip():
            voice_type = getattr(MessageType, "VOICE", None)
            if voice_type is None or cache_audio_from_bytes is None:
                logger.error("[slate] Hermes runtime cannot accept voice media")
                result = await self.send(
                    "slate", "语音暂时无法识别，请再说一次。", reply_to=request_id
                )
                if not result.success:
                    logger.warning("[slate] Failed to return voice compatibility error: %s", result.error)
                return
            try:
                wav_bytes = _pcm16_base64_to_wav(audio_base64)
                cached_path = await asyncio.to_thread(
                    cache_audio_from_bytes, wav_bytes, ext=".wav"
                )
            except (ValueError, OSError) as exc:
                logger.warning("[slate] Invalid voice payload %s: %s", request_id, exc)
                result = await self.send(
                    "slate", "语音暂时无法识别，请再说一次。", reply_to=request_id
                )
                if not result.success:
                    logger.warning("[slate] Failed to return invalid voice error: %s", result.error)
                return
            message_type = voice_type
            media_urls = [cached_path]
            media_types = ["audio/wav"]

            # Pre-transcribe exactly once with Slate's Chinese language hint.
            # The private cache attributes are the Gateway's existing signal
            # that the normal inbound pipeline must reuse this text instead of
            # running STT a second time. A definitive but unusable result is
            # returned as a retry prompt instead of asking the agent to answer
            # invented text. Older runtimes without the bounded command API
            # retain their normal Gateway fallback path.
            transcript, stt_definitive = await _transcribe_cached_audio(cached_path)
            if transcript:
                text = transcript
                request["userText"] = transcript
            elif stt_definitive:
                logger.info(
                    "[slate] Rejecting unrecognized voice request %s",
                    request_id,
                )
                result = await self.send(
                    "slate",
                    "这段语音没有识别清楚，请再说一次。",
                    reply_to=request_id,
                )
                if not result.success:
                    logger.warning(
                        "[slate] Failed to return STT error: %s", result.error
                    )
                return

        session_id = str(request.get("sessionId") or f"slate:{request_id}")[:128]
        user_id = str(request.get("userId") or "slate-owner")[:128]
        source = self.build_source(
            chat_id=session_id,
            chat_name="Slate ink screen",
            chat_type="dm",
            user_id=user_id,
            user_name="Slate owner",
        )
        event = MessageEvent(
            text=text,
            message_type=message_type,
            source=source,
            message_id=request_id,
            raw_message=request,
            timestamp=datetime.now(tz=timezone.utc),
            media_urls=media_urls,
            media_types=media_types,
        )
        self._events[request_id] = event
        self._event_created_at[request_id] = time.monotonic()
        self._request_ids_by_chat[session_id] = request_id
        if request.get("userText"):
            setattr(event, "_gateway_pending_stt_text", text)
            setattr(event, "_gateway_pending_stt_transcripts", [text])
        logger.info("[slate] Dispatching request %s", request_id)
        await self.handle_message(event)

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        if not self._client:
            return SendResult(success=False, error="Slate HTTP client is not connected")
        # Older Hermes Gateway releases expose the successful STT result only
        # through their standard transcript echo. Cache that echo against the
        # active Slate request, but never post it as the one-shot final reply.
        # Newer releases also retain private event transcript attributes; the
        # final path below supports both shapes without running STT twice.
        transcript_echo = _stt_echo_transcript(content)
        active_request_id = self._request_ids_by_chat.get(chat_id)
        if not reply_to and transcript_echo and active_request_id:
            event = self._events.get(active_request_id)
            if event is not None and event.message_type == MessageType.VOICE:
                setattr(event, "_slate_stt_echo_text", transcript_echo)
                return SendResult(success=True, message_id=active_request_id)
        # Gateway previews, edits, typing/busy acknowledgements and transcript
        # echoes must not resolve the one-shot Slate request. Current Gateway
        # final delivery is explicitly marked notify=True; metadata=None keeps
        # compatibility with older final-only Gateway versions.
        if metadata is not None and (
            metadata.get("notify") is not True or metadata.get("expect_edits") is True
        ):
            return SendResult(success=True, message_id=reply_to)
        if not reply_to:
            return SendResult(success=False, error="Slate response has no request id")

        self._prune_event_contexts()
        text = content.strip()[: self.MAX_MESSAGE_LENGTH]
        if not text:
            text = "我暂时没有生成可显示的回复。"
        payload = {"requestId": reply_to, "text": text}
        transcript = self._event_transcript(reply_to)
        if transcript:
            payload["userText"] = transcript
        try:
            response = await self._client.post(
                f"{self._backend}/api/v1/hermes/agent/response",
                json=payload,
                timeout=15,
            )
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict) or not data.get("ok"):
                self._drop_event_context(reply_to)
                return SendResult(success=False, error="Slate request is no longer pending")
            self._drop_event_context(reply_to)
            return SendResult(success=True, message_id=reply_to)
        except httpx.TimeoutException:
            return SendResult(success=False, error="Timeout returning response to Slate")
        except httpx.HTTPStatusError as exc:
            if 400 <= exc.response.status_code < 500:
                self._drop_event_context(reply_to)
            return SendResult(
                success=False,
                error=str(exc),
                retryable=exc.response.status_code >= 500,
            )
        except httpx.HTTPError as exc:
            return SendResult(success=False, error=str(exc), retryable=True)
        except (TypeError, ValueError) as exc:
            return SendResult(success=False, error=str(exc), retryable=True)

    def _event_transcript(self, request_id: str) -> str:
        event = self._events.get(request_id)
        if event is None:
            return ""
        transcripts = getattr(event, "_gateway_pending_stt_transcripts", None)
        if isinstance(transcripts, (list, tuple)):
            for transcript in reversed(transcripts):
                cleaned = _clean_transcript(transcript)
                if cleaned:
                    return cleaned
        echoed = getattr(event, "_slate_stt_echo_text", None)
        cleaned_echo = _clean_transcript(echoed)
        if cleaned_echo:
            return cleaned_echo
        prepared = getattr(event, "_gateway_pending_stt_text", None)
        cleaned_prepared = _clean_transcript(prepared)
        if cleaned_prepared:
            return cleaned_prepared
        return ""

    def _drop_event_context(self, request_id: str) -> None:
        self._events.pop(request_id, None)
        self._event_created_at.pop(request_id, None)
        stale_chats = [
            chat_id
            for chat_id, active_request_id in self._request_ids_by_chat.items()
            if active_request_id == request_id
        ]
        for chat_id in stale_chats:
            self._request_ids_by_chat.pop(chat_id, None)

    def _prune_event_contexts(self) -> None:
        cutoff = time.monotonic() - EVENT_CONTEXT_TTL_SECONDS
        stale = [
            request_id
            for request_id, created_at in self._event_created_at.items()
            if created_at < cutoff
        ]
        for request_id in stale:
            self._drop_event_context(request_id)

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        del chat_id, metadata

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": "Slate ink screen", "type": "dm", "id": chat_id}


def _env_enablement() -> Optional[Dict[str, Any]]:
    backend = os.getenv("SLATE_BACKEND", "").strip().rstrip("/")
    token = os.getenv("SLATE_AGENT_TOKEN", "").strip()
    if not backend or not token:
        return None
    _, _, poll_timeout = _settings(
        PlatformConfig(extra={"backend": backend, "token": token})
    )
    return {"backend": backend, "token": token, "poll_timeout": poll_timeout}


def register(ctx) -> None:
    ctx.register_platform(
        name="slate",
        label="Slate",
        adapter_factory=lambda cfg: SlateAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["SLATE_BACKEND", "SLATE_AGENT_TOKEN"],
        install_hint="httpx is already included with Hermes Agent",
        env_enablement_fn=_env_enablement,
        max_message_length=MAX_MESSAGE_LENGTH,
        emoji="▣",
        pii_safe=True,
        allow_update_command=False,
        platform_hint=(
            "你正在通过 Slate 墨水屏与用户对话。设备为 400×300 黑白电子墨水屏，"
            "支持文字显示和语音播放，用户主要通过按键录音交流。默认使用简体中文，"
            "结论优先，回复自然并适合语音朗读，通常不超过 200 个汉字。使用纯文本，"
            "避免 Markdown 表格、复杂列表、链接堆叠，以及依赖颜色或复杂排版的表达。"
            "需要配置、诊断或了解设备能力时，加载 slate-platform:slate-device skill。"
        ),
    )
