#!/bin/bash
# The i18n keys FilamentProfilesPage.tsx reads, one per line, sorted.
# A section of SURFACE.md: a key that disappears or is renamed is a
# user-visible contract change (a missing translation renders the raw key).
set -u
cd "$(dirname "$0")/.." || exit 1
grep -oE "t\('[a-zA-Z0-9_.]+'" frontend/src/pages/FilamentProfilesPage.tsx \
  | sed -e "s/^t('//" -e "s/'$//" | sort -u
