#!/bin/bash
# Campaign-4 coverage gate: full frontend suite, coverage measured over the
# campaign SCOPE only (Camera Grid + Aito + Calculator, frontend).
# Run from repo root: bash tools/coverage_scope.sh
# The include list below IS the scope definition for coverage. Every non-glob
# entry is existence-checked first so a rename/move fails loudly instead of
# silently dropping a file from the gate.
set -u
cd "$(dirname "$0")/.." || exit 1

FILES=(
  frontend/src/components/CameraGrid.tsx
  frontend/src/components/EmbeddedCameraViewer.tsx
  frontend/src/components/cameraGridLayout.ts
  frontend/src/components/cameraDefaults.ts
  frontend/src/components/CalculatorSettingsPanels.tsx
  frontend/src/pages/AitoPage.tsx
  frontend/src/pages/CalculatorPage.tsx
  frontend/src/pages/CalculatorQuotePage.tsx
  frontend/src/workers/cameraGridDecoder.worker.ts
  frontend/src/hooks/useCalculatorState.ts
  frontend/src/hooks/useCardMorph.ts
  frontend/src/hooks/useColumnMoveMutation.ts
  frontend/src/hooks/useColumnReflow.ts
  frontend/src/hooks/useDismissableDialog.ts
  frontend/src/hooks/useFlagMutation.ts
  frontend/src/hooks/useLatestProjectEvent.ts
  frontend/src/hooks/useNewProjectDraft.ts
  frontend/src/hooks/useOptimisticBoardMutation.ts
  frontend/src/hooks/useProjectTasks.ts
  frontend/src/hooks/useQuoteStatusMutation.ts
  frontend/src/hooks/useRevertFlash.ts
  frontend/src/hooks/useSendQuoteMutation.ts
  frontend/src/hooks/useSettledValue.ts
  frontend/src/hooks/useGridStream.ts
  frontend/src/hooks/useGridReconnect.ts
  frontend/src/hooks/useCombinedGridStats.ts
  frontend/src/hooks/useMjpegStream.ts
  frontend/src/hooks/useWebRTCStream.ts
  frontend/src/hooks/useStreamReconnect.ts
  frontend/src/hooks/useCameraControls.ts
  frontend/src/hooks/useCameraStopHint.ts
  frontend/src/hooks/useCameraStreamToken.ts
  frontend/src/utils/aitoAging.ts
  frontend/src/utils/aitoBoard.ts
  frontend/src/utils/aitoBoardRules.ts
  frontend/src/utils/aitoOptimistic.ts
  frontend/src/utils/aitoSearch.ts
  frontend/src/utils/aitoSummary.ts
  frontend/src/utils/clientDraft.ts
  frontend/src/utils/taskDraft.ts
  frontend/src/utils/shippingDraft.ts
  frontend/src/utils/calculatorInsights.ts
  frontend/src/utils/pricing.ts
)
GLOBS=(
  'src/components/cameraGrid/**'
  'src/components/calculator/**'
  'src/components/aito/**'
  'src/hooks/useAito*.ts'
)

missing=0
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then echo "SCOPE FILE MISSING: $f" >&2; missing=1; fi
done
if [ "$missing" = 1 ]; then
  echo "coverage_scope.sh: scope list is stale — fix before trusting any coverage number" >&2
  exit 2
fi

ARGS=()
for f in "${FILES[@]}"; do ARGS+=("--coverage.include=${f#frontend/}"); done
for g in "${GLOBS[@]}"; do ARGS+=("--coverage.include=$g"); done

cd frontend || exit 1
# reportOnFailure: known-flaky tests (PrintModal, ImportQuoteDrawer) must not
# be able to suppress the coverage report — the ratchet needs a number even on
# a run where a documented flake fires.
exec npx vitest run --coverage.enabled=true --coverage.reportOnFailure=true --coverage.reporter=text --coverage.reporter=json-summary "${ARGS[@]}"
