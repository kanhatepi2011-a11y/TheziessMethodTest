#!/usr/bin/env python3
"""
HQ Video Compressor V15 local server.

FPS detection order:
1. yt-dlp metadata
2. every available format's metadata/name
3. remote FFmpeg stream probing
4. temporary best-video download, local FFmpeg probing, then automatic deletion

The complete file is downloaded only as a final fallback when TikTok does not
publish usable FPS metadata and remote probing fails.
"""

from __future__ import annotations

import base64
import json
import os
import threading
import time
import posixpath
import re
import shutil
import subprocess
import struct
import sys
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qs, quote, unquote, urlparse
from urllib.request import Request, urlopen

HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8015"))
ROOT = Path(__file__).resolve().parent
MAX_THUMBNAIL_BYTES = 2_500_000
MAX_ANALYSIS_DOWNLOAD_BYTES = 300 * 1024 * 1024
RANGE_HEAD_BYTES = 4 * 1024 * 1024
RANGE_TAIL_BYTES = 12 * 1024 * 1024
RANGE_FORMAT_ATTEMPTS = 3
CACHE_TTL_SECONDS = 10 * 60
CACHE_MAX_ENTRIES = 32
STATS_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
STATS_CACHE_LOCK = threading.Lock()
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/150.0.0.0 Safari/537.36"
)

try:
    import yt_dlp  # type: ignore
except ImportError:
    yt_dlp = None

try:
    import imageio_ffmpeg  # type: ignore
except ImportError:
    imageio_ffmpeg = None


def first_number(*values: Any) -> float | None:
    for value in values:
        if value is None or isinstance(value, bool):
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if number > 0:
            return number
    return None


def is_allowed_tiktok_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    host = (parsed.hostname or "").lower().rstrip(".")
    return host == "tiktok.com" or host.endswith(".tiktok.com")


def get_ffmpeg_executable() -> str | None:
    if imageio_ffmpeg is not None:
        try:
            executable = imageio_ffmpeg.get_ffmpeg_exe()
            if executable and Path(executable).exists():
                return executable
        except Exception:
            pass
    return shutil.which("ffmpeg")


def normalize_common_fps(value: float) -> float:
    rates = [
        23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60,
        90, 100, 120, 144, 240, 300, 600,
    ]
    nearest = min(rates, key=lambda rate: abs(rate - value))
    if abs(nearest - value) <= max(0.8, nearest * 0.025):
        return nearest
    return value


def parse_fps_from_text(*values: Any) -> float | None:
    patterns = [
        r"(?<!\d)(\d{2,3}(?:\.\d+)?)\s*fps\b",
        r"(?<!\d)(\d{2,3}(?:\.\d+)?)\s*p(?:\b|_)",
    ]
    for value in values:
        if not value:
            continue
        text = str(value)
        for pattern in patterns:
            match = re.search(pattern, text, re.I)
            if match:
                fps = first_number(match.group(1))
                if fps and 1 <= fps <= 1000:
                    return normalize_common_fps(fps)
    return None


def parse_ffmpeg_fps_output(output: str) -> tuple[float | None, str | None, bool]:
    normalized = output.replace("\r", "\n")
    stream_lines = [
        line for line in normalized.splitlines()
        if "Stream #" in line and "Video:" in line
    ]

    for line in stream_lines:
        match = re.search(r"(?<![\w.])(\d+(?:\.\d+)?)\s*fps\b", line, re.I)
        if match:
            fps = first_number(match.group(1))
            if fps and 1 <= fps <= 1000:
                return normalize_common_fps(fps), "ffmpeg-header", False

    for line in stream_lines:
        match = re.search(r"(?<![\w.])(\d+(?:\.\d+)?)\s*tbr\b", line, re.I)
        if match:
            fps = first_number(match.group(1))
            if fps and 1 <= fps <= 1000:
                return normalize_common_fps(fps), "ffmpeg-tbr", True

    last_frame: float | None = None
    last_seconds: float | None = None

    for raw_line in normalized.splitlines():
        line = raw_line.strip()
        if line.startswith("frame="):
            last_frame = first_number(line.split("=", 1)[1])
        elif line.startswith("out_time="):
            match = re.match(
                r"(\d+):(\d+):(\d+(?:\.\d+)?)",
                line.split("=", 1)[1].strip(),
            )
            if match:
                last_seconds = (
                    float(match.group(1)) * 3600
                    + float(match.group(2)) * 60
                    + float(match.group(3))
                )
        elif line.startswith("out_time_us="):
            micros = first_number(line.split("=", 1)[1])
            if micros:
                last_seconds = micros / 1_000_000

    if last_frame and last_seconds and last_seconds > 0.25:
        fps = last_frame / last_seconds
        if 1 <= fps <= 1000:
            return normalize_common_fps(fps), "ffmpeg-progress", True

    classic = re.findall(
        r"frame=\s*(\d+).*?time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)",
        normalized,
        re.I,
    )
    for frame_text, hour_text, minute_text, second_text in reversed(classic):
        frames = first_number(frame_text)
        seconds = (
            float(hour_text) * 3600
            + float(minute_text) * 60
            + float(second_text)
        )
        if frames and seconds > 0.25:
            fps = frames / seconds
            if 1 <= fps <= 1000:
                return normalize_common_fps(fps), "ffmpeg-progress", True

    return None, None, False


