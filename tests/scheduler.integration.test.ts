import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let root = "";

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "words-scheduler-test-"));
  process.env.WORDS_DB_PATH = path.join(root, "test.sqlite");
  process.env.WORDS_FAKE_CODEX = "1";
  process.env.WORDS_MAX_CONCURRENCY = "2";
});

afterAll(async () => {
  delete process.env.WORDS_DB_PATH;
  delete process.env.WORDS_FAKE_CODEX;
  delete process.env.WORDS_MAX_CONCURRENCY;
  await rm(root, { recursive: true, force: true });
});

describe("experiment scheduler", () => {
  it("finishes every stage with unique isolation evidence", async () => {
    const { createExperiment, getExperiment } = await import("@/server/experiments/service");
    const { startScheduler } = await import("@/server/jobs/scheduler");
    const id = createExperiment({
      name: "Scheduler integration",
      basePrompt: "Build a component. Make it {{word}}.",
      words: ["elegant", "polished"],
      runsPerCondition: 1,
      generatorModel: "fake",
      judgeModel: "fake",
      generatorReasoning: "low",
      judgeReasoning: "low",
      maxConcurrency: 2,
      dimensions: [{ key: "simplicity", label: "Simplicity", low: "complex", mid: "ordinary", high: "simple" }],
    });
    startScheduler();

    let result = getExperiment(id)!;
    for (let attempt = 0; attempt < 300 && result.experiment.status !== "completed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      result = getExperiment(id)!;
    }
    expect(result.experiment.status).toBe("completed");
    expect(result.experiment.generator_model).toBe("gpt-5.6-luna");
    expect(result.experiment.generator_reasoning).toBe("max");
    expect(result.experiment.judge_model).toBe("gpt-5.6-luna");
    expect(result.experiment.judge_reasoning).toBe("max");
    expect(result.runs).toHaveLength(3);
    expect(result.attempts).toHaveLength(9);
    for (const run of result.runs as Array<{ candidate_order_json: string }>) {
      expect(JSON.parse(run.candidate_order_json).sort()).toEqual(["elegant", "polished"]);
    }
    const attempts = result.attempts as Array<{ process_id: number; workspace_fingerprint: string; thread_id: string }>;
    expect(new Set(attempts.map((attempt) => attempt.process_id)).size).toBe(9);
    expect(new Set(attempts.map((attempt) => attempt.workspace_fingerprint)).size).toBe(9);
    expect(new Set(attempts.map((attempt) => attempt.thread_id)).size).toBe(9);
  }, 60_000);

  it("reclaims an interrupted job immediately and records the interruption", async () => {
    const { createExperiment, getExperiment } = await import("@/server/experiments/service");
    const { recoverAndStartScheduler } = await import("@/server/jobs/scheduler");
    const { sqlite } = await import("@/server/db/client");
    const id = createExperiment({
      name: "Recovery integration",
      basePrompt: "Build a component. Make it {{word}}.",
      words: ["elegant", "polished"],
      runsPerCondition: 1,
      generatorModel: "fake",
      judgeModel: "fake",
      generatorReasoning: "low",
      judgeReasoning: "low",
      maxConcurrency: 1,
      dimensions: [{ key: "simplicity", label: "Simplicity", low: "complex", mid: "ordinary", high: "simple" }],
    });
    const job = sqlite.prepare("SELECT id FROM jobs WHERE experiment_id = ? ORDER BY created_at LIMIT 1").get(id) as { id: string };
    sqlite.prepare("UPDATE jobs SET state = 'running', lease_owner = 'dead-process', lease_expires_at = ? WHERE id = ?")
      .run(Date.now() + 60_000, job.id);
    sqlite.prepare(`INSERT INTO attempts
      (id, job_id, ordinal, process_id, workspace_fingerprint, input_hash, started_at)
      VALUES (?, ?, 1, 999999, 'old-workspace', 'old-input', ?)`).run(randomUUID(), job.id, Date.now());

    recoverAndStartScheduler();
    let result = getExperiment(id)!;
    for (let attempt = 0; attempt < 300 && result.experiment.status !== "completed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      result = getExperiment(id)!;
    }
    expect(result.experiment.status).toBe("completed");
    const interrupted = (result.attempts as Array<{ process_id: number; completed_at: number | null; error: string | null }>).find((attempt) => attempt.process_id === 999999);
    expect(interrupted?.completed_at).not.toBeNull();
    expect(interrupted?.error).toBe("Interrupted by process restart");
  }, 60_000);

  it("runs every selected design as an isolated plain HTML/CSS task", async () => {
    const { createExperiment, getExperiment } = await import("@/server/experiments/service");
    const { startScheduler } = await import("@/server/jobs/scheduler");
    const id = createExperiment({
      name: "Multiple static designs",
      basePrompt: "Build a static {{word}} page.",
      words: ["elegant", "polished"],
      runsPerCondition: 1,
      generatorModel: "fake",
      judgeModel: "fake",
      generatorReasoning: "low",
      judgeReasoning: "low",
      maxConcurrency: 2,
      dimensions: [{ key: "simplicity", label: "Simplicity", low: "complex", mid: "ordinary", high: "simple" }],
      tasks: [
        { id: "notes", name: "Notes page", family: "ui", split: "regression", placement: "inline", prompt: "Build a {{word}} notes page as plain HTML and CSS." },
        { id: "calendar", name: "Calendar page", family: "ui", split: "holdout", placement: "suffix", prompt: "Build a calendar page. Make it {{word}} using plain HTML and CSS." },
      ],
    });
    startScheduler();
    let result = getExperiment(id)!;
    for (let attempt = 0; attempt < 300 && result.experiment.status !== "completed"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      result = getExperiment(id)!;
    }
    expect(result.experiment.status).toBe("completed");
    expect(result.runs).toHaveLength(6);
    const taskRuns = result.runs as Array<{ task_key: string; artifact_manifest_json: string }>;
    expect(new Set(taskRuns.map((run) => run.task_key))).toEqual(new Set(["notes", "calendar"]));
    for (const run of taskRuns) {
      const paths = JSON.parse(run.artifact_manifest_json).map((file: { originalPath: string }) => file.originalPath).sort();
      expect(paths).toEqual(["index.html", "styles.css"]);
    }
  }, 60_000);
});
