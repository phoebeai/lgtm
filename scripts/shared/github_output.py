from __future__ import annotations

import secrets
from pathlib import Path

from .types import JSONScalar


def _build_delimiter(serialized: str) -> str:
    base = f"EOF_{secrets.token_hex(16)}"
    if base not in serialized:
        return base

    suffix = 0
    while f"{base}_{suffix}" in serialized:
        suffix += 1

    return f"{base}_{suffix}"


def write_github_output(name: str, value: JSONScalar, output_path: str | None) -> None:
    if not output_path:
        return

    serialized = str("" if value is None else value)
    delimiter = _build_delimiter(serialized)
    payload = f"{name}<<{delimiter}\n{serialized}\n{delimiter}\n"

    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(payload)
