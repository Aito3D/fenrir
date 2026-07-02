"""go2rtc process management and API client.

go2rtc is an optional camera streaming engine that relays RTSP H.264
directly to browsers via WebRTC — zero transcoding, sub-second latency,
hardware-decoded in the browser.
"""

import asyncio
import logging
import shutil
import time
from pathlib import Path

import httpx

from backend.app.core.config import settings

logger = logging.getLogger(__name__)

# go2rtc API defaults
_GO2RTC_API_PORT = 1984
_GO2RTC_STARTUP_TIMEOUT = 10.0  # seconds to wait for API readiness

# Watchdog constants
_WATCHDOG_MAX_RESTARTS = 5
_WATCHDOG_STABLE_PERIOD = 60.0  # seconds — reset restart counter if process ran this long
_WATCHDOG_BASE_DELAY = 2.0
_WATCHDOG_MAX_DELAY = 30.0


class Go2RTCService:
    """Manages a go2rtc subprocess and communicates with its HTTP API."""

    def __init__(self) -> None:
        self._process: asyncio.subprocess.Process | None = None
        self._config_dir: Path | None = None
        self._client: httpx.AsyncClient | None = None
        self._drain_task: asyncio.Task | None = None
        self._binary_path: str | None = None
        self._watchdog_task: asyncio.Task | None = None
        self._restart_count: int = 0
        self._intentional_stop: bool = False
        self._api_ready: bool = False

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.returncode is None

    @property
    def ready(self) -> bool:
        """True when the go2rtc process is running AND its HTTP API is accepting requests."""
        return self.running and self._api_ready

    @property
    def api_url(self) -> str:
        return f"http://127.0.0.1:{_GO2RTC_API_PORT}"

    def _find_binary(self) -> str | None:
        """Find go2rtc binary on the system."""
        path = shutil.which("go2rtc")
        if path:
            return path
        for candidate in ["/usr/local/bin/go2rtc", "/usr/bin/go2rtc"]:
            if Path(candidate).is_file():
                return candidate
        return None

    async def start(self) -> None:
        """Start the go2rtc subprocess with a minimal config."""
        if self.running:
            logger.info("go2rtc already running")
            return

        binary = self._find_binary()
        if not binary:
            logger.warning("go2rtc binary not found, cannot start")
            return

        self._binary_path = binary

        # Write minimal YAML config to a persistent directory (temp dirs on
        # macOS get cleaned up by the OS while go2rtc is still running).
        self._config_dir = settings.base_dir / "data" / ".go2rtc"
        self._config_dir.mkdir(parents=True, exist_ok=True)
        config_path = self._config_dir / "go2rtc.yaml"
        config_path.write_text(
            f'api:\n  listen: "127.0.0.1:{_GO2RTC_API_PORT}"\nwebrtc:\n  listen: ":8555"\n  ice_servers: []\n'
        )

        logger.info("Starting go2rtc: %s -config %s", binary, config_path)
        self._process = await asyncio.create_subprocess_exec(
            binary,
            "-config",
            str(config_path),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )

        # Drain stderr to prevent pipe deadlock
        self._drain_task = asyncio.create_task(self._drain_stderr())

        # Wait for API readiness in background so app lifespan isn't blocked
        self._client = httpx.AsyncClient(base_url=self.api_url, timeout=5.0)
        asyncio.create_task(self._wait_for_ready())

    async def _wait_for_ready(self) -> None:
        """Poll go2rtc API readiness in the background."""
        ready = False
        for _ in range(int(_GO2RTC_STARTUP_TIMEOUT)):
            if self._process is None or self._process.returncode is not None:
                logger.error(
                    "go2rtc exited during startup (code=%s)", self._process.returncode if self._process else "?"
                )
                break
            try:
                resp = await self._client.get("/api")
                if resp.status_code == 200:
                    ready = True
                    break
            except (httpx.ConnectError, httpx.ReadError):
                pass
            await asyncio.sleep(1.0)

        if ready:
            logger.info("go2rtc started successfully (pid=%s)", self._process.pid if self._process else "?")
            self._api_ready = True
            self._intentional_stop = False
            self._watchdog_task = asyncio.create_task(self._watchdog())
        else:
            logger.error("go2rtc failed to become ready within %ss", _GO2RTC_STARTUP_TIMEOUT)
            await self.stop()

    async def stop(self) -> None:
        """Terminate the go2rtc process and clean up."""
        self._intentional_stop = True
        self._api_ready = False

        if self._watchdog_task and not self._watchdog_task.done():
            self._watchdog_task.cancel()
            try:
                await self._watchdog_task
            except asyncio.CancelledError:
                pass
            self._watchdog_task = None
        self._restart_count = 0

        if self._client:
            await self._client.aclose()
            self._client = None

        if self._drain_task and not self._drain_task.done():
            self._drain_task.cancel()
            try:
                await self._drain_task
            except asyncio.CancelledError:
                pass
            self._drain_task = None

        if self._process and self._process.returncode is None:
            logger.info("Stopping go2rtc (pid=%s)", self._process.pid)
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5.0)
            except TimeoutError:
                self._process.kill()
                await self._process.wait()
            logger.info("go2rtc stopped")

        self._process = None

        if self._config_dir:
            try:
                shutil.rmtree(self._config_dir, ignore_errors=True)
            except Exception:
                pass
            self._config_dir = None

    async def ensure_stream(self, printer_id: int, rtsp_url: str) -> bool:
        """Register an RTSP source with go2rtc via its API.

        Returns True if the stream was registered successfully.
        """
        if not self.ready or not self._client:
            return False

        stream_name = f"printer_{printer_id}"
        try:
            resp = await self._client.put(
                "/api/streams",
                params={"name": stream_name, "src": rtsp_url},
            )
            if resp.status_code in (200, 201):
                logger.debug("go2rtc stream registered: %s", stream_name)
                return True
            logger.warning("go2rtc stream registration failed: %s %s", resp.status_code, resp.text)
            return False
        except httpx.HTTPError as e:
            logger.warning("go2rtc API error (ensure_stream): %s", e)
            return False

    async def remove_stream(self, printer_id: int) -> None:
        """Remove a stream from go2rtc."""
        if not self.ready or not self._client:
            return

        stream_name = f"printer_{printer_id}"
        try:
            await self._client.delete("/api/streams", params={"name": stream_name})
            logger.debug("go2rtc stream removed: %s", stream_name)
        except httpx.HTTPError as e:
            logger.debug("go2rtc stream removal failed: %s", e)

    async def webrtc_offer(self, stream_name: str, sdp_offer: str) -> dict | None:
        """Send a WebRTC SDP offer to go2rtc and return the answer.

        Returns {"sdp": str, "type": "answer"} or None on failure.
        """
        if not self.ready or not self._client:
            return None

        try:
            resp = await self._client.post(
                "/api/webrtc",
                params={"src": stream_name},
                json={"type": "offer", "sdp": sdp_offer},
            )
            if resp.status_code == 200:
                return resp.json()
            logger.warning("go2rtc WebRTC offer failed: %s %s", resp.status_code, resp.text)
            return None
        except httpx.HTTPError as e:
            logger.warning("go2rtc API error (webrtc_offer): %s", e)
            return None

    async def _watchdog(self) -> None:
        """Monitor the go2rtc process and auto-restart on unexpected exit."""
        if not self._process:
            return
        start_time = time.monotonic()
        try:
            await self._process.wait()
        except asyncio.CancelledError:
            return

        if self._intentional_stop:
            return

        uptime = time.monotonic() - start_time
        exit_code = self._process.returncode
        logger.warning("go2rtc exited unexpectedly (code=%s, uptime=%.1fs)", exit_code, uptime)

        # If the process was healthy for a while, reset the rapid-restart counter
        if uptime >= _WATCHDOG_STABLE_PERIOD:
            self._restart_count = 0

        if self._restart_count >= _WATCHDOG_MAX_RESTARTS:
            logger.critical(
                "go2rtc has crashed %d times without stabilising — giving up auto-restart",
                _WATCHDOG_MAX_RESTARTS,
            )
            return

        self._restart_count += 1
        delay = min(_WATCHDOG_BASE_DELAY * (2 ** (self._restart_count - 1)), _WATCHDOG_MAX_DELAY)
        logger.info("Restarting go2rtc in %.1fs (attempt %d/%d)", delay, self._restart_count, _WATCHDOG_MAX_RESTARTS)

        # Clean up dead state before restart
        self._api_ready = False
        self._process = None
        if self._client:
            await self._client.aclose()
            self._client = None
        if self._config_dir:
            try:
                shutil.rmtree(self._config_dir, ignore_errors=True)
            except Exception:
                pass
            self._config_dir = None

        await asyncio.sleep(delay)
        if not self._intentional_stop:
            await self.start()

    async def _drain_stderr(self) -> None:
        """Read stderr in background to prevent pipe buffer deadlock."""
        if not self._process or not self._process.stderr:
            return
        try:
            while True:
                line = await self._process.stderr.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace").rstrip()
                if text:
                    lower = text.lower()
                    if any(kw in lower for kw in ("error", "fatal", "failed")):
                        logger.warning("go2rtc: %s", text)
                    else:
                        logger.debug("go2rtc: %s", text)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.debug("go2rtc stderr drain error: %s", e)


# Singleton instance
go2rtc_service = Go2RTCService()
