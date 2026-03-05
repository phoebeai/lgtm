from __future__ import annotations

import subprocess
from collections.abc import Callable
from typing import Literal

EncodingMode = Literal["utf8", "buffer"]
GitRunner = Callable[[list[str], EncodingMode], str | bytes]


def require_env(name: str, value: str | None) -> str:
    normalized = str("" if value is None else value).strip()
    if not normalized:
        raise ValueError(f"Missing required environment variable: {name}")
    return normalized


def default_run_git(args: list[str], encoding: EncodingMode = "utf8") -> str | bytes:
    completed = subprocess.run(
        ["git", *args],
        check=True,
        capture_output=True,
        text=encoding == "utf8",
    )

    if encoding == "buffer":
        assert isinstance(completed.stdout, bytes)
        return completed.stdout

    assert isinstance(completed.stdout, str)
    return completed.stdout


def git_object_exists(spec: str, run_git: GitRunner = default_run_git) -> bool:
    try:
        run_git(["cat-file", "-e", spec], "utf8")
        return True
    except Exception:
        return False


def read_git_blob(spec: str, label: str, run_git: GitRunner = default_run_git) -> str:
    try:
        result = run_git(["show", spec], "utf8")
        assert isinstance(result, str)
        return result
    except Exception as error:
        raise ValueError(f"Missing {label}: {spec}") from error
