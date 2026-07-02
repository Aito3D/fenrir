# Camera Grid Feature — Complete Implementation Reference

This document describes every aspect of the Camera Grid feature added in the `printers-camera-grid` branch. It is written so that an agent could recreate the entire feature from scratch.

---

## Table of Contents

1. [Feature Overview](#feature-overview)
2. [Architecture Diagram](#architecture-diagram)
3. [Backend: Streaming Protocols](#backend-streaming-protocols)
4. [Backend: TLS Proxy](#backend-tls-proxy)
5. [Backend: FFmpeg MJPEG Stream Generator](#backend-ffmpeg-mjpeg-stream-generator)
6. [Backend: SharedStreamHub](#backend-sharedstreamhub)
7. [Backend: Grid Stream Endpoint](#backend-grid-stream-endpoint)
8. [Backend: Single Camera Stream Endpoint](#backend-single-camera-stream-endpoint)
9. [Backend: WebRTC / go2rtc Engine](#backend-webrtc--go2rtc-engine)
10. [Backend: CPU Watchdog System](#backend-cpu-watchdog-system)
11. [Backend: Quality Presets and Auto-Quality](#backend-quality-presets-and-auto-quality)
12. [Backend: Stream Token Authentication](#backend-stream-token-authentication)
13. [Backend: Settings and Configuration](#backend-settings-and-configuration)
14. [Backend: External Camera Service](#backend-external-camera-service)
15. [Backend: Startup/Shutdown Lifecycle](#backend-startupshutdown-lifecycle)
16. [Backend: Debug and Monitoring Endpoints](#backend-debug-and-monitoring-endpoints)
17. [Frontend: Architecture Overview](#frontend-architecture-overview)
18. [Frontend: CameraGrid Component](#frontend-cameragrid-component)
19. [Frontend: CameraGridCard Display](#frontend-cameragridcard-display)
20. [Frontend: Grid Layout System](#frontend-grid-layout-system)
21. [Frontend: useGridStream Hook (MJPEG Multiplexed)](#frontend-usegridstream-hook)
22. [Frontend: Web Worker Decoder](#frontend-web-worker-decoder)
23. [Frontend: useWebRTCStream Hook](#frontend-usewebrtcstream-hook)
24. [Frontend: Reconnect Logic](#frontend-reconnect-logic)
25. [Frontend: EmbeddedCameraViewer (Floating Overlay)](#frontend-embeddedcameraviewer)
26. [Frontend: CameraPage (Full-Page View)](#frontend-camerapage)
27. [Frontend: Zoom and Pan](#frontend-zoom-and-pan)
28. [Frontend: Camera Control Hooks](#frontend-camera-control-hooks)
29. [Frontend: Stream Buffer Utility](#frontend-stream-buffer-utility)
30. [Frontend: Stream Constants](#frontend-stream-constants)
31. [Frontend: i18n Keys](#frontend-i18n-keys)
32. [Frontend: PrintersPage Integration](#frontend-printerspage-integration)
33. [Frontend: Settings Page Integration](#frontend-settings-page-integration)
34. [API Client Additions](#api-client-additions)
35. [Test Coverage](#test-coverage)
36. [Files Reference](#files-reference)

---

## Feature Overview

The Camera Grid is a real-time multi-camera monitoring system embedded in the Printers page. It lets users view all printer cameras simultaneously in a responsive grid layout with live status overlays, print controls, and HMS error notifications.

Key capabilities:
- **Multiplexed MJPEG streaming**: All cameras over a single HTTP connection with binary framing, decoded off-thread in a Web Worker
- **WebRTC streaming**: Per-printer zero-transcode H.264 relay via go2rtc (for RTSP-capable models)
- **Shared stream hub**: One FFmpeg process per camera regardless of viewer count
- **Three grid layouts**: Compact (6 cols), Default (5 cols), Large (4 cols) — all responsive
- **Live overlays**: Printer name, print progress, ETA, layer count, HMS errors, pause/stop/resume controls
- **Hardware-aware auto-quality**: Probes CPU, RAM, GPU to select optimal quality preset
- **CPU watchdog**: Per-process and fleet-level CPU monitoring with automatic kill and circuit breaker
- **Reconnection**: Exponential backoff with countdown UI, stale/degraded/error visual states
- **IntersectionObserver**: Off-screen cameras skip JPEG decoding entirely
- **Worker health monitoring**: Detects stalled Web Workers and auto-restarts them

---

## Architecture Diagram

```
PrintersPage
  └── CameraGrid (orchestrator: splits printers by engine, manages stats/mutations)
        ├── [MJPEG path] useGridStream
        │     ├── fetch(GET /printers/camera/grid-stream?ids=1,2,3)
        │     │     └── Binary framed: [4B printer_id][4B jpeg_len][jpeg_data]...
        │     ├── useGridReconnect (exponential backoff, countdown)
        │     ├── GrowingBuffer (256KB→10MB ring buffer)
        │     └── cameraGridDecoder.worker.ts
        │           └── createImageBitmap() → transfer ImageBitmap to main thread
        │
        ├── [WebRTC path] WebRTCGridCard (one per RTSP-capable printer)
        │     └── useWebRTCStream
        │           ├── RTCPeerConnection (ICE-lite, no STUN/TURN)
        │           ├── POST /printers/{id}/camera/webrtc (SDP offer/answer via go2rtc)
        │           └── requestVideoFrameCallback / polling frame monitor
        │
        └── CameraGridCard (pure display: canvas/video, overlays, controls)
              └── IntersectionObserver → visibility messages to worker

Backend:
  SharedStreamHub (one ffmpeg per camera, N viewers)
    └── _run_producer() → ffmpeg subprocess → JPEG frame extraction
          ├── generate_rtsp_mjpeg_stream() [RTSP models via TLS proxy]
          └── generate_chamber_image_stream() [Chamber models via binary TCP]
  go2rtc subprocess → WebRTC SDP proxy
  CPU Watchdog (10s interval) → per-process + fleet circuit breaker
```

---

## Backend: Streaming Protocols

**File:** `backend/app/services/camera.py`

Bambu Lab printers use two distinct camera protocols, determined by printer model:

### RTSP Models (port 322, RTSPS with self-signed cert)
Models: X1, X1C, X1E, H2C, H2D, H2DPRO, H2S, P2S — also matched by firmware codes BL-P001, C13, O1D, O1C, O1C2, O1S, O1E, O2D, N7.

Function `supports_rtsp(model)` returns `True` for these.

RTSP URL format: `rtsps://{username}:{access_code}@{ip}:322/streaming/live/1`

### Chamber Image Models (port 6000, custom binary TCP over TLS)
Models: A1, A1MINI, P1P, P1S — everything that is NOT an RTSP model.

Function `is_chamber_image_model(model)` is `not supports_rtsp(model)`.

**Chamber Image Authentication Payload** (80 bytes):
```
Bytes 0-3:   magic 0x40 0x00 0x00 0x00
Bytes 4-7:   command 0x00 0x30 0x00 0x00 (little-endian 0x3000)
Bytes 8-15:  zeros (padding)
Bytes 16-47: username "bblp" padded to 32 bytes
Bytes 48-79: access code padded to 32 bytes
```

**Chamber Frame Reading** (`read_next_chamber_frame`):
1. Read exactly 16-byte header
2. Parse `payload_size` as LE uint32 from bytes 0-3
3. Validate 0 < size <= 10MB
4. Read exactly `payload_size` bytes (raw JPEG)
5. `IncompleteReadError` → `ChamberConnectionClosed` (TCP dropped)
6. `TimeoutError` → return None (caller retries up to 3 times)

---

## Backend: TLS Proxy

**File:** `backend/app/services/camera.py` (function `create_tls_proxy`)

**Problem:** Bambu printers use RTSPS with self-signed certs. Debian's ffmpeg uses GnuTLS which rejects TLS renegotiation that some printer firmwares rely on, causing streams to drop after seconds.

**Solution:** A local Python `asyncio.start_server` proxy on `127.0.0.1:0` (random ephemeral port). It terminates TLS using Python's `ssl` module (OpenSSL, more permissive) and exposes plain TCP. FFmpeg connects with `rtsp://` to the proxy port.

**RTSP URL rewriting:** Rewrites only RTSP request-line URLs from `rtsp://127.0.0.1:<proxy_port>` to `rtsps://<target>:<port>` so the printer recognizes the stream path. Does NOT touch Authorization headers (which embed Digest hashes of the original URL).

Returns `(local_port, server)`. Caller must close the server when done.

---

## Backend: FFmpeg MJPEG Stream Generator

**File:** `backend/app/api/routes/camera.py` (function `generate_rtsp_mjpeg_stream`)

Core ffmpeg subprocess launcher. Returns an async generator yielding JPEG frame bytes.

### FFmpeg Flags (built dynamically)

| Flag | Value | Purpose |
|------|-------|---------|
| `-rtsp_transport tcp` | | Forces TCP for reliability |
| `-rtsp_flags prefer_tcp` | | Prefer TCP interleaving |
| `-timeout` | 30000000 | 30s I/O timeout (microseconds) |
| `-buffer_size` | 1024000 | 1MB network buffer |
| `-max_delay` | 500000 | 0.5s max demux delay |
| `-fflags` | +discardcorrupt | Drop corrupt packets at demuxer |
| `-probesize` | 2097152 | 2MB probe phase cap |
| `-analyzeduration` | 2000000 | 2s analysis cap |
| `-ec` | 0 | Disable H.264 error concealment (prevents CPU spikes) |
| `-err_detect` | +crccheck+bitstream+buffer | Detect corruption without promoting to fatal |
| `-threads` | 1 | Single-threaded decode (~20-30% CPU at 1080p30) |

### `skip_frames` Mode (Grid View)

Activated when: `mode == "grid"` AND `stream_count >= 4` AND `preset in ("low", "medium")`

Adds `-skip_frame nokey` — only decodes I-frames (keyframes). Reduces CPU by ~80-90%. Keyframes arrive every 1-2 seconds. NOT used with VAAPI (hardware decoders ignore it).

### VAAPI GPU Path (Linux only)

When `gpu_accel=True` and VAAPI detected:
- Flags: `-hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi`
- Scale: `scale_vaapi=w=iw*{scale}:h=ih*{scale}` (GPU downscaling)
- If `mjpeg_vaapi` encoder available: full GPU pipeline
- If not: `hwdownload,format=nv12` to move frames back to CPU

### Filter Chain Ordering

Without VAAPI: `fps=N` goes BEFORE `scale=iw*S:ih*S`. This drops decoded frames early so scale only runs at target FPS (~5fps for grid) instead of all 30 decoded frames — ~6x CPU reduction.

### Frame Extraction from stdout

Accumulates stdout chunks in a `bytearray`. Searches for JPEG markers:
- Start: `\xff\xd8` (SOI)
- End: `\xff\xd9` (EOI)
- Buffer limit: 3MB (`_RTSP_BUFFER_LIMIT`)
- Frame watchdog: if data flows but no complete JPEG for 15s (30s in skip_frames mode), kills stream

### Process Lifecycle

- Runs under `nice -n 10` on non-Windows
- Acquires `_rtsp_semaphore` (max 20) only for process creation, releases before streaming loop
- Records PID in `_state.spawned_ffmpeg_pids` with spawn timestamp
- Cleanup (`finally`): SIGTERM → wait 2s → SIGKILL if not dead → wait 5s

---

## Backend: SharedStreamHub

**File:** `backend/app/api/routes/camera.py`

The central architectural innovation: **one ffmpeg process serves all viewers of the same camera**.

### `_SharedStream` (dataclass with `__slots__`)

| Field | Type | Purpose |
|-------|------|---------|
| `frame` | `bytes \| None` | Current JPEG (written by producer, read by viewers without locks) |
| `frame_seq` | `int` | Monotonically increasing counter, incremented each frame |
| `frame_event` | `asyncio.Event` | Replaced each frame; old one is set to wake all viewers |
| `alive` | `bool` | False means producer stopped |
| `params_key` | `str` | e.g. `"5-15-0.5-0-True-False"` (fps-quality-scale-threads-gpu-skip) |
| `last_accessed` | `float` | Monotonic timestamp, updated by viewers |
| `viewer_count` | `int` | Approximate viewer count for logging |
| `last_frame_produced` | `float` | Used by stale producer detection |

### SharedStreamHub Methods

**`get_or_start(printer_id, starter_fn, params_key)`:**
1. Under lock: check if alive entry exists
2. Stale detection: if `frame_seq > 0` and no frame for 45s → mark dead, cancel task
3. If alive → touch `last_accessed`, return existing (ignores new `params_key`)
4. If dead → save old task, del from registry
5. Await old task up to 8s (so finally block terminates ffmpeg)
6. Re-acquire lock → create new `_SharedStream`, start producer task

**`restart(printer_id, starter_fn, params_key)`:**
1. Phase 1 (locked): if same params AND not stale → return existing; if stale with same params → replace; if different params → mark dead, cancel
2. Phase 2 (no lock): await old task
3. Phase 3 (locked): guard against concurrent creates → create new entry

**`_run_producer(printer_id, starter_fn, entry)` (background task):**
- Calls `starter_fn()` to get async generator
- Iterates frames: writes to `entry.frame`, increments `entry.frame_seq`
- Frame event signaling: replaces `entry.frame_event` with fresh Event, sets old one (all waiting viewers wake — no set/clear race)
- Idle timeout: if `last_accessed` older than 30s → mark dead and break
- `finally`: `alive = False`, nulls `frame`, closes generator, removes from `_streams` with identity check

**`make_viewer(entry, fps)` (async generator):**
- Increments `entry.viewer_count`
- Polls `frame_seq` vs `seen_seq`; when no new frame, awaits `frame_event.wait(timeout=frame_interval)`
- Per-viewer rate limiting: sleeps until `last_yield + frame_interval`
- Yields three chunks per frame: MJPEG boundary header, frame bytes, `\r\n`
- `finally`: decrements `viewer_count`

**`stop_all()`**: Cancels all producer tasks, awaits up to 5s each.

**`stop(printer_id)`**: Force-stops one producer. Used by settings changes.

---

## Backend: Grid Stream Endpoint

**Route:** `GET /api/v1/printers/camera/grid-stream`

**Auth:** `RequirePermissionIfAuthEnabled(Permission.CAMERA_VIEW)`

### Query Parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `ids` | string | required | Comma-separated printer IDs, max 500 chars |
| `fps` | int | from settings | Frames per second |
| `quality` | int | from settings | JPEG quality (lower = better) |
| `scale` | float | from settings | Resolution multiplier |
| `force` | bool | false | Force producers to restart if params changed |

### Binary Wire Format

Content-Type: `application/octet-stream`. Each frame has an 8-byte LE header:
```
[4 bytes: printer_id as uint32 LE][4 bytes: jpeg_length as uint32 LE][jpeg_data bytes]
```

The frontend reads this single stream and demuxes by printer_id to per-printer canvases.

### Startup Sequence

1. Parse and deduplicate printer IDs (max 30)
2. If no explicit params → resolve quality from DB settings → set `force=True`
3. `get_existing_batch()` — single-lock pass for already-running producers
4. If `force=True` on existing → `hub.restart()` if params differ
5. Missing producers: single DB query for all printers, staggered spawning with 0.15s delay (1.0s under load)

### Streaming Loop (`generate()`)

- Round-robin across all entries by printer_id
- `seen_seqs: dict[int, int]` tracks per-printer frame deduplication
- Per-printer rate limiting with staggered initial offsets
- Disconnect check: polls `request.is_disconnected()` at most once per second
- Dead producer detection: if `entry.alive = False` → schedule restart
- Stale detection: if `last_frame_produced` older than 30s → kill task, schedule restart
- `frame_event.wait()` across all entries when no new frames (avoids busy-polling)

### Restart System

- `pending_restarts: dict[int, tuple[attempt_count, next_retry_monotonic]]`
- Exponential backoff: `base_delay * 2^attempts`, capped at 20s, with 0-30% random jitter
- Budget: max 4 concurrent restarts per loop iteration
- After 8 failures: switches to slow-retry cadence (20s + jitter), never permanently gives up
- Fleet circuit breaker: during `fleet_cooldown_until`, all restarts are skipped
- Per-printer cooldown from watchdog kills
- Fresh DB session per restart (endpoint's session may be stale after hours)

### Stats Logging

Every 30s logs: total KB/s bandwidth, per-printer frame counts and average sizes, system load averages, circuit breaker status.

---

## Backend: Single Camera Stream Endpoint

**Route:** `GET /api/v1/printers/{printer_id}/camera/stream`

**Auth:** `RequireCameraStreamTokenIfAuthEnabled` — uses `?token=xxx` (short-lived JWT).

Reuses the shared hub via `_ensure_producer()` then `hub.make_viewer(entry, fps)`. Wraps with disconnect check polling every 1s.

For external cameras: calls `generate_mjpeg_stream()` from `external_camera.py`, capped at 15fps.

Response: `multipart/x-mixed-replace; boundary=frame` (standard MJPEG over HTTP).

---

## Backend: WebRTC / go2rtc Engine

### go2rtc Service

**File:** `backend/app/services/go2rtc.py`

`Go2RTCService` manages a go2rtc subprocess:

**Startup:**
- Writes YAML config to `{base_dir}/data/.go2rtc/go2rtc.yaml`
- Config: API on `127.0.0.1:1984`, WebRTC on `:8555`, no ICE servers
- Starts subprocess, drains stderr in background task
- Polls `GET /api` every second up to 10s for readiness

**Watchdog:**
- Awaits process exit
- If uptime >= 60s → resets restart count (stable)
- Exponential backoff: `2.0 * 2^(attempt-1)`, capped at 30s
- Max 5 restarts without stabilizing

**API Operations:**
- `ensure_stream(printer_id, rtsp_url)` → `PUT /api/streams?name=printer_{id}&src={url}`
- `remove_stream(printer_id)` → `DELETE /api/streams?name=printer_{id}`
- `webrtc_offer(stream_name, sdp_offer)` → `POST /api/webrtc?src=printer_{id}` with SDP offer, returns SDP answer

### WebRTC Endpoint

**Route:** `POST /api/v1/printers/{printer_id}/camera/webrtc`

**Request:** `{ "sdp": "<SDP offer string, max 16384 chars>" }`

**Flow:**
1. Check `go2rtc_service.ready` — 503 if not
2. Check `supports_rtsp(printer.model)` — 400 if chamber-image-only model
3. `ensure_stream(printer_id, rtsp_url)` — registers RTSPS URL with go2rtc
4. `webrtc_offer(f"printer_{printer_id}", sdp_offer)` — proxies SDP
5. Returns go2rtc's SDP answer

WebRTC provides H.264 directly to the browser (zero transcoding, sub-second latency, hardware-decoded in browser).

---

## Backend: CPU Watchdog System

**File:** `backend/app/api/routes/camera.py` (inside `_cleanup_stale_frame_buffers()`, runs every 10s or 5s under load)

### Per-Process Watchdog

- Reads CPU seconds for all tracked PIDs via `psutil.cpu_times()` (in thread pool)
- Grace period: first 10s after spawn (startup probe can be CPU-heavy)
- Kill threshold: 50% CPU per process
- On kill: `os.kill(pid, SIGKILL)`, records in `_state.watchdog_killed_printers`, sets per-printer cooldown (10s)

### Fleet-Level Watchdog

- Sums CPU% of all non-killed processes
- Threshold: `cpu_count * 50` (e.g., 200% on 4 cores)
- If exceeded: sorts by CPU% descending, kills worst offenders until below threshold
- Activates circuit breaker: `fleet_cooldown_until = now + 15s`
- Adaptive monitoring: if fleet > 50% of threshold → cleanup interval drops to 5s

---

## Backend: Quality Presets and Auto-Quality

### Preset Table

| Preset | Grid FPS | Grid Quality | Grid Scale | Single FPS | Single Quality | Single Scale | Threads |
|--------|----------|-------------|------------|------------|---------------|-------------|---------|
| low | 2 | 20 | 0.25 | 10 | 10 | 0.5 | 1 |
| medium | 5 | 15 | 0.5 | 15 | 5 | 1.0 | 0 |
| high | 10 | 5 | 0.75 | 30 | 2 | 1.0 | 0 |

FFmpeg `-q:v`: lower number = better JPEG quality. Scale is a multiplier on input resolution.

### Auto-Quality Resolution

**File:** `backend/app/services/camera.py` (function `resolve_camera_quality`)

Called with `preset_name="auto"` and `stream_count`. Returns `"low"`, `"medium"`, or `"high"`.

**Hardware Scoring:**
- CPU score: `sqrt(cpu_count) * core_efficiency` (Apple Silicon: 1.3x, ARM: 0.5x, x86: 1.0x)
- RAM score: `min(log2(max(ram_gb, 1)), 3.0)`
- GPU score by backend: VideoToolbox+Apple Silicon → 4.0, CUDA → 3.0, QSV → 2.5, VAAPI → 2.0, any GPU → 1.0, none → 0
- Base score: `(cpu_score + ram_score + gpu_score) * 2`

**Stream Penalty:** `penalty = 1 + (sqrt(stream_count) - 1) * gpu_penalty_factor`

**Effective Score Thresholds:**
- >= 12.0 → `"high"`
- >= 7.0 → `"medium"`
- < 7.0 → `"low"`

Hardware info is cached after first call.

### skip_frames Activation

```
skip_frames = (mode == "grid") and (stream_count >= 4) and (preset_name in ("low", "medium"))
```

---

## Backend: Stream Token Authentication

**Route:** `POST /api/v1/printers/camera/stream-token`

Requires `CAMERA_VIEW` permission. Returns a 60-minute JWT token usable as `?token=xxx` on stream and snapshot URLs.

**Purpose:** `<img src>` and `<video src>` tags cannot send `Authorization` headers. The token is appended as a query parameter.

`RequireCameraStreamTokenIfAuthEnabled` validates this token from the query parameter on stream and snapshot endpoints.

---

## Backend: Settings and Configuration

### DB-Persisted Settings (key-value in `settings` table)

| Key | Values | Description |
|-----|--------|-------------|
| `camera_quality` | `auto`, `low`, `medium`, `high` | Quality preset (resolved at stream time) |
| `camera_gpu_accel` | `true`, `false` | Enable `-hwaccel` flags |
| `camera_engine` | `ffmpeg`, `go2rtc` | Streaming engine selection |
| `capture_finish_photo` | `true`, `false` | End-of-print snapshots |
| `camera_view_mode` | `overlay`, `window` | Camera viewer style (overlay=embedded floating, window=new window) |

### Per-Printer Fields (Printer ORM model)

| Field | Type | Description |
|-------|------|-------------|
| `external_camera_url` | `str \| None` | External camera URL (credentials stripped in API responses) |
| `external_camera_type` | `str \| None` | `mjpeg`, `rtsp`, `snapshot`, `usb` |
| `external_camera_enabled` | `bool` | Gates all external camera paths |
| `camera_rotation` | `int` | 0/90/180/270 degrees for notification snapshots |

### Settings Update Side Effects

When `camera_quality`, `camera_gpu_accel`, or `camera_engine` changes:
1. `_hub.stop_all()` — forces all active streams to restart with new settings on next request
2. If engine changed to `go2rtc` → `go2rtc_service.start()`
3. If engine changed away from `go2rtc` → `go2rtc_service.stop()`

---

## Backend: External Camera Service

**File:** `backend/app/services/external_camera.py`

### URL Sanitization (`_sanitize_camera_url`)

- Validates scheme against allowlist
- Blocks cloud metadata services (169.254.169.254, GCP metadata)
- Blocks localhost/loopback
- Resolves hostnames to detect DNS rebinding attacks
- Replaces hostname with resolved IP in output

### Supported Types

| Type | Implementation |
|------|---------------|
| `mjpeg` | Direct HTTP/HTTPS stream via `aiohttp`, JPEG marker scanning |
| `rtsp` | FFmpeg subprocess, supports `rtsps://` via TLS proxy |
| `snapshot` | HTTP GET polling with connection pooling |
| `usb` | Linux V4L2 device (`/dev/videoN`), captured via ffmpeg `-f v4l2` |

**Reconnection:** Up to 3 attempts for MJPEG/RTSP (2s delay). Snapshot polls indefinitely.

---

## Backend: Startup/Shutdown Lifecycle

**File:** `backend/app/main.py` (lifespan context manager)

**Startup:**
1. `start_frame_buffer_cleanup()` — starts 10s periodic cleanup task
2. `start_camera_cleanup()` — starts 60s orphan ffmpeg cleanup task
3. DB query for `camera_engine` → if `"go2rtc"` → `go2rtc_service.start()`

**Shutdown:**
1. `stop_frame_buffer_cleanup()` — cancels cleanup task
2. `stop_camera_cleanup()` — cancels orphan cleanup task
3. `go2rtc_service.stop()` — terminates subprocess

**Router registration order:** Camera router registered BEFORE printers router so `/printers/camera/*` routes match before the `/{printer_id}` wildcard.

---

## Backend: Debug and Monitoring Endpoints

### `GET /api/v1/printers/camera/hub-status`

Returns comprehensive operational snapshot:
- `grid`: producer count, per-producer alive/viewers/params/idle_seconds/frames_produced
- `ffmpeg_processes`: PID, uptime, last CPU sample
- `system_load`: cpu_count, load_1m/5m/15m
- `cooldown_active`, `cooldown_remaining_s`: fleet circuit breaker state
- `watchdog_killed_printers`: set of printer IDs killed this cycle
- `stderr_error_counts/details/recent_errors`: structured ffmpeg error diagnostics
- `per_printer_status`: aggregated error counts + cooldown per printer
- `watchdog_thresholds`: per-process CPU%, fleet CPU%, grace secs, spawn load threshold

### `GET /api/v1/printers/{printer_id}/camera/status`

Returns whether a camera stream is active for a specific printer and if it's stalled.

### `GET /api/v1/settings/check-ffmpeg`

Returns: `installed`, `path`, `gpu_available`, `gpu_backends`, `auto_resolved_single`, `auto_resolved_grid`

### `GET /api/v1/settings/check-go2rtc`

Returns: go2rtc binary path, installed status, service ready state.

---

## Frontend: Architecture Overview

```
PrintersPage (state: showCameraGrid, cameraGridLayout)
  └── CameraGrid (orchestrator)
        ├── useGridStream (MJPEG multiplexed stream)
        │     ├── useGridReconnect (exponential backoff)
        │     ├── GrowingBuffer (stream buffer)
        │     └── cameraGridDecoder.worker (off-thread JPEG decode)
        ├── WebRTCGridCard (per-printer WebRTC)
        │     └── useWebRTCStream (RTCPeerConnection + frame monitor)
        └── CameraGridCard (pure display, IntersectionObserver)

EmbeddedCameraViewer (floating overlay per printer)
  ├── useMjpegStream (single-camera MJPEG)
  ├── useStreamReconnect (error/stall detection)
  ├── useCameraControls (chamber light, skip objects)
  ├── useCameraStopHint (cleanup on unmount)
  └── useZoomPan (mouse/touch zoom + pan)

CameraPage (standalone page, /printers/:id/camera)
  ├── useMjpegStream
  ├── useStreamReconnect
  ├── useCameraControls
  ├── useCameraStopHint
  └── useZoomPan
```

---

## Frontend: CameraGrid Component

**File:** `frontend/src/components/CameraGrid.tsx`

### Props

```ts
{
  printers: {
    id: number;
    name: string;
    model: string;
    connected: boolean;
    state: string;        // 'RUNNING' | 'PAUSE' | 'FINISH' | 'FAILED' | 'IDLE' | etc.
    progress: number;     // 0-100
    remainingTime: number;
    layerNum: number;
    totalLayers: number;
    plateCleared: boolean;
    hmsErrors?: { severity: number; description: string }[];
    supports_rtsp?: boolean;
  }[];
  layout: 'compact' | 'default' | 'large';
  timeFormat?: 'system' | '12h' | '24h';
}
```

### Engine-Based Printer Splitting

When `cameraEngine === 'go2rtc'`:
- `supports_rtsp === true` → `webrtcPrinters` → individual `WebRTCGridCard` per printer
- `supports_rtsp !== true` → `mjpegPrinters` → all share multiplexed grid stream

When `cameraEngine === 'ffmpeg'`: all printers go through MJPEG.

### Printer ID Debouncing

Sorted printer IDs are joined into a key string. A 2-second debounce prevents stream teardown during transient list changes. Empty→non-empty transitions are immediate.

### `restartKey`

A single incrementing integer. The `<RefreshCw>` button increments it, which tears down and reinitializes all streams simultaneously.

### Combined Stats Display

Stats from MJPEG (`getMjpegStatsSnapshot`) and WebRTC (`webrtcStatsRegistry`) are merged every 1s. Published via `useSyncExternalStore` to avoid full-tree rerenders.

Displayed stats row:
- `<RefreshCw>` button for manual restart
- Bandwidth (e.g. `"1.2 MB/s"` or `"--"`)
- Uptime (`"MM:SS"` or `"--"`)

### Print Control Mutations

Three `useMutation` calls: `pauseMutation`, `stopMutation`, `resumeMutation`. All require a `ConfirmModal` before firing.

`clearPlateMutation` for queue advancement — shown when `state === 'FINISH' || state === 'FAILED'` with queued jobs.

Queue data fetched only for finished/failed printers via `useQueries` with 30s stale time.

### Permission Guards

`canControl` and `canClearPlate` checked once. Callbacks only passed to cards if user has required permissions.

---

## Frontend: CameraGridCard Display

**File:** `frontend/src/components/CameraGrid.tsx` (lines 43–322, `memo`-wrapped)

### Media Element

Each card has a `16:9` aspect-ratio video area (`aspect-video`, black background):
- `<canvas>` for MJPEG cards (drawn by main thread after worker decode)
- `<video autoPlay playsInline muted>` for WebRTC cards

`className="invisible"` during loading, error, reconnecting, or disconnected states. When stale (no frames for 3-45s), `blur(3px)` with `transition: filter 0.6s ease-in-out`.

### IntersectionObserver

Each card creates an `IntersectionObserver` with `threshold: 0`. When card scrolls in/out, `onVisibilityChange(printerId, isIntersecting)` fires → sends `{ type: 'visibility', printerId, visible }` to worker. Off-screen cameras skip JPEG decoding entirely.

### Overlay Layers (z-order, bottom to top)

1. **Canvas/video** — base layer
2. **Stale blur** — CSS filter, no visible overlay element
3. **Loading spinner** — centered `<Loader2>` when `connected && loading && !reconnecting`
4. **Reconnecting overlay** — `bg-black/70` + `WifiOff` icon + countdown text (`"Reconnecting in {countdown}s (attempt {attempt})"`)
5. **Error overlay** — `AlertCircle` + `"Camera unavailable"` + optional `"Retry"` button
6. **Offline overlay** — `WifiOff` + `"Offline"` text when `!connected`
7. **Paused overlay** — `bg-black/50` + large yellow `"PAUSED"` text with fade-in transition (2000ms)
8. **Top bar gradient** — `bg-gradient-to-b from-black/70`: printer name (left), control buttons (right)
9. **HMS Error banner** — dismissable button below top bar

### Top Bar

- **Left:** Printer name. If `degraded`, a pulsing yellow `Signal` icon appears next to name.
- **Right:** When running: Pause + Stop buttons. When paused: Resume + Stop buttons. Otherwise: state text in appropriate color.
- All buttons show spinning `<Loader2>` when mutation is in flight.

### HMS Error Banner

Shows highest-severity error from `hmsErrors` array. Dismissable per-printer (stored in `dismissedErrors` Map). Styled red (darker for severity ≤ 2, lighter for > 2).

### Bottom Progress Bar

Visible when `state === 'RUNNING' || 'PAUSE'`:
- `bg-gradient-to-t from-black/80`
- ETA with hover tooltip showing absolute time
- Layer counter (`layerNum/totalLayers`)
- Percentage (`Math.round(progress)%`)
- Progress bar: green when running, yellow when paused

When `state === 'FINISH' || 'FAILED'` with queued jobs and `!plateCleared`: full-width green `"Clear Plate"` button.

### Layout-Responsive Sizing

| Layout | Text sizes | Icon sizes | Bar height | Gap |
|--------|-----------|------------|-----------|-----|
| compact | `text-[10px]` | `text-[9px]` | `h-1` | `gap-2` |
| default | `text-sm` | `text-[11px]` | `h-1.5` | `gap-4` |
| large | same as default | same | same | same |

---

## Frontend: Grid Layout System

**File:** `frontend/src/components/cameraGridLayout.ts`

Responsive Tailwind grid columns:

| Layout | xs (default) | sm | lg | xl | 2xl |
|--------|-------------|----|----|----|----|
| compact | 2 cols | 3 | 4 | 5 | 6 |
| default | 1 col | 2 | 3 | 4 | 5 |
| large | 1 col | 1 | 2 | 3 | 4 |

Icons: `Grid` (compact), `Grid2x2` (default), `LayoutGrid` (large) from lucide-react.

---

## Frontend: useGridStream Hook

**File:** `frontend/src/hooks/useGridStream.ts`

### Binary Protocol Parsing

Endpoint: `GET /api/v1/printers/camera/grid-stream?ids=1,2,3`

Each chunk contains frames with 8-byte LE headers: `[4B printer_id][4B jpeg_length][jpeg_data]`

`parseGridFrames()` has a 10MB per-frame sanity cap. Returns `bytesConsumed: -1` on corruption.

### Stream Lifecycle

Runs when `printerIdsKey`, `gridParamsKey`, or `restartKey` change:
1. Sets all printer IDs into `loadingSet`
2. Spawns new `CameraGridDecoderWorker`
3. Seeds worker with `{ type: 'visibility', printerId, visible: true }` for all printers
4. Starts `fetch` with `Authorization: Bearer <token>`, reads `ReadableStream` chunks
5. Parses frames, transfers JPEG `ArrayBuffer` to worker via structured clone + transfer

### Stall Timer

45-second stall timer reset on every chunk. If no data for 45s, cancels reader → triggers reconnect.

### Stats Interval (1s)

- Computes bandwidth (`formatFileSize(bytes)`)
- Computes uptime as `MM:SS`
- Evaluates per-printer frame staleness:
  - `> 3s` → `staleSet`
  - `> 10s` → `degradedSet` + `staleSet`
  - `> 45s` → `errorSet`, removes from `loadedPrinters`

### Startup Timeout

After 45s, any printer IDs that haven't received a first frame are added to `errorSet`.

### Worker Health Monitor (5s interval)

Checks:
- `dataFlowing`: chunk parsed in last 5s
- `workerSilent`: worker hasn't returned frame in 15s, or sent >20 frames with 0 responses

On first detection: sends `ping`. If stall persists: terminates worker, spawns new one (max 3 restarts), reseeds visibility.

### Pipeline Diagnostics

`pipelineRef` tracks: `chunksReceived`, `framesParsed`, `framesSentToWorker`, `framesFromWorker`, `framesDrawn`, `workerDecodeErrors`, `workerRestarts`. Logged via `console.debug` every 10s.

### Canvas Drawing

When worker sends `{ type: 'frame', printerId, bitmap }`:
1. Updates `activeCamsRef` and `lastFrameTime`
2. Clears error/reconnecting/loading state
3. Looks up canvas ref from `canvasRefs`
4. Resizes canvas only when dimensions change (tracked in `dimCache`)
5. Caches `CanvasRenderingContext2D` in `ctxCache`
6. `drawImage(bitmap, 0, 0)`, then `bitmap.close()` (frees GPU memory)

### Return Value

```ts
{
  canvasRefs: Map<number, RefObject<HTMLCanvasElement>>;
  loadingSet: Set<number>;
  errorSet: Set<number>;
  degradedSet: Set<number>;
  staleSet: Set<number>;
  reconnectingSet: Set<number>;
  reconnectCountdown: number;
  reconnectAttempt: number;
  subscribeStats: (cb: Function) => () => void;
  getStatsSnapshot: () => GridStreamStats;
  handleVisibilityChange: (printerId: number, visible: boolean) => void;
}
```

---

## Frontend: Web Worker Decoder

**File:** `frontend/src/workers/cameraGridDecoder.worker.ts`

### State

- `visibleSet: Set<number>` — printer IDs currently visible in viewport
- `pendingFrame: Map<number, ArrayBuffer>` — latest JPEG per printer (replaces previous)
- `decoding: Map<number, boolean>` — in-flight decode flag per printer

### Message Protocol

**Main → Worker:**
| Type | Fields | Description |
|------|--------|-------------|
| `frame` | `printerId, jpeg: ArrayBuffer` | New JPEG (transferred, zero-copy) |
| `visibility` | `printerId, visible: boolean` | IntersectionObserver update |
| `ping` | — | Health check |
| `clear` | — | Reset all state |

**Worker → Main:**
| Type | Fields | Description |
|------|--------|-------------|
| `frame` | `printerId, bitmap: ImageBitmap` | Decoded frame (transferred) |
| `pong` | `visibleCount, pendingCount, decodingCount, totalDecodeErrors, totalDecodeSuccess` | Health response |
| `decodeError` | `printerId, totalErrors, totalSuccess, visibleCount` | Throttled (once per 5s) |

### Decode Pipeline

`tryDecode(printerId)`:
1. If already decoding this printer → return (no concurrency per printer)
2. Pop pending frame (latest wins, older dropped)
3. `createImageBitmap(new Blob([jpeg], 'image/jpeg'))` off main thread
4. Success → transfer bitmap to main thread
5. Error → throttled error report
6. After either: `decoding = false`, call `tryDecode` again for next pending

**Visibility guard:** If `!visibleSet.has(printerId)`, frame message is ignored entirely — no buffering, no decoding.

---

## Frontend: useWebRTCStream Hook

**File:** `frontend/src/hooks/useWebRTCStream.ts`

### Connection Flow

1. `new RTCPeerConnection({ iceServers: [] })` — LAN only, no STUN/TURN
2. `addTransceiver('video', { direction: 'recvonly' })`
3. `ontrack` → attaches stream to `videoRef.srcObject`, calls `play()`, starts frame monitor
4. Creates SDP offer, POSTs to `api.webrtcOffer(printerId, sdp)`
5. Sets go2rtc answer as remote description (ICE-lite, no trickle ICE)
6. 30-second connection timeout — no frame before timeout → reconnect

### Frame Monitoring

Uses `requestVideoFrameCallback` if available, falls back to polling `video.currentTime` every 1s.

Thresholds (from `streamConstants.ts`):
- `> 3s` → `stale = true`
- `> 10s` → `stale + degraded = true`
- `> 45s` → `hasError = true`, triggers reconnect

### Bandwidth Stats

`getStats()` poll every 1s. Extracts `inbound-rtp` video `bytesReceived`, computes delta. Reports to `onStats(printerId, { bytesPerSecond, timestamp })`. First tick skipped.

### Reconnect

Same formula: `min(2000 * 2^attempt, 30000)`. No maximum attempts. `reconnectScheduledRef` prevents double-scheduling.

---

## Frontend: Reconnect Logic

### Grid Reconnect (`useGridReconnect.ts`)

`scheduleReconnect(printerIds)`:
- Delay: `min(2000 * 2^attempt, 30000)` ms
- Sets all printer IDs into `reconnectingSet`
- Runs countdown timer (visible in UI as `reconnectCountdown`)
- **No maximum attempt count** — retries indefinitely

### Single Camera Reconnect (`useStreamReconnect.ts`)

Used by `EmbeddedCameraViewer` and `CameraPage`:
- `maxAttempts = 5` — after this, `onGiveUp()` is called
- `initialDelay = 2000`, `maxDelay = 30000` — exponential backoff
- `stallCheckInterval = 30000` — polls `GET /printers/{id}/camera/status`
- **Before first success:** up to 10 fast retries at 500ms intervals
- **After first success:** switches to exponential backoff mode

---

## Frontend: EmbeddedCameraViewer

**File:** `frontend/src/components/EmbeddedCameraViewer.tsx`

A `position: fixed` floating window:

### Interaction
- **Drag:** Header area via `onMouseDown`/`onTouchStart`, `requestAnimationFrame`-throttled
- **Resize:** Bottom-right corner handle (SE resize cursor)
- **Minimize:** Collapses to 200×40px header-only strip. Stops stream when minimized.
- **Fullscreen:** `containerRef.requestFullscreen()`, hides resize handle, resets zoom on exit

### Position Persistence
Saves `{x, y, width, height}` to `localStorage` key `embeddedCameraState_{printerId}` after 500ms debounce. On load, validates coordinates are on-screen. Multiple viewers offset by `viewerIndex * 30px`.

Default position: `x: window.innerWidth - 420, y: 20, width: 400, height: 300`.

### Stream
URL: `/printers/{printerId}/camera/stream` (MJPEG, quality resolved server-side).

### Header Buttons
Chamber light toggle, skip objects, refresh, fullscreen, minimize, close.

### Zoom Controls
Bottom-left of video area: `-`, `{percent}%` (clickable to reset), `+`.

---

## Frontend: CameraPage

**File:** `frontend/src/pages/CameraPage.tsx`

Route: `/printers/:printerId/camera`

### Two Modes (toggle buttons)

| Mode | Stream | Element |
|------|--------|---------|
| `stream` | `useMjpegStream` + `useStreamReconnect` | `<canvas>` |
| `snapshot` | `GET /printers/{id}/camera/snapshot?t={key}` (blob URL for auth) | `<img>` |

Mode switching has 100ms transition that disables controls and briefly suspends stream.

### Reconnect UI
Shows: countdown, attempt/max count, "Reconnect now" button.

Document title: `"{printerName} - Camera View"` during viewing.

---

## Frontend: Zoom and Pan

**File:** `frontend/src/hooks/useZoomPan.ts`

### State
- `zoomLevel: 1-4` (steps of 0.5 for buttons, continuous for touch/wheel)
- `panOffset: { x, y }` — clamped to `±maxPan` per axis

### Max Pan Calculation
`width * (zoomLevel - 1) / 2` and `height * (zoomLevel - 1) / 2`, minimum 50px.

### Input Methods
- **Mouse wheel:** zoom in/out in 0.5 steps
- **Mouse drag:** pan when `zoomLevel > 1`
- **Pinch-to-zoom:** Euclidean touch distance, scales proportionally. Resets pan at `zoomLevel === 1`.
- **Single-touch drag:** pan when `zoomLevel > 1`
- **Buttons:** `handleZoomIn/Out` (0.5 step), `resetZoom` (back to 1x)

### CSS Transform
```css
transform: scale({zoomLevel}) translate({panX/zoomLevel}px, {panY/zoomLevel}px)
```

In `EmbeddedCameraViewer`, camera rotation is additionally applied:
```css
rotate({printer.camera_rotation || 0}deg)
```

---

## Frontend: Camera Control Hooks

### `useCameraControls.ts`

Fetches printer status every 30s. Provides:
- `chamberLightMutation`: optimistic toggle of `status.chamber_light`, reverts on error
- `isPrintingWithObjects`: true when printing and `printable_objects_count >= 2`
- `checkStalled()`: calls `api.getCameraStatus(printerId)`, returns stall state
- `hasControlPermission`: `hasPermission('printers:control')`

### `useCameraStopHint.ts`

On unmount and `window.beforeunload`: sends `POST /printers/{id}/camera/stop` with `keepalive: true` (survives page navigation). Prevents orphaned ffmpeg processes.

### `useCameraStreamToken.ts`

Two exports:

`useStreamTokenSync()`: Fetches camera stream token, stores globally. Refreshes every 50 minutes (tokens expire at 60 min). Only active when `authEnabled`. Mount once near app root.

`useCameraStreamToken()`: Returns `{ withToken }` — URL decorator appending `?token=xxx` when auth enabled.

---

## Frontend: Stream Buffer Utility

**File:** `frontend/src/utils/streamBuffer.ts`

`GrowingBuffer` — pre-allocated doubling ring-buffer:
- `append(chunk)`: doubles backing `Uint8Array` until it fits. Throws `RangeError` if `maxSize` exceeded.
- `compact(offset)`: `copyWithin(0, offset, len)` — shifts unconsumed bytes to front
- `shrinkIfSparse()`: if `buf.length > initialSize && len < buf.length / 4`, shrinks to `max(initialSize, len*2)`

Usage:
- `useMjpegStream`: 256KB initial, 5MB max
- `useGridStream`: 256KB initial, 10MB max

---

## Frontend: Stream Constants

**File:** `frontend/src/utils/streamConstants.ts`

| Constant | Value | Used For |
|----------|-------|----------|
| `STREAM_STALE_MS` | 3,000ms | Blur canvas (early warning) |
| `STREAM_DEGRADED_MS` | 10,000ms | Show pulsing Signal icon |
| `STREAM_ERROR_MS` | 45,000ms | Mark error, trigger reconnect |
| `RECONNECT_BASE_DELAY_MS` | 2,000ms | First reconnect delay |
| `RECONNECT_MAX_DELAY_MS` | 30,000ms | Maximum reconnect delay |

---

## Frontend: i18n Keys

### Camera Grid (`printers.cameraGrid.*`)

- `cameraUnavailable` — "Camera unavailable"
- `connectionLost` — "Connection lost"
- `reconnecting` — "Reconnecting in {{countdown}}s (attempt {{attempt}})"
- `retry` — "Retry"
- `refresh` — "Refresh"
- `layout.compact` — "Compact"
- `layout.default` — "Default"
- `layout.large` — "Large"

### Camera Page (`camera.*`)

- `live`, `snapshot` — Mode labels
- `connectingToCamera` — "Connecting to camera..."
- `connectionLost` — "Connection lost"
- `reconnecting` — "Reconnecting in {{countdown}}s (attempt {{attempt}}/{{max}})"
- `reconnectNow` — "Reconnect now"
- `cameraUnavailable` / `cameraUnavailableDesc`
- `zoomIn`, `zoomOut`, `resetZoom`
- `chamberLight`, `fullscreen`, `exitFullscreen`, `resize`, `minimize`, `expand`

### Settings (`settings.*`)

- `cameraEngine` — "Camera Engine"
- `cameraEngineFFmpeg` / `cameraEngineGo2rtc`
- `cameraQuality` — "Camera Quality"
- `cameraQualityLow` / `Medium` / `High` / `Auto`
- `cameraGpuAccel` — "GPU Acceleration"
- `cameraViewMode` — "Camera View Mode"
- `cameraOverlayDescription` / `cameraWindowDescription`

---

## Frontend: PrintersPage Integration

**File:** `frontend/src/pages/PrintersPage.tsx`

### State (localStorage-persisted)

- `cameraGrid.enabled` — boolean, toggled via `<Video>` icon button
- `cameraGrid.layout` — `'compact' | 'default' | 'large'`, default `'default'`

### Layout Selector

When `showCameraGrid`:
- Three layout icons replace the normal card size selector
- Each icon styled with green highlight when selected

### Camera Grid Toggle Button

`<Video>` icon button toggles `showCameraGrid`. Persists to localStorage.

### Printer Data Mapping

`cameraGridPrinters = useMemo(...)` reads live status from React Query cache and maps each printer to the shape expected by `CameraGrid`, including `supports_rtsp` for WebRTC eligibility.

### ErrorBoundary

`<CameraGrid>` is wrapped in `<ErrorBoundary>` that shows `t('printers.cameraGridError')` on uncaught throws.

### Conditional Rendering

When `showCameraGrid === true`, the entire printer card list is replaced by `<CameraGrid>`.

---

## Frontend: Settings Page Integration

**File:** `frontend/src/pages/SettingsPage.tsx`

Camera-related settings in the General tab:

### Camera Engine Selector
Dropdown with options: `ffmpeg` and `go2rtc`. go2rtc option shows status badge from `checkGo2rtc` query.

### Camera Quality Selector
Dropdown with options: `auto`, `low`, `medium`, `high`. When `auto` selected, shows resolved quality from `checkFfmpeg` query (e.g., "Auto (resolved: medium)").

### GPU Acceleration Toggle
Boolean toggle. Shows available GPU backends from `checkFfmpeg` query.

### Camera View Mode
Radio options: `overlay` (embedded floating viewer) or `window` (new browser window).

### External Camera Configuration (per-printer)
For each printer:
- URL input with test connection button
- Camera type selector (mjpeg/rtsp/snapshot/usb)
- Enable/disable toggle
- Camera rotation selector (0/90/180/270)

### Side Effects
All camera settings changes trigger hub stop + restart on save.

---

## API Client Additions

**File:** `frontend/src/api/client.ts`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `webrtcOffer(printerId, sdp)` | `POST /printers/{id}/camera/webrtc` | SDP offer for WebRTC |
| `getCameraStreamToken()` | `POST /printers/camera/stream-token` | Get 60-min auth token |
| `getCameraStreamUrl(printerId, fps)` | URL builder | MJPEG stream URL with token |
| `getCameraSnapshotUrl(printerId)` | URL builder | Snapshot URL with token |
| `stopCameraStream(printerId)` | `POST /printers/{id}/camera/stop` | Hint to clean up server resources |
| `checkGo2rtc()` | `GET /settings/check-go2rtc` | go2rtc status |
| `checkFfmpeg()` | `GET /settings/check-ffmpeg` | FFmpeg capabilities + resolved quality |
| `withStreamToken(url)` | Client-side | Appends `?token=xxx` to URL |
| `setStreamToken(token)` | Client-side | Stores token globally |

---

## Test Coverage

### Backend: `test_camera_grid.py` (~550 lines)

- `TestCleanupStaleFrameBuffers`: removes stale entries, preserves fresh, handles partial/mixed
- `TestSharedStreamHubGetExisting/Batch`: alive/dead/missing dispatch, `last_accessed` update
- `TestGenerateRtspNonFiniteGuard`: NaN scale, Inf fps, -Inf quality yield error bytes
- `TestEnsureProducerDispatch`: external camera → None, force_quality → restart, reuse preserves start_time
- `TestFleetCpuWatchdog`: kills worst offenders, no-kill under threshold, respects grace
- `TestScanBambuFfmpegPids`: returns empty on non-Linux
- `TestSpawnLoadGate`: load gate blocks when overloaded

### Backend: `test_camera_grid_hub.py` (575+ lines)

- `TestSharedStreamHubGetOrStart`: new creation, reuse (even with different params), dead entry replacement
- `TestSharedStreamHubRestart`: different params → new, same params → reuse, no existing → create, identity check
- `TestSharedStreamHubIdleTimeout`: auto-stop when idle, stays alive when viewers active
- `TestSharedStreamHubStop`: returns False for missing, marks dead + clears frame, cancels task
- `TestSharedStreamHubIsActive/GetLastFrame/Status`: query methods
- `TestMakeViewer`: MJPEG format correctness (3 chunks/frame), exit on dead, viewer_count management, skip duplicates

### Frontend: `CameraGrid.test.tsx`

- Renders grid, verifies canvas creation per printer

### Frontend: `EmbeddedCameraViewer.test.tsx`

- Renders viewer, verifies basic structure

### Frontend: `useGridStream.test.ts`

- Binary frame parsing, reconnect behavior

### Frontend: `useGridStreamParser.test.ts`

- `parseGridFrames` protocol parsing edge cases

### Frontend: `useStreamReconnect.test.ts`

- Reconnect lifecycle, max attempts, stall detection

### Frontend: `useZoomPan.test.ts`

- Zoom/pan state management

### Frontend: `cameraGridDecoder.test.ts`

- Worker message protocol, visibility filtering, decode pipeline

---

## Files Reference

### Backend

| File | Role |
|------|------|
| `backend/app/api/routes/camera.py` | All camera API endpoints, SharedStreamHub, quality presets, grid stream, CPU watchdog |
| `backend/app/services/camera.py` | Protocol implementations (RTSP/chamber), TLS proxy, auto-quality, VAAPI detection |
| `backend/app/services/external_camera.py` | External camera (MJPEG/RTSP/snapshot/USB), URL sanitization, SSRF mitigation |
| `backend/app/services/go2rtc.py` | go2rtc subprocess manager, HTTP API client, watchdog |
| `backend/app/main.py` | Startup/shutdown hooks, notification snapshot pipeline, orphan cleanup |
| `backend/app/schemas/printer.py` | `external_camera_url/type/enabled`, `camera_rotation` fields |
| `backend/app/schemas/settings.py` | `camera_quality`, `camera_gpu_accel`, `camera_engine`, `camera_view_mode` |
| `backend/app/api/routes/settings.py` | `check-ffmpeg`/`check-go2rtc` endpoints, settings change side effects |
| `backend/tests/unit/test_camera_grid.py` | State, watchdog, NaN guard, load gate tests |
| `backend/tests/unit/test_camera_grid_hub.py` | SharedStreamHub lifecycle, viewer, race condition tests |

### Frontend

| File | Role |
|------|------|
| `frontend/src/components/CameraGrid.tsx` | Main orchestrator: printer splitting, stats, mutations, card rendering |
| `frontend/src/components/cameraGridLayout.ts` | Responsive grid column definitions |
| `frontend/src/components/cameraDefaults.ts` | Floating viewer default position |
| `frontend/src/components/EmbeddedCameraViewer.tsx` | Floating draggable camera viewer overlay |
| `frontend/src/hooks/useGridStream.ts` | MJPEG multiplexed stream, worker management, canvas drawing |
| `frontend/src/hooks/useGridReconnect.ts` | Grid exponential backoff reconnect |
| `frontend/src/hooks/useWebRTCStream.ts` | Per-printer WebRTC via go2rtc |
| `frontend/src/hooks/useStreamReconnect.ts` | Single-camera reconnect with max attempts |
| `frontend/src/hooks/useMjpegStream.ts` | Single-camera MJPEG stream |
| `frontend/src/hooks/useCameraControls.ts` | Chamber light, skip objects, stall check |
| `frontend/src/hooks/useCameraStopHint.ts` | Server cleanup on unmount |
| `frontend/src/hooks/useCameraStreamToken.ts` | Auth token for img/video src URLs |
| `frontend/src/hooks/useZoomPan.ts` | Mouse/touch zoom and pan |
| `frontend/src/utils/streamBuffer.ts` | GrowingBuffer for stream parsing |
| `frontend/src/utils/streamConstants.ts` | Shared threshold constants |
| `frontend/src/workers/cameraGridDecoder.worker.ts` | Off-thread JPEG decode |
| `frontend/src/pages/CameraPage.tsx` | Full-page camera view (stream + snapshot) |
| `frontend/src/pages/PrintersPage.tsx` | Camera grid integration (toggle, layout, data mapping) |
| `frontend/src/pages/SettingsPage.tsx` | Camera settings UI (engine, quality, GPU, view mode) |
| `frontend/src/api/client.ts` | API client (WebRTC, stream token, camera endpoints) |
| `frontend/src/i18n/locales/en.ts` | English translations for all camera strings |
