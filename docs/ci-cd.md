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

## CD — the container image

`.github/workflows/docker-publish.yml` builds the production image and pushes
it to GHCR. The production host pulls `ghcr.io/aito3d/fenrir:latest`.

- **Automatic:** when `CI` finishes **successfully** for a commit on `main`,
  that commit is built for `linux/amd64` and `linux/arm64` and published as
  `:latest` and `:sha-<short>`. A red `main` never ships.
- **Releases:** pushing a `v*` tag publishes `:<version>` (the tag minus the
  `v`) for that commit. `:latest` is not moved — it keeps tracking `main`.
  The tagged commit must already have a green `CI` run; tag it after CI has
  finished, or re-run the workflow by hand once it has.
- **Manual (re-deploy / rollback):** *Actions → Publish Image → Run workflow*
  with `ref` set to a SHA, branch or tag. The job refuses unless that commit
  has a successful `CI` run on record, then publishes it as `:latest`.

Each platform builds natively on its own runner and is pushed by digest; a
final job merges the two digests into one multi-arch manifest and applies the
tags, so no tag ever points at a half-built image. Publishes are serialised
(`concurrency: publish`) and never cancelled mid-run.

Every published commit keeps its immutable `:sha-<short>` tag, so a rollback
on the host is `docker compose pull` against a pinned tag, or a manual run
of the workflow to move `:latest` back.

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
