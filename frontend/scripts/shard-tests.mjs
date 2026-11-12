// Splits the vitest files into shards of equal recorded duration.
//
//   node scripts/shard-tests.mjs <shard> <shards>    prints that shard's files
//   node scripts/shard-tests.mjs --record <report>   rewrites .test_durations.json
//                                                    from `vitest run --reporter=json`
//
// vitest's own --shard splits by file count, and CI's three shards ran 202 s,
// 229 s and 366 s. The file list comes from vitest itself, so every file it
// would run lands in exactly one shard; a file missing from the durations
// gets the median.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const durationsPath = path.join(root, '.test_durations.json');
const rel = (file) => path.relative(root, file).split(path.sep).join('/');

if (process.argv[2] === '--record') {
  const report = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const entries = report.testResults.map((r) => [rel(r.name), Math.round(r.endTime - r.startTime)]);
  entries.sort(([a], [b]) => (a < b ? -1 : 1));
  writeFileSync(durationsPath, JSON.stringify(Object.fromEntries(entries), null, 1) + '\n');
  console.log(`${entries.length} files recorded`);
} else {
  const shard = Number(process.argv[2]);
  const shards = Number(process.argv[3]);
  if (!(shard >= 1 && shard <= shards)) throw new Error('usage: shard-tests.mjs <shard> <shards>');
  const durations = JSON.parse(readFileSync(durationsPath, 'utf8'));
  const known = Object.values(durations).sort((a, b) => a - b);
  const median = known[known.length >> 1] ?? 1;
  const listed = execFileSync('npx', ['vitest', 'list', '--filesOnly', '--json'], { cwd: root, encoding: 'utf8' });
  const files = JSON.parse(listed)
    .map(({ file }) => rel(file))
    .map((file) => ({ file, ms: durations[file] ?? median }))
    // Longest first, each to the lightest shard so far; the name breaks ties
    // so every runner computes the same split.
    .sort((a, b) => b.ms - a.ms || (a.file < b.file ? -1 : 1));
  const totals = new Array(shards).fill(0);
  const mine = [];
  for (const { file, ms } of files) {
    const lightest = totals.indexOf(Math.min(...totals));
    totals[lightest] += ms;
    if (lightest === shard - 1) mine.push(file);
  }
  console.log(mine.join('\n'));
}
