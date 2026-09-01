import "server-only";

import { randomUUID } from "node:crypto";
import { renderPrompt, validateClassification, validateProfile, type ReasoningEffort } from "@/shared/domain";
import type { WorkerEnvelope } from "@/shared/worker";
import { forbiddenJudgeFields } from "@/shared/worker";
import { sqlite } from "@/server/db/client";
import { containsWordLeak } from "@/server/artifacts/canonicalize";
import { runIsolatedCall } from "@/server/runner/isolation";

type JobRow = {
  id: string;
  experiment_id: string;
  kind: "generate" | "classify" | "profile";
  target_id: string;
  retry_count: number;
  max_retries: number;
};

type GenerationContext = {
  generation_id: string;
  word: string | null;
  base_prompt: string;
  generator_model: string;
  generator_reasoning: ReasoningEffort;
};

type JudgeContext = {
  judgment_id: string;
  neutral_task: string;
  artifact_bundle: string;
  candidate_order_json: string;
  dimensions_json: string;
  judge_model: string;
  judge_reasoning: ReasoningEffort;
};

const globalScheduler = globalThis as typeof globalThis & {
  wordsSchedulerRunning?: boolean;
  wordsSchedulerTimer?: NodeJS.Timeout;
  wordsAbortControllers?: Map<string, AbortController>;
};

globalScheduler.wordsAbortControllers ??= new Map();

function claimJob(): JobRow | null {
  const owner = randomUUID();
  const now = Date.now();
  const leaseExpiry = now + 12 * 60_000;
  return sqlite.transaction(() => {
    sqlite.prepare(`UPDATE jobs SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL
      WHERE state = 'running' AND lease_expires_at < ?`).run(now);
    const job = sqlite.prepare(`
      SELECT j.* FROM jobs j JOIN experiments e ON e.id = j.experiment_id
      WHERE j.state = 'pending' AND e.cancel_requested = 0
        AND (SELECT COUNT(*) FROM jobs active WHERE active.experiment_id = j.experiment_id AND active.state = 'running') < e.max_concurrency
      ORDER BY CASE j.kind WHEN 'generate' THEN 0 WHEN 'classify' THEN 1 ELSE 2 END, j.created_at
      LIMIT 1
    `).get() as JobRow | undefined;
    if (!job) return null;
    const changed = sqlite.prepare(`UPDATE jobs SET state = 'running', lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND state = 'pending'`).run(owner, leaseExpiry, now, job.id);
    return changed.changes === 1 ? job : null;
  })();
}

function generationEnvelope(job: JobRow): { envelope: WorkerEnvelope; context: GenerationContext } {
  const context = sqlite.prepare(`
    SELECT g.id AS generation_id, c.word, e.base_prompt, e.generator_model, e.generator_reasoning
    FROM generations g JOIN conditions c ON c.id = g.condition_id
    JOIN experiments e ON e.id = g.experiment_id WHERE g.id = ?
  `).get(job.target_id) as GenerationContext | undefined;
  if (!context) throw new Error("Generation target is missing");
  return {
    envelope: {
      kind: "generate",
      settings: { model: context.generator_model, reasoningEffort: context.generator_reasoning },
      prompt: renderPrompt(context.base_prompt, context.word),
    },
    context,
  };
}

function judgeEnvelope(job: JobRow): { envelope: WorkerEnvelope; context: JudgeContext } {
  const context = sqlite.prepare(`
    SELECT j.id AS judgment_id, e.neutral_task, g.artifact_bundle, j.candidate_order_json,
      e.dimensions_json, e.judge_model, e.judge_reasoning
    FROM judgments j JOIN generations g ON g.id = j.generation_id
    JOIN experiments e ON e.id = g.experiment_id WHERE j.id = ?
  `).get(job.target_id) as JudgeContext | undefined;
  if (!context?.artifact_bundle) throw new Error("Judge target has no source bundle");
  const settings = { model: context.judge_model, reasoningEffort: context.judge_reasoning };
  const envelope: WorkerEnvelope = job.kind === "classify" ? {
    kind: "classify",
    settings,
    neutralTask: context.neutral_task,
    sourceBundle: context.artifact_bundle,
    candidates: JSON.parse(context.candidate_order_json) as string[],
  } : {
    kind: "profile",
    settings,
    neutralTask: context.neutral_task,
    sourceBundle: context.artifact_bundle,
    dimensions: JSON.parse(context.dimensions_json),
  };
  const forbidden = forbiddenJudgeFields(JSON.stringify(envelope));
  if (forbidden.length) throw new Error(`Blind envelope contains forbidden fields: ${forbidden.join(", ")}`);
  return { envelope, context };
}

