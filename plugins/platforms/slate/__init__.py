"""Slate platform plugin entry point."""

from pathlib import Path
from typing import Any

from .adapter import register as register_platform


def register(ctx: Any) -> None:
    """Register both the Gateway channel and its device knowledge skill."""

    register_platform(ctx)
    skill_md = Path(__file__).parent / "skills" / "slate-device" / "SKILL.md"
    ctx.register_skill("slate-device", skill_md)


__all__ = ["register"]
