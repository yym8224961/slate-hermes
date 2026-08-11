"""Hermes Gateway platform adapter for Slate ink-screen devices."""

import asyncio
import base64
import binascii
import io
import logging
import os
import threading
import wave
from datetime import datetime, timezone
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
MAX_MESSAGE_LENGTH = 2048
RECONNECT_BACKOFF_SECONDS = (1, 2, 5, 10, 30)
_STT_ENV_LOCK = threading.Lock()


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


def _stt_language() -> str:
    """Return the preferred language hint for Slate voice input.

    Slate is a Chinese-first device. Hermes' local STT provider accepts the
    legacy ``HERMES_LOCAL_STT_LANGUAGE`` escape hatch, so the plugin supplies
    ``zh`` only when the operator has not already chosen a language. A value
    of ``auto`` leaves Hermes' configured provider untouched.
    """
    value = os.getenv("SLATE_STT_LANGUAGE", "zh").strip()
    return "" if value.lower() == "auto" else value


def _transcribe_cached_audio(path: str) -> str:
    """Use Hermes' configured STT once and return a clean transcript."""
    try:
        from tools import transcription_tools
    except ImportError:
        logger.warning("[slate] Hermes STT module is unavailable")
        return ""

    language = _stt_language()
    previous_language = os.environ.get("HERMES_LOCAL_STT_LANGUAGE")
    with _STT_ENV_LOCK:
        try:
            if language and previous_language is None:
                os.environ["HERMES_LOCAL_STT_LANGUAGE"] = language
            result = transcription_tools.transcribe_audio(path)
            if (
                isinstance(result, dict)
                and not result.get("success")
                and callable(getattr(transcription_tools, "transcribe_audio_local_fallback", None))
            ):
                result = transcription_tools.transcribe_audio_local_fallback(path)
        except Exception as exc:
            logger.warning("[slate] STT failed for %s: %s", path, exc)
            return ""
        finally:
            if previous_language is None:
                os.environ.pop("HERMES_LOCAL_STT_LANGUAGE", None)
            else:
                os.environ["HERMES_LOCAL_STT_LANGUAGE"] = previous_language

    if not isinstance(result, dict) or not result.get("success"):
        if isinstance(result, dict):
            logger.info("[slate] STT did not produce a transcript: %s", result.get("error", "unknown error"))
        return ""
    transcript = result.get("transcript")
    return transcript.strip()[:1024] if isinstance(transcript, str) else ""


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
        self._transcripts: Dict[str, str] = {}

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
        self._mark_connected()
        self._poll_task = asyncio.create_task(self._poll_loop())
        logger.info("[slate] Connected to %s", self._backend)
        return True

    async def disconnect(self) -> None:
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
        logger.info("[slate] Disconnected")

    async def _poll_loop(self) -> None:
        backoff_index = 0
        while self._running:
            try:
                request = await self._get_pending()
                backoff_index = 0
                if request:
                    await self._dispatch(request)
            except asyncio.CancelledError:
                return
            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                if status in (401, 403):
                    message = "Slate backend rejected SLATE_AGENT_TOKEN"
                    logger.error("[slate] %s", message)
                    self._set_fatal_error("slate_unauthorized", message, retryable=False)
                    return
                logger.warning("[slate] Poll failed with HTTP %d", status)
            except (httpx.HTTPError, ValueError) as exc:
                logger.warning("[slate] Poll failed: %s", exc)
            except Exception:
                logger.exception("[slate] Unexpected poll failure")

            if not self._running:
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

            # Transcribe here so the exact text used by Hermes is also
            # available to Slate. Mark the event as already prepared using the
            # Gateway's existing cache attributes; this prevents the normal
            # inbound pipeline from running STT a second time.
            transcript = await asyncio.to_thread(_transcribe_cached_audio, cached_path)
            if transcript:
                text = transcript
                request["userText"] = transcript
                self._transcripts[request_id] = transcript

        source = self.build_source(
            chat_id="slate",
            chat_name="Slate ink screen",
            chat_type="dm",
            user_id="slate-owner",
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
        if request.get("userText"):
            setattr(event, "_gateway_pending_stt_text", text)
            setattr(event, "_gateway_pending_stt_transcripts", [str(request["userText"])])
        logger.info("[slate] Dispatching request %s", request_id)
        await self.handle_message(event)

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        del chat_id, metadata
        if not self._client:
            return SendResult(success=False, error="Slate HTTP client is not connected")
        if not reply_to:
            return SendResult(success=False, error="Slate response has no request id")

        text = content.strip()[: self.MAX_MESSAGE_LENGTH]
        if not text:
            text = "我暂时没有生成可显示的回复。"
        payload = {"requestId": reply_to, "text": text}
        transcript = self._transcripts.get(reply_to)
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
                return SendResult(success=False, error="Slate request is no longer pending")
            self._transcripts.pop(reply_to, None)
            return SendResult(success=True, message_id=reply_to)
        except httpx.TimeoutException:
            return SendResult(success=False, error="Timeout returning response to Slate")
        except httpx.HTTPError as exc:
            return SendResult(success=False, error=str(exc), retryable=True)

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        del chat_id, metadata

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": "Slate ink screen", "type": "dm", "id": chat_id}


def _env_enablement() -> Optional[Dict[str, Any]]:
    backend = os.getenv("SLATE_BACKEND", "").strip().rstrip("/")
    token = os.getenv("SLATE_AGENT_TOKEN", "").strip()
    if not backend or not token:
        return None
    return {"backend": backend, "token": token, "poll_timeout": 30}


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