function recordAttemptStart(job: JobRow, ordinal: number, metadata: { processId: number; workspaceFingerprint: string; inputHash: string }): string {
  const id = randomUUID();
  sqlite.prepare(`INSERT INTO attempts
    (id, job_id, ordinal, process_id, workspace_fingerprint, input_hash, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    id, job.id, ordinal, metadata.processId, metadata.workspaceFingerprint, metadata.inputHash, Date.now(),
  );
  return id;
}

function scheduleJudges(job: JobRow, judgmentId: string) {
  const now = Date.now();
  for (const kind of ["classify", "profile"] as const) {
    sqlite.prepare(`INSERT OR IGNORE INTO jobs
      (id, experiment_id, kind, target_id, state, retry_count, max_retries, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', 0, 2, ?, ?)`).run(randomUUID(), job.experiment_id, kind, judgmentId, now, now);
  }
  sqlite.prepare("UPDATE judgments SET status = 'pending' WHERE id = ?").run(judgmentId);
}

function updateExperimentStatus(experimentId: string) {
  const counts = sqlite.prepare(`SELECT
    SUM(CASE WHEN state IN ('pending', 'running') THEN 1 ELSE 0 END) AS active,
    SUM(CASE WHEN state = 'failed_final' THEN 1 ELSE 0 END) AS failed
    FROM jobs WHERE experiment_id = ?`).get(experimentId) as { active: number; failed: number };
  if (counts.active > 0) {
    sqlite.prepare("UPDATE experiments SET status = 'running' WHERE id = ? AND cancel_requested = 0").run(experimentId);
    return;
  }
  const status = counts.failed > 0 ? "completed_with_failures" : "completed";
  sqlite.prepare("UPDATE experiments SET status = ?, completed_at = ? WHERE id = ? AND cancel_requested = 0").run(status, Date.now(), experimentId);
}

async function executeJob(job: JobRow) {
  const controller = new AbortController();
  globalScheduler.wordsAbortControllers!.set(job.id, controller);
  const ordinalRow = sqlite.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM attempts WHERE job_id = ?").get(job.id) as { ordinal: number };
  const ordinal = ordinalRow.ordinal;
  let attemptId: string | null = null;
  try {
    const built = job.kind === "generate" ? generationEnvelope(job) : judgeEnvelope(job);
    const call = await runIsolatedCall(built.envelope, controller.signal, (metadata) => {
      attemptId = recordAttemptStart(job, ordinal, metadata);
    });
    if (!attemptId) throw new Error("Worker did not report process metadata");
    sqlite.transaction(() => {
      sqlite.prepare(`UPDATE attempts SET thread_id = ?, output_hash = ?, completed_at = ?, exit_code = 0 WHERE id = ?`)
        .run(call.result.threadId, call.outputHash, Date.now(), attemptId);
      if (job.kind === "generate") {
        if (!call.artifact) throw new Error("Generation returned no artifact");
        const context = built.context as GenerationContext;
        const leak = containsWordLeak(call.artifact.bundle, context.word);
        sqlite.prepare(`UPDATE generations SET status = 'succeeded', artifact_bundle = ?, artifact_manifest_json = ?,
          artifact_hash = ?, artifact_bytes = ?, word_leak = ?, error = NULL WHERE id = ?`).run(
          call.artifact.bundle, JSON.stringify(call.artifact.manifest), call.artifact.hash,
          call.artifact.bytes, leak ? 1 : 0, job.target_id,
        );
        const judgment = sqlite.prepare("SELECT id FROM judgments WHERE generation_id = ?").get(job.target_id) as { id: string };
        scheduleJudges(job, judgment.id);
      } else if (job.kind === "classify") {
        const context = built.context as JudgeContext;
        const candidates = JSON.parse(context.candidate_order_json) as string[];
        const parsed = validateClassification(JSON.parse(call.result.finalResponse), candidates);
        sqlite.prepare(`UPDATE judgments SET prediction = ?, probabilities_json = ?, modifier_present_probability = ?, error = NULL WHERE id = ?`).run(
          parsed.prediction, JSON.stringify(parsed.probabilities), Math.round(parsed.modifier_present_probability * 1_000_000), job.target_id,
        );
      } else {
        const context = built.context as JudgeContext;
        const dimensions = JSON.parse(context.dimensions_json) as { key: string }[];
        const parsed = validateProfile(JSON.parse(call.result.finalResponse), dimensions);
        sqlite.prepare("UPDATE judgments SET profile_scores_json = ?, error = NULL WHERE id = ?")
          .run(JSON.stringify(parsed.scores), job.target_id);
      }
      if (job.kind !== "generate") {
        sqlite.prepare(`UPDATE judgments SET status = CASE
          WHEN prediction IS NOT NULL AND profile_scores_json IS NOT NULL THEN 'succeeded' ELSE 'partial' END
          WHERE id = ?`).run(job.target_id);
      }
      sqlite.prepare("UPDATE jobs SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
        .run(Date.now(), job.id);
    })();
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Unknown job failure").slice(0, 2_000);
    sqlite.transaction(() => {
      if (attemptId) sqlite.prepare("UPDATE attempts SET completed_at = ?, exit_code = 1, error = ? WHERE id = ?").run(Date.now(), message, attemptId);
      const nextRetry = job.retry_count + 1;
      const final = nextRetry > job.max_retries;
      sqlite.prepare(`UPDATE jobs SET state = ?, retry_count = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(final ? "failed_final" : "pending", nextRetry, Date.now(), job.id);
      if (final && job.kind === "generate") {
        sqlite.prepare("UPDATE generations SET status = 'failed', error = ? WHERE id = ?").run(message, job.target_id);
        sqlite.prepare("UPDATE judgments SET status = 'blocked', error = ? WHERE generation_id = ?").run("Generation failed", job.target_id);
      } else if (final) {
        sqlite.prepare("UPDATE judgments SET status = 'failed', error = ? WHERE id = ?").run(message, job.target_id);
      }
    })();
  } finally {
    globalScheduler.wordsAbortControllers!.delete(job.id);
    updateExperimentStatus(job.experiment_id);
  }
}

async function schedulerLoop() {
  if (globalScheduler.wordsSchedulerRunning) return;
  globalScheduler.wordsSchedulerRunning = true;
  try {
    const concurrency = Math.max(1, Math.min(8, Number(process.env.WORDS_MAX_CONCURRENCY || 8)));
    const active = new Set<Promise<void>>();
    while (true) {
      while (active.size < concurrency) {
        const job = claimJob();
        if (!job) break;
        const execution = executeJob(job);
        active.add(execution);
        void execution.then(
          () => active.delete(execution),
          () => active.delete(execution),
        );
      }
      if (active.size === 0) break;
      await Promise.race(active);
    }
  } finally {
    globalScheduler.wordsSchedulerRunning = false;
  }
}

export function startScheduler() {
  void schedulerLoop();
}

export function recoverAndStartScheduler() {
  if (globalScheduler.wordsSchedulerRunning) return;
  const now = Date.now();
  sqlite.prepare(`UPDATE attempts SET completed_at = ?, exit_code = 1, error = 'Interrupted by process restart'
    WHERE completed_at IS NULL AND job_id IN (SELECT id FROM jobs WHERE state = 'running')`).run(now);
  sqlite.prepare(`UPDATE jobs SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL
    WHERE state = 'running'`).run();
  startScheduler();
}

export function abortExperimentJobs(experimentId: string) {
  const rows = sqlite.prepare("SELECT id FROM jobs WHERE experiment_id = ? AND state = 'running'").all(experimentId) as { id: string }[];
  rows.forEach(({ id }) => globalScheduler.wordsAbortControllers?.get(id)?.abort());
}