def sanitize_headers(headers: Any) -> dict[str, str]:
    result: dict[str, str] = {}
    if not isinstance(headers, dict):
        return result
    for raw_name, raw_value in headers.items():
        name = str(raw_name).strip()
        value = str(raw_value).strip()
        if (
            not name
            or not value
            or "\r" in name
            or "\n" in name
            or "\r" in value
            or "\n" in value
        ):
            continue
        result[name] = value
    return result


def run_ffmpeg_probe(
    input_value: str,
    http_headers: Any = None,
    timeout_seconds: int = 90,
) -> tuple[float | None, str | None, bool, str | None]:
    executable = get_ffmpeg_executable()
    if not executable:
        return None, None, False, "FFmpeg is unavailable."

    is_remote = input_value.startswith(("http://", "https://"))
    command = [
        executable,
        "-hide_banner",
        "-nostdin",
        "-loglevel", "info",
        "-nostats",
        "-progress", "pipe:2",
    ]

    if is_remote:
        headers = sanitize_headers(http_headers)
        user_agent = USER_AGENT
        for name in list(headers):
            if name.lower() == "user-agent":
                user_agent = headers.pop(name)
                break
        if not any(name.lower() == "referer" for name in headers):
            headers["Referer"] = "https://www.tiktok.com/"

        command.extend([
            "-rw_timeout", "30000000",
            "-analyzeduration", "30000000",
            "-probesize", "30000000",
            "-user_agent", user_agent,
        ])
        if headers:
            command.extend([
                "-headers",
                "".join(f"{name}: {value}\r\n" for name, value in headers.items()),
            ])

    command.extend([
        "-i", input_value,
        "-map", "0:v:0",
        "-frames:v", "90",
        "-an", "-sn", "-dn",
        "-f", "null", "-",
    ])

    creation_flags = 0
    if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
        creation_flags = subprocess.CREATE_NO_WINDOW

    try:
        completed = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            creationflags=creation_flags,
            check=False,
        )
        output = (completed.stderr or "") + "\n" + (completed.stdout or "")
    except subprocess.TimeoutExpired as error:
        output = (error.stderr or "") + "\n" + (error.stdout or "")
    except Exception as error:
        return None, None, False, f"FFmpeg probe failed: {error}"

    fps, source, estimated = parse_ffmpeg_fps_output(output)
    if fps:
        return fps, source, estimated, None

    tail = " ".join(
        line.strip()
        for line in output.replace("\r", "\n").splitlines()[-8:]
        if line.strip()
    )
    if len(tail) > 420:
        tail = tail[-420:]
    return (
        None,
        None,
        False,
        "FFmpeg found no usable FPS value."
        + (f" Details: {tail}" if tail else ""),
    )


