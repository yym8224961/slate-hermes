"""Hermes Gateway platform adapter for Slate ink-screen devices."""

import asyncio
import logging
import os
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


logger = logging.getLogger(__name__)
MAX_MESSAGE_LENGTH = 2048
RECONNECT_BACKOFF_SECONDS = (1, 2, 5, 10, 30)


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
        if not isinstance(data, dict) or not data.get("requestId") or not data.get("text"):
            raise ValueError("invalid pending-request response")
        return data

    async def _dispatch(self, request: Dict[str, Any]) -> None:
        request_id = str(request["requestId"])
        text = str(request["text"]).strip()
        source = self.build_source(
            chat_id="slate",
            chat_name="Slate ink screen",
            chat_type="dm",
            user_id="slate-owner",
            user_name="Slate owner",
        )
        event = MessageEvent(
            text=text,
            message_type=MessageType.TEXT,
            source=source,
            message_id=request_id,
            raw_message=request,
            timestamp=datetime.now(tz=timezone.utc),
        )
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
        try:
            response = await self._client.post(
                f"{self._backend}/api/v1/hermes/agent/response",
                json={"requestId": reply_to, "text": text},
                timeout=15,
            )
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict) or not data.get("ok"):
                return SendResult(success=False, error="Slate request is no longer pending")
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
