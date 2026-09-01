# Words of Meaning

Words of Meaning is a local blind prompt-identification benchmark. It tests whether qualitative instructions such as `elegant`, `lovely`, or `polished` leave recognizable effects in generated source code.

The benchmark measures observable behavior. It cannot establish that a model has a particular hidden definition of a word.

## What it runs

For every word and the required no-word control, the app:

1. Starts a fresh Codex process and thread to generate source files.
2. Normalizes the generated files into a path-neutral source bundle.
3. Starts a fresh blind judge to assign probabilities to every candidate word.
4. Starts another fresh judge to score behavioral dimensions from 1 to 7.
5. Computes identification accuracy, log loss, per-word recall, a confusion matrix, control detection, and control-relative behavioral profiles.

Five words with five runs create 30 outputs and 90 Codex calls.

## Isolation contract

Each generation, classification, and profile evaluation gets:

- a short-lived OS child process;
- a new `Codex` SDK instance;
- one new thread with one turn;
- a unique temporary workspace outside this repository;
- a temporary `CODEX_HOME` containing only a mode `0600` copy of `auth.json`;
- workspace-write sandboxing, disabled network access, no approvals, and no extra readable directories.

The child receives one JSON envelope over standard input. Judge envelopes contain the adjective-free task, one canonical source bundle, and either the randomized candidate list or fixed scoring rubric. They do not contain condition IDs, the rendered generation prompt, run indexes, generator thread IDs, or the true label as a separate field.

The parent process owns SQLite and joins truth only when calculating results. Interrupted jobs resume with a new process, thread, and workspace. The app retains the interrupted attempt for inspection.

All runs still share the selected model, account, installed SDK, and provider service. The benchmark records local settings but cannot inspect provider-side state.

On Linux hosts that disable unprivileged user namespaces, the Codex workspace sandbox cannot start. Set `WORDS_EXTERNAL_SANDBOX=1` to use the app's outer Bubblewrap sandbox instead. It mounts the project read-only, gives each call private workspace, Codex home, and temporary directories, and drops the worker to uid 1000 with no capabilities. This fallback permits process-level network access because the SDK needs the provider connection. The model prompt forbids network use, but the kernel does not enforce that restriction in this mode. Preflight reports both `externalMountSandbox: true` and `networkDisabled: false` so experiments cannot mistake the fallback for network isolation.

## Requirements

- Node.js 20 or newer
- A file-backed Codex login created by `codex login`

The app uses `@openai/codex-sdk` with the existing Codex sign-in. It does not accept an API key. Account credits, rate limits, and usage rules still apply.

## Run locally

```bash
npm install
codex login
npm run dev
```

Open `http://localhost:3000`. The isolation preflight blocks experiments until it can find the local Codex `auth.json` file.

Data lives in `.data/words-of-meaning.sqlite`. Override the path with `WORDS_DB_PATH`. Each experiment has its own concurrency setting, which defaults to one. `WORDS_MAX_CONCURRENCY` sets a global cap and defaults to eight.

## Validate

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

The test suite includes two consecutive fake model calls and a full three-stage experiment. It asserts distinct process IDs, thread IDs, and workspace fingerprints. It also tests immediate recovery of an interrupted job.

JSON exports include an opaque `isolation_id` for every attempt. Distinct values prove that the app allocated a new temporary workspace for each generation, classification, and profile call without exposing the temporary path.

For development without Codex usage, set `WORDS_FAKE_CODEX=1`. Fake mode is visible in preflight and should never be used to interpret word behavior.

## Reading results

Primary metrics exclude failed generations and source bundles that contain the condition word. The result screen shows every exclusion and denominator.

The result screen and JSON export report a one-sided exact binomial test against random-guessing accuracy and a 95% Wilson interval for observed accuracy. A p-value below 0.05 says the identification rate is above chance for that experiment. It does not establish why the outputs differ or what the model represents internally.

With five runs, one classification changes per-word accuracy by 20 percentage points. Use five while developing the experiment. Use 20 to 50 runs before comparing words seriously.

The OpenAI Codex SDK documentation is at <https://learn.chatgpt.com/docs/codex-sdk>.
