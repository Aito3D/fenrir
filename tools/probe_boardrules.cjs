// Snapshot probe: run the frontend board-rules engine over the shared fixture.
// The bundle is produced by esbuild into /tmp/bambuddy-refactor-probe/ by the
// probe command in PROBES.json before this script runs.
const path = require("path");
const rules = require("/tmp/bambuddy-refactor-probe/aitoBoardRules.cjs");
const cases = require(path.join(
  process.cwd(),
  "frontend/src/__tests__/fixtures/aitoBoardRules.cases.json",
));
const out = cases.evaluate.map((c) =>
  rules.evaluate(c.quote_status ?? null, c.stored_column, c.pending || []),
);
console.log(JSON.stringify({ evaluate: out, columnOrder: rules.COLUMN_ORDER, services: rules.SERVICES }));
