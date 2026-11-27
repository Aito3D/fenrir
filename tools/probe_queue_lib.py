"""Shared plumbing of the print queue (Q1) golden probes (loop tooling, not app code).

IMPORT THIS BEFORE ANY ``backend.app`` MODULE. Importing the app resolves its data
directory at import time (``core/config.py``: DATA_DIR, else the repo root, where it
would point at ./bambuddy.db). This module sets DATA_DIR / LOG_DIR to a fresh folder
under /tmp/fenrir-queue-probe/ first, so the app's own engine, archive and log folders
all live there; that folder (this process's own, nothing else) is removed at exit.
No probe deletes or writes a repo path, and none reaches the network.
"""

import atexit
import os
import shutil
import sys
import tempfile

os.makedirs("/tmp/fenrir-queue-probe", exist_ok=True)
ROOT = tempfile.mkdtemp(prefix="run-", dir="/tmp/fenrir-queue-probe")
os.environ["DATA_DIR"] = ROOT
os.environ["LOG_DIR"] = os.path.join(ROOT, "logs")
os.environ["LOG_TO_FILE"] = "false"
os.environ.pop("DATABASE_URL", None)  # never an external database
atexit.register(shutil.rmtree, ROOT, ignore_errors=True)
sys.path.insert(0, ".")
