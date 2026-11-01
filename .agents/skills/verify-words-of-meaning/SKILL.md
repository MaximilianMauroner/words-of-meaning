---
name: verify-words-of-meaning
description: Verify local benchmark creation, fake-worker execution, metrics, cancellation and export without provider spend.
---

# Verify Words of Meaning

Read `AGENTS.md`, `README.md`, the installed Next version guide, and
[the feature index](features/README.md). Use an isolated worktree, owned SQLite path and
one worker. Check active work, memory, load and ports before install/start.
Record revision, mode, database path privately, port and process handles.

```sh
pnpm install --frozen-lockfile
WORDS_FAKE_CODEX=1 WORDS_MAX_CONCURRENCY=1 WORDS_DB_PATH=<owned-absolute-sqlite-path> pnpm run dev --hostname 127.0.0.1 --port 43131
```

Create the parent state directory first. Require `/api/preflight` to report
`ok: true` before mutations. Require `fakeCodex: true` for the fake-worker setup and record the launcher
environment separately. Use actual fields,
not a made-up health endpoint. Fake mode proves application orchestration,
not model word meanings, provider sandboxing or paid inference.

Use T3 preview status/open/navigate/snapshot for browser steps. Public API
steps may use HTTP and must inspect their resulting stored state/export.
Use the current `createExperimentSchema` in `src/shared/domain.ts` for request
fields. A POST returns the actual ID; never guess an ID or endpoint.
Run serially. Recheck readiness and reset owned state before a targeted retry.

Stop the owned server and all worker children before deleting its owned SQLite
file, WAL/SHM and temporary workspace remnants. Do not remove the daily `.data`
database. Retain redacted evidence under ignored `.agents/artifacts/<run-id>/`
outside state. Supporting commands: `pnpm test`, `pnpm run typecheck`,
`pnpm run lint`, `pnpm run build`. Report each separately from live journeys.
Real Codex calls, auth-file copying and external sandbox configuration changes
need separate authority. Keep their coverage blocked in a no-spend audit.
