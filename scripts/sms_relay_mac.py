#!/usr/bin/env python3
"""SMS relay for Fenrir's Aito pickup SMS. Runs on the operator's Mac.

The Fenrir page open in the browser on THIS Mac POSTs
{"phone": "...", "text": "..."} to http://localhost:8765/send; this hands the
message to Messages, which sends it as an SMS (or iMessage) from the iPhone's
number. The server never reaches the Mac, so its IP address does not matter.

Who may send:
- Listens on 127.0.0.1 only: nothing else on the network can reach it.
- Accepts only browser requests whose Origin is a Fenrir address
  (SMS_RELAY_ORIGINS, comma-separated), so no other website open in the
  browser can make it send.

Standard library only, so the Mac's stock python3 (3.9) runs it.

Setup:
1. iPhone: Settings > Apps > Messages > Text Message Forwarding > turn the Mac on.
2. Copy this file to ~/Library/Application Support/FenrirSmsRelay/ and load
   scripts/sms_relay_mac.plist (see that file).
3. Send one SMS from Fenrir; approve the macOS prompt letting python3 control
   Messages, and the browser prompt letting the Fenrir page reach this device.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("SMS_RELAY_PORT", "8765"))
ALLOWED_ORIGINS = {
    o.strip().rstrip("/")
    for o in os.environ.get("SMS_RELAY_ORIGINS", "https://app.aito3d.fr,http://192.168.50.60:8000").split(",")
    if o.strip()
}
PHONE_RE = re.compile(r"^\+?[0-9 ().-]{4,20}$")
MAX_TEXT = 1600  # ten concatenated SMS parts; a pickup message is one or two
MAX_BODY = 16_384
# A hung Messages must not hold the browser forever; a timeout here is
# reported as "may have been sent" (504), never as a clean refusal.
OSASCRIPT_TIMEOUT_S = 30

# Phone and text arrive as argv, never spliced into the script source.
APPLESCRIPT = """
on run argv
    tell application "Messages"
        set smsService to first account whose service type is SMS
        send (item 2 of argv) to participant (item 1 of argv) of smsService
    end tell
end run
"""


def send_via_messages(phone: str, text: str) -> None:
    subprocess.run(
        ["osascript", "-e", APPLESCRIPT, phone, text],
        check=True,
        capture_output=True,
        text=True,
        timeout=OSASCRIPT_TIMEOUT_S,
    )


def parse_request(origin: str | None, body: bytes) -> tuple[int, str, tuple[str, str] | None]:
    """Return (status, message, (phone, text) or None). Pure, so it is testable."""
    if origin not in ALLOWED_ORIGINS:
        return 403, "origin not allowed", None
    try:
        data = json.loads(body)
        phone, text = str(data["phone"]).strip(), str(data["text"])
    except (ValueError, KeyError, TypeError):
        return 400, "body must be JSON with phone and text", None
    if not PHONE_RE.match(phone):
        return 400, "bad phone number", None
    if not text.strip() or len(text) > MAX_TEXT:
        return 400, "text is empty or too long", None
    return 200, "ok", (phone, text)


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        # CORS preflight (the page posts JSON). Chrome's local-network check
        # also asks for Allow-Private-Network here.
        origin = self.headers.get("Origin")
        if origin not in ALLOWED_ORIGINS:
            return self._reply(403, "origin not allowed")
        self.send_response(204)
        self._cors(origin)
        self.send_header("Access-Control-Allow-Methods", "POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if not 0 < length <= MAX_BODY:
            return self._reply(413, "missing or oversized body")
        status, message, parsed = parse_request(self.headers.get("Origin"), self.rfile.read(length))
        if parsed is None:
            return self._reply(status, message)
        try:
            send_via_messages(*parsed)
        except subprocess.CalledProcessError as e:
            # Messages refused (no SMS account = forwarding off, bad number...).
            # Nothing was sent, so a retry is safe.
            return self._reply(502, f"Messages refused: {(e.stderr or '').strip()[:300]}")
        except subprocess.TimeoutExpired:
            return self._reply(504, "Messages did not answer; the SMS may or may not have gone")
        self._reply(200, "sent")

    def _cors(self, origin: str | None) -> None:
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _reply(self, status: int, message: str) -> None:
        self.send_response(status)
        self._cors(self.headers.get("Origin"))
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(message.encode())


def main() -> None:
    print(f"SMS relay on 127.0.0.1:{PORT}, origins: {', '.join(sorted(ALLOWED_ORIGINS))}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
