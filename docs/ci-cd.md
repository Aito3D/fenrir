# CI / CD

## CI — every commit is tested

`.github/workflows/ci.yml` runs on **every push to every branch** (except
`deploy`) and on pull requests to `main`: ruff, pip-audit, sharded pytest
(host and inside the `Dockerfile.test` image), ESLint, `tsc`, Vitest,
`npm run build`, and a production Docker build + integration smoke test.

The terminal **`CI OK`** job is the single verdict. It fails if any gated job
failed or was cancelled. `Backend Security` / `Frontend Security` are advisory
(`continue-on-error`) and are not part of the gate.

PRs opened by the repository owner skip the jobs — the branch already ran
them on push — and `CI OK` treats that as green.

## CD — the `deploy` branch

The production host polls `origin/deploy`. `.github/workflows/deploy.yml`
moves that branch automatically:

- **Automatic:** when `CI` finishes **successfully** for a commit on `main`,
  `deploy` is fast-forwarded to that commit. A red `main` never ships.
- **Manual (re-deploy / rollback):** *Actions → Deploy → Run workflow* with
  `ref` set to a SHA, branch or tag. The job refuses unless that commit has a
  successful `CI` run on record.
- **Fast-forward only.** If `deploy` is not an ancestor of the target (someone
  pushed to it directly), the job fails instead of force-pushing. Reset it by
  hand (`git push origin <sha>:refs/heads/deploy`) if that is intended.

Deploys are serialised (`concurrency: deploy`) and never cancelled mid-run.

The old manual command still works as an escape hatch:

```bash
git push origin main:refs/heads/deploy
```

## Local equivalents

```bash
./test_frontend.sh     # tsc + eslint + vitest
./test_backend.sh      # ruff + pytest
./test_docker.sh       # Dockerfile.test build + suites in containers
actionlint             # lint the workflow files after editing them
```

Gotchas that have bitten CI but not local runs:

- Runners are **UTC**. Fixture timestamps at noon render as `12:00:00 PM`,
  so a bare `/12/` text query matches the timestamp too.
- `Dockerfile.test` copies only what it needs. A backend test that reads a
  frontend file (cross-stack contract fixtures) needs an explicit `COPY`.
