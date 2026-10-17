#!/bin/sh
# Typecheck, lint and knip run in parallel (all read-only and independent),
# then the tests. Exits non-zero if any step fails, so a type or lint error
# can't scroll past unnoticed behind a green test run.

cd frontend || exit 1

npm run typecheck > /tmp/fenrir-typecheck.$$ 2>&1 &
typecheck_pid=$!
npm run lint > /tmp/fenrir-lint.$$ 2>&1 &
lint_pid=$!
npm run check:knip > /tmp/fenrir-knip.$$ 2>&1 &
knip_pid=$!

wait $typecheck_pid
typecheck_rc=$?
wait $lint_pid
lint_rc=$?
wait $knip_pid
knip_rc=$?

cat /tmp/fenrir-typecheck.$$ /tmp/fenrir-lint.$$ /tmp/fenrir-knip.$$
rm -f /tmp/fenrir-typecheck.$$ /tmp/fenrir-lint.$$ /tmp/fenrir-knip.$$

npm run test:run
test_rc=$?

cd ..

if [ $typecheck_rc -ne 0 ] || [ $lint_rc -ne 0 ] || [ $knip_rc -ne 0 ] || [ $test_rc -ne 0 ]; then
    echo "FAILED: typecheck=$typecheck_rc lint=$lint_rc knip=$knip_rc tests=$test_rc"
    exit 1
fi
