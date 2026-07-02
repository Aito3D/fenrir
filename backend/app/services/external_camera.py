"""External camera service.

Supports MJPEG streams, RTSP streams (via ffmpeg), HTTP snapshot URLs, and USB cameras.

Security Note: This service intentionally makes requests to user-configured camera URLs.
This is necessary functionality for external camera integration. URLs are validated
to ensure they are well-formed before use.
"""

import asyncio
import ipaddress
import logging
import re
import shutil
import subprocess
import sys
import time
from collections.abc import AsyncGenerator
from pathlib import Path
from urllib.parse import urlparse

import aiohttp

from backend.app.services.camera import get_ffmpeg_path, get_rtsp_semaphore

logger = logging.getLogger(__name__)


def _sanitize_camera_url(url: str, allowed_schemes: tuple[str, ...] = ("http", "https", "rtsp")) -> str | None:
    """Validate and sanitize camera URL, returning a safe reconstructed URL.

    This validates that the URL is well-formed, uses an allowed scheme,
    does not target cloud metadata services, and returns a reconstructed
    URL from validated components.

    Note: This intentionally allows user-provided URLs as that is the
    purpose of external camera configuration. Local network IPs are
    allowed since cameras are typically on the same LAN.

    Args:
        url: URL to validate and sanitize
        allowed_schemes: Tuple of allowed URL schemes

    Returns:
        Sanitized URL string if valid, None otherwise
    """
    try:
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.netloc:
            return None

        # Validate scheme against allowlist
        scheme = parsed.scheme.lower()
        if scheme not in allowed_schemes:
            return None

        # Block cloud metadata service endpoints (SSRF mitigation)
        # These are dangerous destinations that should never be accessed
        hostname = parsed.hostname or ""
        hostname_lower = hostname.lower().rstrip(".")
        blocked_hosts = (
            "169.254.169.254",  # AWS/GCP/Azure metadata
            "metadata.google.internal",  # GCP metadata
            "metadata.google",
            "localhost",  # Block localhost to prevent internal service access
            "127.0.0.1",
            "::1",
            "0.0.0.0",  # nosec B104
        )
        if hostname_lower in blocked_hosts:
            logger.warning("Blocked camera URL targeting restricted host: %s", hostname)
            return None

        # Block link-local addresses (169.254.x.x and fe80::/10)
        if hostname.startswith("169.254."):
            logger.warning("Blocked camera URL targeting link-local address: %s", hostname)
            return None
        if hostname_lower.startswith("fe80:"):
            logger.warning("Blocked camera URL targeting IPv6 link-local: %s", hostname)
            return None

        # Resolve IP literals and check for restricted ranges (blocks hex/decimal/IPv6-mapped bypasses)
        try:
            addr = ipaddress.ip_address(hostname)
            if addr.is_loopback or addr.is_link_local or addr.is_unspecified:
                logger.warning("Blocked camera URL targeting restricted IP: %s", hostname)
                return None
            if hasattr(addr, "ipv4_mapped") and addr.ipv4_mapped:
                mapped = addr.ipv4_mapped
                if mapped.is_loopback or mapped.is_link_local or mapped.is_unspecified:
                    logger.warning("Blocked camera URL targeting restricted mapped IP: %s", hostname)
                    return None
        except ValueError:
            # Not an IP literal — resolve hostname to check the actual IP
            import socket

            try:
                resolved = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
                resolved_ip = None
                for _family, _type, _proto, _canonname, sockaddr in resolved:
                    ip_str = sockaddr[0]
                    addr = ipaddress.ip_address(ip_str)
                    if addr.is_loopback or addr.is_link_local or addr.is_unspecified:
                        logger.warning("Blocked camera URL: hostname %s resolves to restricted IP %s", hostname, ip_str)
                        return None
                    if hasattr(addr, "ipv4_mapped") and addr.ipv4_mapped:
                        mapped = addr.ipv4_mapped
                        if mapped.is_loopback or mapped.is_link_local or mapped.is_unspecified:
                            logger.warning(
                                "Blocked camera URL: hostname %s resolves to restricted mapped IP %s", hostname, ip_str
                            )
                            return None
                    if resolved_ip is None:
                        resolved_ip = ip_str
                # Use resolved IP in the URL to prevent DNS rebinding
                if resolved_ip is not None:
                    hostname = resolved_ip
            except socket.gaierror:
                logger.warning("Blocked camera URL: hostname %s cannot be resolved", hostname)
                return None

        # Reconstruct URL from validated components to break taint chain
        # Preserve credentials for RTSP/RTSPS (cameras legitimately embed auth in URL)
        port_str = f":{parsed.port}" if parsed.port else ""
        path = parsed.path or ""
        query = f"?{parsed.query}" if parsed.query else ""
        fragment = f"#{parsed.fragment}" if parsed.fragment else ""

        userinfo = ""
        if scheme in ("rtsp", "rtsps") and parsed.username:
            userinfo = parsed.username
            if parsed.password:
                userinfo += f":{parsed.password}"
            userinfo += "@"

        # Build sanitized URL from validated components (hostname replaced with resolved IP when applicable)
        sanitized = f"{scheme}://{userinfo}{hostname}{port_str}{path}{query}{fragment}"
        return sanitized
    except ValueError:
        return None


