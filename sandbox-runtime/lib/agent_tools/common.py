from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


class AgentToolError(RuntimeError):
    """An expected, user-actionable command failure."""


def positive_int_env(name: str, fallback: int) -> int:
    try:
        value = int(os.environ.get(name, ""))
    except ValueError:
        return fallback
    return value if value > 0 else fallback


def existing_file(value: str | Path) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise AgentToolError(f"Input file does not exist: {path}")
    return path


def command_path(*candidates: str) -> str:
    for candidate in candidates:
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    raise AgentToolError(
        f"Required command is not installed: {', '.join(candidates)}"
    )


def run_checked(
    args: Sequence[str | Path],
    *,
    timeout: int | None = None,
    cwd: str | Path | None = None,
    env: Mapping[str, str] | None = None,
    input_bytes: bytes | None = None,
    capture: bool = True,
) -> subprocess.CompletedProcess[bytes]:
    command = [str(arg) for arg in args]
    try:
        result = subprocess.run(
            command,
            cwd=str(cwd) if cwd else None,
            env=dict(env) if env else None,
            input=input_bytes,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE,
            check=False,
            timeout=timeout,
        )
    except FileNotFoundError as error:
        raise AgentToolError(f"Required command is not installed: {command[0]}") from error
    except subprocess.TimeoutExpired as error:
        raise AgentToolError(
            f"Command exceeded the {timeout}-second safety limit: {command[0]}"
        ) from error
    if result.returncode != 0:
        stderr = (result.stderr or b"").decode("utf-8", errors="replace").strip()
        message = stderr[-2_000:] if stderr else f"exit status {result.returncode}"
        raise AgentToolError(f"{Path(command[0]).name} failed: {message}")
    return result


def atomic_output_path(output: Path) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    return output.with_name(f".{output.name}.{os.getpid()}.partial")


def finish_atomic_output(partial: Path, output: Path) -> None:
    if not partial.is_file() or partial.stat().st_size <= 0:
        partial.unlink(missing_ok=True)
        raise AgentToolError(f"Command did not create a valid output file: {output}")
    partial.replace(output)


def write_text_atomic(output: Path, body: str) -> None:
    partial = atomic_output_path(output)
    try:
        partial.write_text(body, encoding="utf-8")
        finish_atomic_output(partial, output)
    finally:
        partial.unlink(missing_ok=True)


def emit_result(payload: dict[str, Any], *, as_json: bool, text_key: str) -> None:
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(payload[text_key])


def fail_cleanly(error: BaseException) -> "NoReturn":
    if isinstance(error, AgentToolError):
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2)
    raise error


def bounded_join(parts: Iterable[str], maximum: int) -> str:
    result = "\n".join(part.strip() for part in parts if part.strip()).strip()
    if len(result) <= maximum:
        return result
    return f"{result[:maximum].rstrip()}\n\n[truncated]"

