#!/bin/bash
# Campaign-9 coverage gate: WHOLE REPO.
#
# Unlike campaigns 4/6/8 (which measured a single feature's file list), campaign
# 9's scope is the entire application, so the gate measures every source file in
# backend/app and frontend/src -- no include list to drift, nothing to
# existence-check. The ratchet metric is the LINE percentage of each side.
#
# Run from repo root: bash tools/coverage_all.sh [frontend|backend|both]
#
# Two settings are load-bearing and must never be weakened (the loop treats a
# coverage exclusion or a narrowed include exactly like a deleted test):
#  * backend: `concurrency = ["greenlet", "thread"]` in pyproject.toml. Without
#    it SQLAlchemy async route bodies read as unexecuted; routes/aito.py once
#    reported 61.77% instead of ~97%.
#  * frontend: vitest `coverage.include = ['src/**/*.{ts,tsx}']` measures the
#    whole tree, not just files a test happens to import.
#
# test_bambu_ftp.py is excluded to match test_backend.sh's default gate (it
# needs a live FTP fixture); pass --full to test_backend.sh to include it.
set -u
set -o pipefail
cd "$(dirname "$0")/.." || exit 1
WHICH="${1:-both}"

if [ "$WHICH" = "backend" ] || [ "$WHICH" = "both" ]; then
  echo "=== BACKEND coverage (backend/app, whole tree) ==="
  ( cd backend && ../venv/bin/python3 -m pytest tests/ -q -n 30 \
      --ignore=tests/unit/services/test_bambu_ftp.py \
      --cov=app --cov-report=term 2>&1 | tail -15 )
fi

if [ "$WHICH" = "frontend" ] || [ "$WHICH" = "both" ]; then
  echo "=== FRONTEND coverage (frontend/src, whole tree) ==="
  # reportOnFailure:true in vitest.config.ts guarantees the "All files" row is
  # emitted even when a flaky test fails, so this grep always yields a number.
  ( cd frontend && npx vitest run --coverage 2>&1 | grep -E "^All files|Test Files|  Tests " )
fi