def collect_video_formats(info: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    items: list[Any] = []
    items.extend(info.get("formats") or [])
    items.extend(info.get("requested_formats") or [])
    items.extend(info.get("requested_downloads") or [])
    items.append(info)

    for item in items:
        if not isinstance(item, dict):
            continue
        if item.get("vcodec") == "none":
            continue
        url = str(item.get("url") or "").strip()
        width = first_number(item.get("width")) or 0
        height = first_number(item.get("height")) or 0
        if not url and width <= 0 and height <= 0:
            continue
        if url and url in seen:
            continue
        if url:
            seen.add(url)
        candidates.append(item)

    def score(item: dict[str, Any]) -> tuple[float, float, float, float]:
        width = first_number(item.get("width")) or 0
        height = first_number(item.get("height")) or 0
        fps = first_number(item.get("fps")) or 0
        bitrate = first_number(item.get("tbr"), item.get("vbr")) or 0
        return width * height, fps, bitrate, 1.0 if item.get("url") else 0.0

    return sorted(candidates, key=score, reverse=True)


def find_metadata_fps(
    info: dict[str, Any],
    formats: Iterable[dict[str, Any]],
    preferred_width: float | None,
    preferred_height: float | None,
) -> tuple[float | None, str | None, bool]:
    direct = first_number(info.get("fps"))
    if direct:
        return normalize_common_fps(direct), "yt-dlp", False

    target_pixels = (preferred_width or 0) * (preferred_height or 0)
    matches: list[tuple[float, float, float, str, bool]] = []

    for item in formats:
        width = first_number(item.get("width")) or 0
        height = first_number(item.get("height")) or 0
        pixels = width * height

        fps = first_number(item.get("fps"))
        source = "yt-dlp"
        estimated = False

        if not fps:
            fps = parse_fps_from_text(
                item.get("format"),
                item.get("format_note"),
                item.get("format_id"),
                item.get("format_name"),
                item.get("resolution"),
                item.get("url"),
            )
            source = "format-name"
            estimated = True

        if fps and 1 <= fps <= 1000:
            distance = abs(pixels - target_pixels) if target_pixels else -pixels
            matches.append((distance, -pixels, -fps, source, estimated))

    if matches:
        matches.sort(key=lambda row: (row[0], row[1], row[2]))
        _, _, negative_fps, source, estimated = matches[0]
        return -negative_fps, source, estimated

    text_fps = parse_fps_from_text(
        info.get("format"),
        info.get("format_note"),
        info.get("format_id"),
        info.get("resolution"),
    )
    if text_fps:
        return text_fps, "format-name", True

    return None, None, False


def probe_remote_formats(
    formats: Iterable[dict[str, Any]],
    max_attempts: int = 2,
) -> tuple[float | None, str | None, bool, str | None, int]:
    errors: list[str] = []
    attempts = 0

    for item in formats:
        url = str(item.get("url") or "").strip()
        if not url:
            continue
        if attempts >= max_attempts:
            break
        attempts += 1

        fps, source, estimated, error = run_ffmpeg_probe(
            url,
            item.get("http_headers") or {},
            timeout_seconds=22,
        )
        if fps:
            return fps, source, estimated, None, attempts
        if error:
            errors.append(error)

    return (
        None,
        None,
        False,
        errors[-1] if errors else "No direct TikTok media URL could be probed.",
        attempts,
    )


def _cache_get(url: str) -> dict[str, Any] | None:
    now = time.time()
    with STATS_CACHE_LOCK:
        record = STATS_CACHE.get(url)
        if not record:
            return None
        created_at, payload = record
        if now - created_at > CACHE_TTL_SECONDS:
            STATS_CACHE.pop(url, None)
            return None
        result = dict(payload)
        result["cache_hit"] = True
        result["message"] = (
            "⚡ Instant cached result. "
            + str(result.get("message") or "")
        ).strip()
        return result


def _cache_set(url: str, payload: dict[str, Any]) -> None:
    with STATS_CACHE_LOCK:
        if len(STATS_CACHE) >= CACHE_MAX_ENTRIES:
            oldest_url = min(
                STATS_CACHE,
                key=lambda key: STATS_CACHE[key][0],
            )
            STATS_CACHE.pop(oldest_url, None)
        STATS_CACHE[url] = (time.time(), dict(payload))


def _range_request_headers(
    source_headers: Any,
    byte_range: str,
) -> dict[str, str]:
    headers = sanitize_headers(source_headers)
    if not any(name.lower() == "user-agent" for name in headers):
        headers["User-Agent"] = USER_AGENT
    if not any(name.lower() == "referer" for name in headers):
        headers["Referer"] = "https://www.tiktok.com/"
    headers["Accept"] = "*/*"
    headers["Range"] = byte_range
    return headers


def _parse_total_size(
    content_range: str | None,
    content_length: str | None,
) -> int | None:
    if content_range:
        match = re.search(r"/(\d+|\*)\s*$", content_range)
        if match and match.group(1) != "*":
            return int(match.group(1))
    if content_length:
        try:
            value = int(content_length)
            return value if value > 0 else None
        except ValueError:
            pass
    return None


def _fetch_http_range(
    url: str,
    source_headers: Any,
    start: int,
    end: int,
    timeout_seconds: int = 18,
) -> tuple[bytes, int | None, bool, str | None]:
    requested_length = max(1, end - start + 1)
    request = Request(
        url,
        headers=_range_request_headers(
            source_headers,
            f"bytes={start}-{end}",
        ),
    )

    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            status = int(getattr(response, "status", response.getcode()))
            content_range = response.headers.get("Content-Range")
            total_size = _parse_total_size(
                content_range,
                response.headers.get("Content-Length"),
            )
            range_honored = status == 206 or bool(content_range)

            if start > 0 and not range_honored:
                response.read(1)
                return (
                    b"",
                    total_size,
                    False,
                    "The media server ignored the requested byte range.",
                )

            data = response.read(requested_length + 1)
            if len(data) > requested_length:
                data = data[:requested_length]

            return data, total_size, range_honored, None
    except Exception as error:
        return b"", None, False, f"HTTP range request failed: {error}"


def _extract_complete_mp4_box(
    data: bytes,
    target_type: bytes,
) -> bytes | None:
    search_from = 0
    while True:
        type_offset = data.find(target_type, search_from)
        if type_offset < 0:
            return None
        search_from = type_offset + 1

        start = type_offset - 4
        if start < 0 or start + 8 > len(data):
            continue

        size32 = struct.unpack(">I", data[start:start + 4])[0]
        header_size = 8

        if size32 == 1:
            if start + 16 > len(data):
                continue
            size = struct.unpack(">Q", data[start + 8:start + 16])[0]
            header_size = 16
        elif size32 == 0:
            size = len(data) - start
        else:
            size = size32

        if size < header_size:
            continue
        if start + size <= len(data):
            return data[start:start + size]


def _parse_isolated_moov_fps(
    moov_bytes: bytes,
    source_label: str,
) -> tuple[float | None, dict[str, Any]]:
    with tempfile.NamedTemporaryFile(
        prefix="hq_v15_moov_",
        suffix=".mp4",
        delete=False,
    ) as temp_file:
        temp_path = Path(temp_file.name)
        temp_file.write(moov_bytes)

    try:
        fps, diagnostics = parse_mp4_declared_fps(temp_path)
        diagnostics["range_source"] = source_label
        diagnostics["moov_bytes"] = len(moov_bytes)
        return fps, diagnostics
    finally:
        temp_path.unlink(missing_ok=True)


def remote_mp4_range_fps(
    url: str,
    http_headers: Any,
) -> tuple[
    float | None,
    str | None,
    bool,
    str | None,
    dict[str, Any] | None,
]:
    downloaded_bytes = 0
    head, total_size, _, head_error = _fetch_http_range(
        url,
        http_headers,
        0,
        RANGE_HEAD_BYTES - 1,
    )
    downloaded_bytes += len(head)

    if head:
        moov = _extract_complete_mp4_box(head, b"moov")
        if moov:
            fps, diagnostics = _parse_isolated_moov_fps(
                moov,
                "head-range",
            )
            diagnostics["range_bytes_downloaded"] = downloaded_bytes
            diagnostics["remote_total_size"] = total_size
            if fps:
                return fps, "remote-mp4-range", False, None, diagnostics

    if total_size and total_size > RANGE_HEAD_BYTES:
        tail_start = max(0, total_size - RANGE_TAIL_BYTES)
        tail, tail_total, _, tail_error = _fetch_http_range(
            url,
            http_headers,
            tail_start,
            total_size - 1,
        )
        downloaded_bytes += len(tail)
        if tail:
            moov = _extract_complete_mp4_box(tail, b"moov")
            if moov:
                fps, diagnostics = _parse_isolated_moov_fps(
                    moov,
                    "tail-range",
                )
                diagnostics["range_bytes_downloaded"] = downloaded_bytes
                diagnostics["remote_total_size"] = tail_total or total_size
                if fps:
                    return fps, "remote-mp4-range", False, None, diagnostics
        error = tail_error or head_error
    else:
        error = head_error

    return (
        None,
        None,
        False,
        error or "MP4 moov timing box was not found in the fast byte ranges.",
        {
            "range_bytes_downloaded": downloaded_bytes,
            "remote_total_size": total_size,
        },
    )


def probe_remote_mp4_ranges(
    formats: Iterable[dict[str, Any]],
    max_attempts: int = RANGE_FORMAT_ATTEMPTS,
) -> tuple[
    float | None,
    str | None,
    bool,
    str | None,
    int,
    dict[str, Any] | None,
]:
    errors: list[str] = []
    attempts = 0
    candidates = []
    others = []

    for item in formats:
        ext = str(item.get("ext") or "").lower()
        url = str(item.get("url") or "").strip()
        is_mp4 = ext in {"mp4", "m4v", "mov"} or ".mp4" in url.lower().split("?", 1)[0]
        (candidates if is_mp4 else others).append(item)

    for item in candidates + others:
        url = str(item.get("url") or "").strip()
        if not url:
            continue
        if attempts >= max_attempts:
            break
        attempts += 1

        fps, source, estimated, error, diagnostics = remote_mp4_range_fps(
            url,
            item.get("http_headers") or {},
        )
        if fps:
            return fps, source, estimated, None, attempts, diagnostics
        if error:
            errors.append(error)

    return (
        None,
        None,
        False,
        errors[-1] if errors else "No range-readable MP4 format was found.",
        attempts,
        None,
    )



class Mp4ParseError(RuntimeError):
    pass


def _read_exact(handle: Any, offset: int, length: int) -> bytes:
    handle.seek(offset)
    data = handle.read(length)
    if len(data) != length:
        raise Mp4ParseError("Unexpected end of MP4 file.")
    return data


def _read_u32(handle: Any, offset: int) -> int:
    return struct.unpack(">I", _read_exact(handle, offset, 4))[0]


def _read_u64(handle: Any, offset: int) -> int:
    return struct.unpack(">Q", _read_exact(handle, offset, 8))[0]


def _read_type(handle: Any, offset: int) -> str:
    return _read_exact(handle, offset, 4).decode("latin-1", errors="replace")


def _iter_mp4_boxes(
    handle: Any,
    start: int,
    end: int,
) -> Iterable[dict[str, Any]]:
    position = start
    while position + 8 <= end:
        size = _read_u32(handle, position)
        box_type = _read_type(handle, position + 4)
        header_size = 8

        if size == 1:
            if position + 16 > end:
                raise Mp4ParseError(f"Invalid extended MP4 box: {box_type}")
            size = _read_u64(handle, position + 8)
            header_size = 16
        elif size == 0:
            size = end - position

        if size < header_size or position + size > end:
            raise Mp4ParseError(
                f"Invalid MP4 box {box_type} at byte {position}"
            )

        yield {
            "type": box_type,
            "start": position,
            "size": size,
            "end": position + size,
            "header_size": header_size,
            "payload_start": position + header_size,
        }
        position += size


def _find_child_box(
    handle: Any,
    parent: dict[str, Any],
    box_type: str,
) -> dict[str, Any] | None:
    for box in _iter_mp4_boxes(
        handle,
        parent["payload_start"],
        parent["end"],
    ):
        if box["type"] == box_type:
            return box
    return None


def _mp4_handler_type(handle: Any, trak: dict[str, Any]) -> str:
    mdia = _find_child_box(handle, trak, "mdia")
    if not mdia:
        return ""
    hdlr = _find_child_box(handle, mdia, "hdlr")
    if not hdlr or hdlr["payload_start"] + 12 > hdlr["end"]:
        return ""
    return _read_type(handle, hdlr["payload_start"] + 8)


def _read_mp4_mdhd(
    handle: Any,
    mdhd: dict[str, Any],
) -> tuple[int, int]:
    version = _read_exact(handle, mdhd["payload_start"], 1)[0]
    if version == 1:
        timescale = _read_u32(handle, mdhd["payload_start"] + 20)
        duration = _read_u64(handle, mdhd["payload_start"] + 24)
    else:
        timescale = _read_u32(handle, mdhd["payload_start"] + 12)
        duration = _read_u32(handle, mdhd["payload_start"] + 16)
    return timescale, duration


def _read_mp4_stts(
    handle: Any,
    stts: dict[str, Any],
) -> tuple[int, int, int]:
    payload = stts["payload_start"]
    entry_count = _read_u32(handle, payload + 4)
    sample_count = 0
    timing_ticks = 0
    smallest_delta = 0

    for index in range(entry_count):
        entry_offset = payload + 8 + index * 8
        count = _read_u32(handle, entry_offset)
        delta = _read_u32(handle, entry_offset + 4)
        sample_count += count
        timing_ticks += count * delta
        if delta > 0 and (smallest_delta == 0 or delta < smallest_delta):
            smallest_delta = delta

    return sample_count, timing_ticks, smallest_delta


def parse_mp4_declared_fps(
    path: Path,
) -> tuple[float | None, dict[str, Any]]:
    """
    Compute the declared video FPS directly from the MP4 `stts` table:

        FPS = total declared samples / declared sample duration

    This detects fake-sample tricks such as 60 real frames represented by
    600 declared samples per second, even when FFmpeg omits an FPS field.
    """
    file_size = path.stat().st_size
    diagnostics: dict[str, Any] = {
        "path": str(path),
        "file_size": file_size,
    }

    with path.open("rb") as handle:
        top_level = list(_iter_mp4_boxes(handle, 0, file_size))
        diagnostics["top_level_boxes"] = [
            box["type"] for box in top_level
        ]

        moov = next(
            (box for box in top_level if box["type"] == "moov"),
            None,
        )
        if not moov:
            return None, {
                **diagnostics,
                "error": "MP4 moov box was not found.",
            }

        video_trak = None
        for child in _iter_mp4_boxes(
            handle,
            moov["payload_start"],
            moov["end"],
        ):
            if (
                child["type"] == "trak"
                and _mp4_handler_type(handle, child) == "vide"
            ):
                video_trak = child
                break

        if not video_trak:
            return None, {
                **diagnostics,
                "error": "MP4 video track was not found.",
            }

        mdia = _find_child_box(handle, video_trak, "mdia")
        mdhd = _find_child_box(handle, mdia, "mdhd") if mdia else None
        minf = _find_child_box(handle, mdia, "minf") if mdia else None
        stbl = _find_child_box(handle, minf, "stbl") if minf else None
        stts = _find_child_box(handle, stbl, "stts") if stbl else None

        if not mdhd or not stts:
            return None, {
                **diagnostics,
                "error": "MP4 mdhd/stts timing boxes were not found.",
            }

        timescale, mdhd_duration = _read_mp4_mdhd(handle, mdhd)
        sample_count, timing_ticks, sample_delta = _read_mp4_stts(
            handle,
            stts,
        )

        diagnostics.update({
            "timescale": timescale,
            "mdhd_duration": mdhd_duration,
            "declared_samples": sample_count,
            "stts_timing_ticks": timing_ticks,
            "smallest_sample_delta": sample_delta,
        })

        if timescale <= 0 or sample_count <= 0 or timing_ticks <= 0:
            return None, {
                **diagnostics,
                "error": "MP4 timing values were invalid.",
            }

        duration_seconds = timing_ticks / timescale
        fps = sample_count / duration_seconds
        diagnostics["duration_seconds"] = duration_seconds
        diagnostics["declared_fps"] = fps

        if not (1 <= fps <= 5000):
            return None, {
                **diagnostics,
                "error": f"MP4 declared FPS was outside a valid range: {fps}",
            }

        return normalize_common_fps(fps), diagnostics


def find_downloaded_file(temp_root: Path, info: dict[str, Any]) -> Path | None:
    candidates: list[Path] = []

    for item in info.get("requested_downloads") or []:
        if isinstance(item, dict):
            filepath = item.get("filepath")
            if filepath:
                candidates.append(Path(str(filepath)))

    for key in ("filepath", "_filename"):
        value = info.get(key)
        if value:
            candidates.append(Path(str(value)))

    candidates.extend(
        path for path in temp_root.rglob("*")
        if path.is_file() and path.suffix.lower() not in {".part", ".ytdl", ".json"}
    )

    existing = [path for path in candidates if path.exists() and path.is_file()]
    if not existing:
        return None
    return max(existing, key=lambda path: path.stat().st_size)


def temporary_download_fps(
    url: str,
) -> tuple[
    float | None,
    str | None,
    bool,
    str | None,
    int | None,
    dict[str, Any] | None,
]:
    """
    Final fallback:
    1. temporarily download the selected MP4 representation;
    2. parse MP4 `stts` directly to obtain declared FPS;
    3. use FFmpeg only if the sample table cannot be read;
    4. automatically delete the temporary file.
    """
    if yt_dlp is None:
        return None, None, False, "yt-dlp is unavailable.", None, None

    with tempfile.TemporaryDirectory(prefix="hq_v14_fps_") as temp_name:
        temp_root = Path(temp_name)
        options = {
            "quiet": True,
            "no_warnings": True,
            "noplaylist": True,
            "overwrites": True,
            "continuedl": False,
            "nopart": True,
            "socket_timeout": 35,
            "retries": 3,
            "extractor_retries": 3,
            "max_filesize": MAX_ANALYSIS_DOWNLOAD_BYTES,
            "format": "bestvideo[ext=mp4]/best[ext=mp4]/bestvideo/best",
            "outtmpl": str(temp_root / "analysis_%(id)s.%(ext)s"),
            "http_headers": {"User-Agent": USER_AGENT},
        }

        try:
            with yt_dlp.YoutubeDL(options) as downloader:
                downloaded_info = downloader.extract_info(url, download=True)
        except Exception as error:
            return (
                None,
                None,
                False,
                f"Temporary analysis download failed: {error}",
                None,
                None,
            )

        if not isinstance(downloaded_info, dict):
            return (
                None,
                None,
                False,
                "Temporary download returned no metadata.",
                None,
                None,
            )

        downloaded_path = find_downloaded_file(temp_root, downloaded_info)
        if not downloaded_path:
            return (
                None,
                None,
                False,
                "Temporary video file was not created.",
                None,
                None,
            )

        size_bytes = downloaded_path.stat().st_size
        suffix = downloaded_path.suffix.lower()
        mp4_diagnostics: dict[str, Any] | None = None

        if suffix in {".mp4", ".m4v", ".mov"}:
            try:
                declared_fps, mp4_diagnostics = parse_mp4_declared_fps(
                    downloaded_path
                )
                if declared_fps:
                    return (
                        declared_fps,
                        "mp4-sample-table",
                        False,
                        None,
                        size_bytes,
                        mp4_diagnostics,
                    )
            except Exception as error:
                mp4_diagnostics = {
                    "error": f"MP4 sample-table parser failed: {error}"
                }

        fps, source, estimated, error = run_ffmpeg_probe(
            str(downloaded_path),
            timeout_seconds=120,
        )
        if fps:
            return (
                fps,
                "temporary-download",
                estimated,
                None,
                size_bytes,
                mp4_diagnostics,
            )

        diagnostic_text = ""
        if mp4_diagnostics and mp4_diagnostics.get("error"):
            diagnostic_text = " " + str(mp4_diagnostics["error"])

        return (
            fps,
            source,
            estimated,
            (error or "Local FPS probe failed.") + diagnostic_text,
            size_bytes,
            mp4_diagnostics,
        )


def fetch_thumbnail_data_url(url: str | None) -> str | None:
    if not url:
        return None
    try:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"}:
            return None
        request = Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                "Referer": "https://www.tiktok.com/",
            },
        )
        with urlopen(request, timeout=15) as response:
            content_type = response.headers.get_content_type() or "image/jpeg"
            data = response.read(MAX_THUMBNAIL_BYTES + 1)
        if len(data) > MAX_THUMBNAIL_BYTES:
            return None
        return "data:" + content_type + ";base64," + base64.b64encode(data).decode("ascii")
    except Exception:
        return None