async def _sanitize_camera_url_async(
    url: str, allowed_schemes: tuple[str, ...] = ("http", "https", "rtsp")
) -> str | None:
    """Async wrapper for _sanitize_camera_url that runs DNS resolution off the event loop."""
    return await asyncio.get_running_loop().run_in_executor(None, _sanitize_camera_url, url, allowed_schemes)


def list_usb_cameras() -> list[dict]:
    """List available USB cameras (V4L2 devices on Linux).

    Returns:
        List of dicts with {device: str, name: str, capabilities: list}
    """
    cameras = []
    video_devices = sorted(Path("/dev").glob("video*"))

    for device in video_devices:
        device_path = str(device)
        info = {"device": device_path, "name": device.name, "capabilities": []}

        # Try to get device info via v4l2-ctl
        v4l2_ctl = shutil.which("v4l2-ctl")
        if v4l2_ctl:
            try:
                result = subprocess.run(
                    [v4l2_ctl, "-d", device_path, "--info"],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                if result.returncode == 0:
                    # Parse device name from output
                    for line in result.stdout.splitlines():
                        if "Card type" in line:
                            info["name"] = line.split(":", 1)[1].strip()
                        elif "Driver name" in line:
                            info["driver"] = line.split(":", 1)[1].strip()

                    # Check if device supports video capture
                    result = subprocess.run(
                        [v4l2_ctl, "-d", device_path, "--list-formats"],
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                    if result.returncode == 0 and result.stdout.strip():
                        info["capabilities"].append("capture")
                        # Parse available formats
                        formats = re.findall(r"'(\w+)'", result.stdout)
                        info["formats"] = list(set(formats))

            except (subprocess.TimeoutExpired, Exception) as e:
                logger.debug("v4l2-ctl failed for %s: %s", device_path, e)

        # Only include devices that look like video capture devices
        # Skip metadata devices (typically odd numbered like video1, video3)
        try:
            device_num = int(device.name.replace("video", ""))
            # Even numbered devices are usually capture, odd are metadata
            # But also check if we got capabilities
            if info.get("capabilities") or device_num % 2 == 0:
                cameras.append(info)
        except ValueError:
            cameras.append(info)

    return cameras


def _validate_usb_device(device: str) -> str | None:
    """Validate USB device path is /dev/videoN (N=0-99) and exists.

    Returns the safe device path string, or None if invalid.
    """
    device_match = re.match(r"^/dev/video(\d{1,2})$", device)
    if not device_match:
        logger.error("Invalid USB device path format: %s", device)
        return None

    device_num = int(device_match.group(1))
    if device_num > 99:
        logger.error("USB device number out of range: %s", device_num)
        return None

    safe_device_path = Path(f"/dev/video{device_num}")
    if not safe_device_path.exists():
        logger.error("USB device does not exist: %s", safe_device_path)
        return None

    return str(safe_device_path)


async def capture_frame(
    url: str,
    camera_type: str,
    timeout: int = 15,
    snapshot_url: str | None = None,
) -> bytes | None:
    """Capture single frame from external camera.

    Args:
        url: Live-stream URL (MJPEG stream, RTSP URL, HTTP snapshot URL, or USB device path).
        camera_type: "mjpeg", "rtsp", "snapshot", or "usb".
        timeout: Connection timeout in seconds.
        snapshot_url: Optional override for single-frame capture. When set, fetched
            via plain HTTP GET regardless of `camera_type`. Bypasses MJPEG warm-up
            handling on sources that expose a dedicated frame endpoint (e.g. go2rtc's
            `/api/frame.jpeg` reliably returns a clean image while the MJPEG stream's
            first frame is often the encoder's stale keyframe). #1177.

    Returns:
        JPEG bytes or None on failure
    """
    if snapshot_url:
        logger.debug("capture_frame using snapshot override url=%s...", snapshot_url[:50])
        return await _capture_snapshot(snapshot_url, timeout)
    logger.debug("capture_frame called: type=%s, url=%s...", camera_type, url[:50] if url else "None")
    if camera_type == "mjpeg":
        return await _capture_mjpeg_frame(url, timeout)
    elif camera_type == "rtsp":
        return await _capture_rtsp_frame(url, timeout)
    elif camera_type == "snapshot":
        return await _capture_snapshot(url, timeout)
    elif camera_type == "usb":
        return await _capture_usb_frame(url, timeout)
    else:
        logger.warning("Unknown camera type: %s", camera_type)
        return None


async def _capture_usb_frame(device: str, timeout: int) -> bytes | None:
    """Capture frame from USB camera using ffmpeg."""
    ffmpeg = get_ffmpeg_path()
    if not ffmpeg:
        logger.error("ffmpeg not found - required for USB camera capture")
        return None

    safe_device = _validate_usb_device(device)
    if not safe_device:
        return None
    device = safe_device

    # Use ffmpeg to grab a single frame from USB camera
    cmd = [
        ffmpeg,
        "-f",
        "v4l2",
        "-i",
        device,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-q:v",
        "2",
        "-",
    ]

    process = None
    try:
        logger.debug("Running USB capture: %s", " ".join(cmd))
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)

        if process.returncode != 0:
            logger.error("ffmpeg USB capture failed: %s", stderr.decode()[:200])
            return None

        if not stdout or len(stdout) < 100:
            logger.error("ffmpeg returned empty or too small frame from USB camera")
            return None

        return stdout

    except TimeoutError:
        logger.warning("USB frame capture timed out after %ss", timeout)
        if process:
            process.kill()
            await process.wait()
        return None
    except OSError as e:
        logger.error("USB frame capture failed: %s", e)
        return None


async def _capture_mjpeg_frame(url: str, timeout: int) -> bytes | None:
    """Extract a single representative frame from an MJPEG stream.

    Many MJPEG sources — go2rtc most notably (#1177), and several IP cameras —
    emit a "warm-up" frame on the byte that follows connection accept: usually
    the last keyframe held in the encoder, which is often black or stale until
    the encoder catches up to live content. To return a frame that's actually
    representative of the scene we read past the first frame and return the
    second; if the connection closes / times out / hits the buffer cap before
    a second frame ever arrives we fall back to the first so callers still
    get *something* (better than degrading slow / single-frame streams to None,
    which would regress every code path that consumed pre-fix behaviour).

    Note: this function intentionally makes requests to user-configured URLs.
    External camera support requires connecting to user-specified camera
    endpoints. URL is sanitized and dangerous destinations are blocked.
    """
    # Sanitize URL - returns reconstructed URL from validated components
    safe_url = await _sanitize_camera_url_async(url, ("http", "https"))
    if not safe_url:
        logger.error("Invalid MJPEG URL format: %s...", url[:50])
        return None

    jpeg_start = b"\xff\xd8"
    jpeg_end = b"\xff\xd9"
    first_frame: bytes | None = None  # warm-up frame; fallback if no second arrives
    buffer = b""

    try:
        async with (
            aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as session,
            session.get(safe_url, allow_redirects=False) as response,
        ):
            if response.status != 200:
                logger.error("MJPEG stream returned status %s", response.status)
                return None

            async for chunk in response.content.iter_chunked(8192):
                buffer += chunk

                # A single chunk can carry multiple frames (e.g. high-FPS sources)
                # or a partial frame. Drain every complete frame we already have
                # before pulling the next chunk.
                while True:
                    start_idx = buffer.find(jpeg_start)
                    if start_idx == -1:
                        # No frame start yet — drop trailing garbage, keep waiting.
                        break
                    end_idx = buffer.find(jpeg_end, start_idx + 2)
                    if end_idx == -1:
                        # Partial frame; trim already-discarded prefix so the
                        # buffer stays bounded across long-running streams.
                        if start_idx > 0:
                            buffer = buffer[start_idx:]
                        break
                    frame = buffer[start_idx : end_idx + 2]
                    buffer = buffer[end_idx + 2 :]
                    if first_frame is None:
                        first_frame = frame  # warm-up; keep but don't return yet
                        continue
                    return frame  # representative second frame

                if len(buffer) > 5 * 1024 * 1024:  # 5MB limit
                    logger.warning("MJPEG buffer exceeded 5MB without finding frame")
                    break  # exit chunk loop, fall through to first_frame fallback

    except TimeoutError:
        logger.warning("MJPEG frame capture timed out after %ss", timeout)
    except (aiohttp.ClientError, OSError) as e:
        logger.error("MJPEG frame capture failed: %s", e)

    # Stream ended / timed out / buffer cap before a second frame arrived.
    # Return whatever warm-up frame we managed to read; better an iffy frame
    # than None for callers that need *some* image (snapshot UX, plate-detect
    # CV, finish photo). None only if no frame ever arrived at all.
    return first_frame


async def _capture_rtsp_frame(url: str, timeout: int) -> bytes | None:
    """Capture frame from RTSP using ffmpeg."""
    safe_url = await _sanitize_camera_url_async(url, ("rtsp", "rtsps"))
    if not safe_url:
        logger.error("Invalid RTSP URL rejected: %s...", url[:50])
        return None
    url = safe_url

    ffmpeg = get_ffmpeg_path()
    if not ffmpeg:
        logger.error("ffmpeg not found - required for RTSP capture")
        return None

    # If rtsps://, use TLS proxy
    proxy_server = None
    effective_url = url
    if url.lower().startswith("rtsps://"):
        try:
            from urllib.parse import urlparse

            from backend.app.services.camera import create_tls_proxy

            parsed = urlparse(url)
            target_port = parsed.port or 322
            proxy_port, proxy_server = await create_tls_proxy(parsed.hostname, target_port)
            userinfo = ""
            if parsed.username:
                userinfo = parsed.username
                if parsed.password:
                    userinfo += f":{parsed.password}"
                userinfo += "@"
            effective_url = f"rtsp://{userinfo}127.0.0.1:{proxy_port}{parsed.path}"
            if parsed.query:
                effective_url += f"?{parsed.query}"
        except Exception as e:
            logger.warning("Failed to create TLS proxy for RTSP capture, falling back: %s", e)
            effective_url = url

    cmd = [
        ffmpeg,
        "-rtsp_transport",
        "tcp",
        "-i",
        effective_url,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-q:v",
        "2",
        "-",
    ]

    process = None
    try:
        logger.debug("Running ffmpeg command: %s...", " ".join(cmd[:6]))
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
        logger.debug(
            "ffmpeg returned: code=%s, stdout=%s bytes, stderr=%s bytes",
            process.returncode,
            len(stdout),
            len(stderr),
        )

        if process.returncode != 0:
            logger.error("ffmpeg RTSP capture failed: %s", re.sub(r"://[^@]+@", "://***@", stderr.decode()[:200]))
            return None

        if not stdout or len(stdout) < 100:
            logger.error("ffmpeg returned empty or too small frame")
            return None

        return stdout

    except TimeoutError:
        logger.warning("RTSP frame capture timed out after %ss", timeout)
        if process:
            process.kill()
            await process.wait()
        return None
    except OSError as e:
        logger.error("RTSP frame capture failed: %s", e)
        return None
    finally:
        if proxy_server:
            proxy_server.close()
            await proxy_server.wait_closed()


async def _capture_snapshot(url: str, timeout: int, *, session: aiohttp.ClientSession | None = None) -> bytes | None:
    """Fetch snapshot from HTTP URL.

    Note: This function intentionally makes requests to user-configured URLs.
    External camera support requires connecting to user-specified camera endpoints.
    URL is sanitized and dangerous destinations are blocked.

    Args:
        session: Optional reusable session for connection pooling in polling loops.
    """
    # Sanitize URL - returns reconstructed URL from validated components
    safe_url = await _sanitize_camera_url_async(url, ("http", "https"))
    if not safe_url:
        logger.error("Invalid snapshot URL format: %s...", url[:50])
        return None

    try:
        if session is not None:
            async with session.get(
                safe_url, allow_redirects=False, timeout=aiohttp.ClientTimeout(total=timeout)
            ) as response:
                if response.status != 200:
                    logger.error("Snapshot URL returned status %s", response.status)
                    return None
                data = await response.content.read(5 * 1024 * 1024)
        else:
            async with (
                aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as sess,
                sess.get(safe_url, allow_redirects=False) as response,
            ):
                if response.status != 200:
                    logger.error("Snapshot URL returned status %s", response.status)
                    return None
                data = await response.content.read(5 * 1024 * 1024)

        # Validate it looks like JPEG
        if not data.startswith(b"\xff\xd8"):
            logger.warning("Snapshot does not appear to be JPEG")
            # Still return it - might be valid with different header

        return data

    except TimeoutError:
        logger.warning("Snapshot capture timed out after %ss", timeout)
        return None
    except (aiohttp.ClientError, OSError) as e:
        logger.error("Snapshot capture failed: %s", e)
        return None


async def test_connection(url: str, camera_type: str) -> dict:
    """Test camera connection.

    Returns:
        Dict with {success: bool, error?: str, resolution?: str}
    """
    logger.info("Testing camera connection: type=%s, url=%s...", camera_type, url[:50])
    try:
        frame = await capture_frame(url, camera_type, timeout=10)
        logger.info("Capture result: %s bytes", len(frame) if frame else 0)

        if frame:
            # Try to get resolution from JPEG header
            resolution = None
            try:
                # Simple JPEG dimension extraction
                # SOF0 marker is FF C0, followed by length, precision, height, width
                sof_markers = [b"\xff\xc0", b"\xff\xc1", b"\xff\xc2"]
                for marker in sof_markers:
                    idx = frame.find(marker)
                    if idx != -1 and idx + 9 <= len(frame):
                        height = (frame[idx + 5] << 8) | frame[idx + 6]
                        width = (frame[idx + 7] << 8) | frame[idx + 8]
                        resolution = f"{width}x{height}"
                        break
            except (IndexError, ValueError):
                pass  # Resolution detection is optional; fall back to default

            return {"success": True, "resolution": resolution}
        else:
            return {"success": False, "error": "Failed to capture frame from camera"}

    except Exception as e:
        # Sanitize error message - don't expose internal details
        error_type = type(e).__name__
        logger.error("Camera connection test failed: %s", e)
        return {"success": False, "error": f"Connection failed: {error_type}"}


async def generate_mjpeg_stream(
    url: str,
    camera_type: str,
    fps: int = 10,
    gpu_accel: bool = False,
    quality: int = 5,
    threads: int = 0,
) -> AsyncGenerator[bytes, None]:
    """Generator yielding MJPEG frames for streaming.

    Args:
        url: Camera URL or USB device path
        camera_type: "mjpeg", "rtsp", "snapshot", or "usb"
        fps: Target frames per second
        gpu_accel: Enable hardware-accelerated decoding (RTSP only)
        quality: MJPEG quality (lower = better, 2-31)
        threads: FFmpeg thread count (0 = auto)

    Yields:
        MJPEG frame data with HTTP multipart boundaries
    """
    frame_interval = 1.0 / max(fps, 1)
    last_frame_time = 0.0

    if camera_type == "mjpeg":
        # Proxy MJPEG stream directly, with reconnect on timeout
        max_retries = 3
        for attempt in range(max_retries + 1):
            frame_yielded = False
            async for frame in _stream_mjpeg(url):
                frame_yielded = True
                current_time = time.monotonic()
                if current_time - last_frame_time >= frame_interval:
                    last_frame_time = current_time
                    yield _format_mjpeg_header(len(frame))
                    yield frame
                    yield b"\r\n"
            if not frame_yielded or attempt == max_retries:
                break
            logger.warning(
                "External MJPEG stream ended, reconnecting (attempt %d/%d)...",
                attempt + 1,
                max_retries,
            )
            await asyncio.sleep(2)

    elif camera_type == "rtsp":
        # Use ffmpeg to convert RTSP to MJPEG, with reconnect on timeout
        max_retries = 3
        for attempt in range(max_retries + 1):
            frame_yielded = False
            async for frame in _stream_rtsp(url, fps, gpu_accel=gpu_accel, quality=quality, threads=threads):
                frame_yielded = True
                yield _format_mjpeg_header(len(frame))
                yield frame
                yield b"\r\n"
            if not frame_yielded or attempt == max_retries:
                break
            logger.warning(
                "External RTSP stream ended, reconnecting (attempt %d/%d)...",
                attempt + 1,
                max_retries,
            )
            await asyncio.sleep(2)

    elif camera_type == "usb":
        # Use ffmpeg to stream from USB camera
        async for frame in _stream_usb(url, fps, quality=quality, threads=threads):
            yield _format_mjpeg_header(len(frame))
            yield frame
            yield b"\r\n"

    elif camera_type == "snapshot":
        # Poll snapshot URL at interval — reuse a single session for connection pooling
        async with aiohttp.ClientSession() as session:
            while True:
                try:
                    frame = await _capture_snapshot(url, timeout=10, session=session)
                    if frame:
                        yield _format_mjpeg_header(len(frame))
                        yield frame
                        yield b"\r\n"
                    await asyncio.sleep(frame_interval)
                except asyncio.CancelledError:
                    break
                except (aiohttp.ClientError, OSError) as e:
                    logger.warning("Snapshot poll failed: %s", e)
                    await asyncio.sleep(frame_interval)


def _format_mjpeg_header(frame_len: int) -> bytes:
    """Format the MJPEG boundary header (without frame data)."""
    return b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(frame_len).encode() + b"\r\n\r\n"


async def _stream_mjpeg(url: str) -> AsyncGenerator[bytes, None]:
    """Stream frames from MJPEG URL.

    Note: This function intentionally makes requests to user-configured URLs.
    External camera support requires connecting to user-specified camera endpoints.
    URL is sanitized and dangerous destinations are blocked.
    """
    # Sanitize URL - returns reconstructed URL from validated components
    safe_url = await _sanitize_camera_url_async(url, ("http", "https"))
    if not safe_url:
        logger.error("Invalid MJPEG stream URL: %s...", url[:50])
        return

    try:
        timeout = aiohttp.ClientTimeout(total=None, sock_read=30)
        async with (
            aiohttp.ClientSession(timeout=timeout) as session,
            session.get(safe_url, allow_redirects=False) as response,
        ):
            if response.status != 200:
                logger.error("MJPEG stream returned status %s", response.status)
                return

            buffer = bytearray()
            jpeg_start = b"\xff\xd8"
            jpeg_end = b"\xff\xd9"

            async for chunk in response.content.iter_chunked(8192):
                buffer.extend(chunk)

                # Extract complete frames from buffer
                while True:
                    start_idx = buffer.find(jpeg_start)
                    if start_idx == -1:
                        if len(buffer) > 2:
                            del buffer[: len(buffer) - 2]
                        break

                    if start_idx > 0:
                        del buffer[:start_idx]

                    end_idx = buffer.find(jpeg_end, 2)
                    if end_idx == -1:
                        break

                    frame = bytes(buffer[: end_idx + 2])
                    del buffer[: end_idx + 2]
                    yield frame

    except asyncio.CancelledError:
        logger.info("MJPEG stream cancelled")
    except (aiohttp.ClientError, OSError) as e:
        logger.error("MJPEG stream error: %s", e)


async def _stream_rtsp(
    url: str, fps: int, *, gpu_accel: bool = False, quality: int = 5, threads: int = 0
) -> AsyncGenerator[bytes, None]:
    """Stream frames from RTSP URL via ffmpeg."""
    safe_url = await _sanitize_camera_url_async(url, ("rtsp", "rtsps"))
    if not safe_url:
        logger.error("Invalid RTSP URL rejected: %s...", url[:50])
        return
    url = safe_url

    ffmpeg = get_ffmpeg_path()
    if not ffmpeg:
        logger.error("ffmpeg not found - required for RTSP streaming")
        return

    from backend.app.services.camera import rtsp_socket_timeout_flag

    # If the URL uses rtsps://, set up a TLS proxy so ffmpeg uses plain rtsp://
    proxy_server = None
    effective_url = url
    if url.lower().startswith("rtsps://"):
        try:
            from urllib.parse import urlparse

            from backend.app.services.camera import create_tls_proxy

            parsed = urlparse(url)
            target_port = parsed.port or 322
            proxy_port, proxy_server = await create_tls_proxy(parsed.hostname, target_port)
            # Rewrite URL: rtsps://user:pass@host:port/path -> rtsp://user:pass@127.0.0.1:proxy/path
            userinfo = ""
            if parsed.username:
                userinfo = parsed.username
                if parsed.password:
                    userinfo += f":{parsed.password}"
                userinfo += "@"
            effective_url = f"rtsp://{userinfo}127.0.0.1:{proxy_port}{parsed.path}"
            if parsed.query:
                effective_url += f"?{parsed.query}"
        except Exception as e:
            logger.warning("Failed to create TLS proxy for RTSP, falling back to direct: %s", e)
            effective_url = url

    cmd = [ffmpeg]
    if gpu_accel:
        cmd.extend(["-hwaccel", "auto"])
    cmd.extend(
        [
            "-rtsp_transport",
            "tcp",
            "-rtsp_flags",
            "prefer_tcp",
            # Socket I/O timeout name varies by ffmpeg version (#1504); see
            # `rtsp_socket_timeout_flag()` in services.camera.
            f"-{rtsp_socket_timeout_flag()}",
            "30000000",
            "-buffer_size",
            "1024000",
            "-max_delay",
            "500000",
            "-probesize",
            "32",
            "-analyzeduration",
            "0",
            "-fflags",
            "nobuffer",
            "-flags",
            "low_delay",
            "-i",
            effective_url,
            "-f",
            "mjpeg",
            "-q:v",
            str(quality),
            "-r",
            str(fps),
            "-an",
        ]
    )
    if threads > 0:
        cmd.extend(["-threads", str(threads)])
    cmd.append("-")

    semaphore = get_rtsp_semaphore()
    process = None

    # Acquire semaphore only for process creation + liveness check
    logger.debug("External RTSP: waiting for semaphore")
    async with semaphore:
        logger.debug("External RTSP: acquired semaphore")
        try:
            kwargs: dict = {}
            if sys.platform == "win32":
                kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                **kwargs,
            )

            # Give ffmpeg a moment to start and check for immediate failures
            await asyncio.sleep(0.5)
            if process.returncode is not None:
                stderr = await process.stderr.read()
                logger.error(
                    "ffmpeg RTSP stream failed immediately: %s", re.sub(r"://[^@]+@", "://***@", stderr.decode()[:300])
                )
                return
        except OSError as e:
            logger.error("RTSP stream error: %s", e)
            return

    # Semaphore released — streaming loop runs without holding it
    try:
        buffer = bytearray()
        jpeg_start = b"\xff\xd8"
        jpeg_end = b"\xff\xd9"

        while True:
            try:
                chunk = await asyncio.wait_for(process.stdout.read(65536), timeout=30.0)

                if not chunk:
                    break

                buffer.extend(chunk)

                # Extract complete frames
                while True:
                    start_idx = buffer.find(jpeg_start)
                    if start_idx == -1:
                        if len(buffer) > 2:
                            del buffer[: len(buffer) - 2]
                        break

                    if start_idx > 0:
                        del buffer[:start_idx]

                    end_idx = buffer.find(jpeg_end, 2)
                    if end_idx == -1:
                        break

                    frame = bytes(buffer[: end_idx + 2])
                    del buffer[: end_idx + 2]
                    yield frame

            except TimeoutError:
                logger.warning("RTSP stream read timeout")
                break

    except asyncio.CancelledError:
        logger.info("RTSP stream cancelled")
    except OSError as e:
        logger.error("RTSP stream error: %s", e)
    finally:
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=2.0)
            except TimeoutError:
                process.kill()
                await process.wait()
        if proxy_server:
            proxy_server.close()
            await proxy_server.wait_closed()


async def _stream_usb(device: str, fps: int, *, quality: int = 5, threads: int = 0) -> AsyncGenerator[bytes, None]:
    """Stream frames from USB camera via ffmpeg."""
    ffmpeg = get_ffmpeg_path()
    if not ffmpeg:
        logger.error("ffmpeg not found - required for USB camera streaming")
        return

    safe_device = _validate_usb_device(device)
    if not safe_device:
        return
    device = safe_device

    # ffmpeg command to stream from USB camera (v4l2)
    cmd = [
        ffmpeg,
        "-f",
        "v4l2",
        "-framerate",
        str(fps),
        "-i",
        device,
        "-f",
        "mjpeg",
        "-q:v",
        str(quality),
        "-r",
        str(fps),
    ]
    if threads > 0:
        cmd.extend(["-threads", str(threads)])
    cmd.append("-")

    process = None
    try:
        logger.info("Starting USB camera stream from %s at %s fps", device, fps)
        kwargs: dict = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **kwargs,
        )

        # Give ffmpeg a moment to start and check for immediate failures
        await asyncio.sleep(0.5)
        if process.returncode is not None:
            stderr = await process.stderr.read()
            logger.error("ffmpeg USB stream failed immediately: %s", stderr.decode()[:300])
            return

        buffer = bytearray()
        jpeg_start = b"\xff\xd8"
        jpeg_end = b"\xff\xd9"

        while True:
            try:
                chunk = await asyncio.wait_for(process.stdout.read(65536), timeout=30.0)

                if not chunk:
                    break

                buffer.extend(chunk)

                # Extract complete frames
                while True:
                    start_idx = buffer.find(jpeg_start)
                    if start_idx == -1:
                        if len(buffer) > 2:
                            del buffer[: len(buffer) - 2]
                        break

                    if start_idx > 0:
                        del buffer[:start_idx]

                    end_idx = buffer.find(jpeg_end, 2)
                    if end_idx == -1:
                        break

                    frame = bytes(buffer[: end_idx + 2])
                    del buffer[: end_idx + 2]
                    yield frame

            except TimeoutError:
                logger.warning("USB stream read timeout")
                break

    except asyncio.CancelledError:
        logger.info("USB stream cancelled")
    except OSError as e:
        logger.error("USB stream error: %s", e)
    finally:
        if process and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=2.0)
            except TimeoutError:
                process.kill()
                await process.wait()