def oembed_fallback(url: str) -> dict[str, Any]:
    endpoint = "https://www.tiktok.com/oembed?url=" + quote(url, safe="")
    request = Request(
        endpoint,
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    with urlopen(request, timeout=20) as response:
        data = json.loads(response.read().decode("utf-8"))

    author_url = str(data.get("author_url") or "")
    thumbnail_url = data.get("thumbnail_url")
    elapsed_ms = round((time.perf_counter() - analysis_started) * 1000)
    if fps_source == "remote-mp4-range":
        analysis_message = (
            f"⚡ Fast MP4 range scan detected FPS in {elapsed_ms / 1000:.2f}s "
            "without downloading the full video."
        )
    elif temporary_probe_used:
        analysis_message = (
            f"Deep fallback completed in {elapsed_ms / 1000:.2f}s. "
            "The temporary analysis file was deleted."
        )
    else:
        analysis_message = (
            f"TikTok statistics loaded in {elapsed_ms / 1000:.2f}s."
        )

    return {
        "ok": True,
        "api_version": "15.0",
        "cache_hit": False,
        "analysis_elapsed_ms": None,
        "source": "tiktok-oembed",
        "author_name": data.get("author_name") or "TikTok creator",
        "handle": author_url.rsplit("/@", 1)[-1] if "/@" in author_url else "",
        "caption": data.get("title") or "TikTok video",
        "thumbnail_url": thumbnail_url,
        "thumbnail_data_url": fetch_thumbnail_data_url(thumbnail_url),
        "width": None,
        "height": None,
        "fps": None,
        "fps_source": None,
        "fps_estimated": False,
        "fps_status": "TikTok public data contains no FPS",
        "fps_probe_attempts": 0,
        "temporary_probe_used": False,
        "bitrate_mbps": None,
        "duration": None,
        "filesize_bytes": None,
        "bitrate_estimated": False,
        "filesize_estimated": False,
        "message": "Public TikTok information loaded through V15.",
        "warning": "Full technical extraction was unavailable.",
    }


def extract_tiktok_statistics(url: str) -> dict[str, Any]:
    if yt_dlp is None:
        raise RuntimeError(
            "yt-dlp is not installed. Run: python -m pip install --upgrade -r requirements.txt"
        )

    options = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "socket_timeout": 30,
        "retries": 3,
        "extractor_retries": 3,
        "http_headers": {"User-Agent": USER_AGENT},
    }

    with yt_dlp.YoutubeDL(options) as downloader:
        info = downloader.extract_info(url, download=False)

    if not isinstance(info, dict):
        raise RuntimeError("TikTok returned no usable information.")

    entries = info.get("entries")
    if entries and isinstance(entries, list):
        info = next((item for item in entries if isinstance(item, dict)), info)

    formats = collect_video_formats(info)
    best = formats[0] if formats else {}

    width = first_number(info.get("width"), best.get("width"))
    height = first_number(info.get("height"), best.get("height"))
    duration = first_number(info.get("duration"), best.get("duration"))

    fps, fps_source, fps_estimated = find_metadata_fps(
        info,
        formats,
        width,
        height,
    )
    analysis_started = time.perf_counter()
    probe_attempts = 0
    range_attempts = 0
    probe_error: str | None = None
    temporary_probe_used = False
    temporary_bytes: int | None = None
    mp4_fps_diagnostics: dict[str, Any] | None = None
    remote_range_diagnostics: dict[str, Any] | None = None

    if not fps and duration:
        frame_count = first_number(
            info.get("frame_count"),
            info.get("n_frames"),
            best.get("frame_count"),
            best.get("n_frames"),
        )
        if frame_count:
            calculated = frame_count / duration
            if 1 <= calculated <= 1000:
                fps = normalize_common_fps(calculated)
                fps_source = "frame-count"
                fps_estimated = True

    if not fps:
        (
            fps,
            fps_source,
            fps_estimated,
            range_error,
            range_attempts,
            remote_range_diagnostics,
        ) = probe_remote_mp4_ranges(formats)
        if range_error:
            probe_error = range_error

    if not fps:
        fps, fps_source, fps_estimated, ffmpeg_error, probe_attempts = (
            probe_remote_formats(formats)
        )
        if ffmpeg_error:
            probe_error = ffmpeg_error

    if not fps:
        temporary_probe_used = True
        (
            fps,
            fps_source,
            fps_estimated,
            temp_error,
            temporary_bytes,
            mp4_fps_diagnostics,
        ) = temporary_download_fps(url)
        if temp_error:
            probe_error = temp_error

    tbr = first_number(info.get("tbr"), best.get("tbr"))
    vbr = first_number(info.get("vbr"), best.get("vbr"))
    abr = first_number(info.get("abr"), best.get("abr"))
    bitrate_kbps = tbr or ((vbr or 0) + (abr or 0) if (vbr or abr) else None)
    bitrate_estimated = False

    filesize = first_number(
        info.get("filesize"),
        best.get("filesize"),
        info.get("filesize_approx"),
        best.get("filesize_approx"),
        temporary_bytes,
    )
    filesize_estimated = bool(
        filesize
        and not first_number(info.get("filesize"), best.get("filesize"), temporary_bytes)
    )

    if not bitrate_kbps and filesize and duration:
        bitrate_kbps = filesize * 8 / duration / 1000
        bitrate_estimated = True

    if not filesize and bitrate_kbps and duration:
        filesize = bitrate_kbps * 1000 / 8 * duration
        filesize_estimated = True

    thumbnails = info.get("thumbnails") or []
    thumbnail_url = info.get("thumbnail")
    if not thumbnail_url and thumbnails:
        valid = [
            item for item in thumbnails
            if isinstance(item, dict) and item.get("url")
        ]
        if valid:
            thumbnail_url = valid[-1]["url"]

    handle = (
        info.get("uploader_id")
        or info.get("channel_id")
        or info.get("creator_id")
        or ""
    )
    author_name = (
        info.get("uploader")
        or info.get("channel")
        or info.get("creator")
        or "TikTok creator"
    )
    caption = info.get("description") or info.get("title") or "TikTok video"

    warnings: list[str] = []
    if not fps:
        warnings.append(
            probe_error
            or "FPS was absent from metadata and could not be detected."
        )
    elif fps_estimated:
        warnings.append("FPS is estimated from stream timing.")
    if temporary_probe_used and fps:
        warnings.append(
            "V15 used the full-download fallback and deleted the temporary file immediately."
        )
    if bitrate_estimated:
        warnings.append("Bitrate was calculated from file size and duration.")
    if filesize_estimated:
        warnings.append("File size is estimated.")

    return {
        "ok": True,
        "api_version": "15.0",
        "source": "yt-dlp-v15",
        "author_name": author_name,
        "handle": handle,
        "caption": caption,
        "thumbnail_url": thumbnail_url,
        "thumbnail_data_url": fetch_thumbnail_data_url(thumbnail_url),
        "width": width,
        "height": height,
        "fps": fps,
        "fps_source": fps_source,
        "fps_estimated": fps_estimated,
        "fps_status": None if fps else "Deep FPS check failed",
        "fps_probe_attempts": probe_attempts,
        "range_probe_attempts": range_attempts,
        "remote_range_diagnostics": remote_range_diagnostics,
        "analysis_elapsed_ms": elapsed_ms,
        "cache_hit": False,
        "temporary_probe_used": temporary_probe_used,
        "mp4_fps_diagnostics": mp4_fps_diagnostics,
        "bitrate_mbps": bitrate_kbps / 1000 if bitrate_kbps else None,
        "duration": duration,
        "filesize_bytes": int(filesize) if filesize else None,
        "bitrate_estimated": bitrate_estimated,
        "filesize_estimated": filesize_estimated,
        "message": analysis_message,
        "warning": " ".join(warnings) if warnings else None,
    }


class AppHandler(SimpleHTTPRequestHandler):
    server_version = "HQVideoCompressorV15/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stdout.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/api/health":
            self.send_json(
                200,
                {
                    "ok": True,
                    "yt_dlp": yt_dlp is not None,
                    "ffmpeg_probe": get_ffmpeg_executable() is not None,
                    "fast_range_scan": True,
                    "cache_ttl_seconds": CACHE_TTL_SECONDS,
                    "cache_entries": len(STATS_CACHE),
                    "api_version": "15.0",
                    "port": PORT,
                    "service": "HQ Video Compressor V15",
                },
            )
            return

        if parsed.path == "/api/tiktok-stats":
            query = parse_qs(parsed.query)
            url = (query.get("url") or [""])[0].strip()

            if not is_allowed_tiktok_url(url):
                self.send_json(
                    400,
                    {
                        "ok": False,
                        "error": "Only public tiktok.com video URLs are accepted.",
                    },
                )
                return

            try:
                payload = _cache_get(url)
                if payload is None:
                    try:
                        payload = extract_tiktok_statistics(url)
                    except Exception as extraction_error:
                        payload = oembed_fallback(url)
                        payload["warning"] = (
                            f"Full V15 extraction failed: {extraction_error}. "
                            + str(payload.get("warning") or "")
                        ).strip()
                    _cache_set(url, payload)
                self.send_json(200, payload)
            except Exception as error:
                self.send_json(502, {"ok": False, "error": str(error)})
            return

        if parsed.path in {"", "/"}:
            self.path = "/index.html"

        super().do_GET()

    def translate_path(self, path: str) -> str:
        clean = posixpath.normpath(unquote(urlparse(path).path))
        parts = [item for item in clean.split("/") if item and item not in {".", ".."}]
        target = ROOT.joinpath(*parts)
        try:
            resolved = target.resolve()
            resolved.relative_to(ROOT.resolve())
        except (ValueError, OSError):
            return str(ROOT / "__forbidden__")
        return str(resolved)


def main() -> None:
    os.chdir(ROOT)
    server = ThreadingHTTPServer((HOST, PORT), AppHandler)
    print(f"HQ Video Compressor V15: http://localhost:{PORT}")
    print("API version: 15.0")
    print("TikTok metadata:", "ready" if yt_dlp is not None else "MISSING yt-dlp")
    executable = get_ffmpeg_executable()
    print("FFmpeg FPS probe:", executable or "MISSING")
    print("Fast path: MP4 head/tail range scan (no full video download)")
    print(f"Result cache: {CACHE_TTL_SECONDS // 60} minutes")
    print("Fallback: temporary download -> local probe -> automatic deletion")
    print("Press Ctrl+C to stop.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping V15...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
