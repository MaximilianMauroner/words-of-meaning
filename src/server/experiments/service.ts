import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  CONTROL_LABEL,
  FIXED_BENCHMARK_MODEL,
  FIXED_BENCHMARK_REASONING,
  createExperimentSchema,
  neutralTask,
  normalizeWord,
  type ArtifactFormat,
  type CreateExperimentInput,
} from "@/shared/domain";
import { conditions, experiments, generations, jobs, judgments, tasks } from "@/server/db/schema";
import { db, sqlite } from "@/server/db/client";
import { seededShuffle } from "./random";

const sdkVersion = "0.151.0";

export function createExperiment(inputValue: CreateExperimentInput): string {
  const input = createExperimentSchema.parse(inputValue);
  const id = randomUUID();
  const seed = randomBytes(32).toString("hex");
  const createdAt = new Date();
  const defaultIsWriting = /\b(write|poem|paragraph|output\.md)\b/i.test(input.basePrompt);
  const defaultOutputFormat: ArtifactFormat = defaultIsWriting ? "markdown" : "plain_html_css";
  const taskInputs = input.tasks?.length ? input.tasks : [{
    id: "default-ui",
    name: defaultIsWriting ? "Default writing task" : "Default static design",
    family: defaultIsWriting ? "writing" : "ui",
    split: "regression" as const,
    placement: "inline" as const,
    prompt: input.basePrompt,
    outputFormat: defaultOutputFormat,
  }];
  const taskRows = taskInputs.map((task, index) => ({
    id: randomUUID(),
    experimentId: id,
    taskKey: task.id,
    name: task.name,
    family: task.family,
    split: task.split,
    placement: task.placement,
    prompt: task.prompt,
    neutralTask: neutralTask(task.prompt),
    outputFormat: task.outputFormat ?? (task.family === "ui" ? "plain_html_css" : "markdown"),
    displayOrder: index,
  }));
  const conditionRows = [
    { id: randomUUID(), experimentId: id, word: null, normalizedWord: CONTROL_LABEL, isControl: true, displayOrder: 0 },
    ...input.words.map((word, index) => ({
      id: randomUUID(), experimentId: id, word: word.trim(), normalizedWord: normalizeWord(word), isControl: false, displayOrder: index + 1,
    })),
  ];
  // The control is generated and profiled, but it is not an adjective identity.
  // Exact classification is conditional on a modifier being present.
  const labels = conditionRows.filter((condition) => !condition.isControl).map((condition) => condition.word!);

  sqlite.transaction(() => {
    db.insert(experiments).values({
      id,
      name: input.name,
      basePrompt: input.basePrompt,
      neutralTask: neutralTask(input.basePrompt),
      seed,
      status: "queued",
      runsPerCondition: input.runsPerCondition,
      generatorModel: FIXED_BENCHMARK_MODEL,
      judgeModel: FIXED_BENCHMARK_MODEL,
      generatorReasoning: FIXED_BENCHMARK_REASONING,
      judgeReasoning: FIXED_BENCHMARK_REASONING,
      maxConcurrency: input.maxConcurrency,
      dimensionsJson: JSON.stringify(input.dimensions),
      sdkVersion,
      cancelRequested: false,
      createdAt,
      startedAt: createdAt,
    }).run();
    db.insert(conditions).values(conditionRows).run();
    db.insert(tasks).values(taskRows).run();
    for (const task of taskRows) for (const condition of conditionRows) {
      for (let runIndex = 1; runIndex <= input.runsPerCondition; runIndex += 1) {
        const generationId = randomUUID();
        const judgmentId = randomUUID();
        const now = new Date();
        db.insert(generations).values({
          id: generationId, experimentId: id, conditionId: condition.id, taskId: task.id, runIndex, status: "pending",
        }).run();
        db.insert(judgments).values({
          id: judgmentId,
          generationId,
          status: "waiting_for_generation",
          candidateOrderJson: JSON.stringify(seededShuffle(labels, seed, judgmentId)),
        }).run();
        db.insert(jobs).values({
          id: randomUUID(), experimentId: id, kind: "generate", targetId: generationId,
          state: "pending", retryCount: 0, maxRetries: 2, createdAt: now, updatedAt: now,
        }).run();
      }
    }
  })();
  return id;
}

export function listExperiments() {
  return sqlite.prepare(`
    SELECT e.*,
      COUNT(DISTINCT g.id) AS generation_count,
      SUM(CASE WHEN g.status = 'succeeded' THEN 1 ELSE 0 END) AS generations_succeeded,
      SUM(CASE WHEN j.prediction IS NOT NULL THEN 1 ELSE 0 END) AS classifications_succeeded,
      SUM(CASE WHEN j.profile_scores_json IS NOT NULL THEN 1 ELSE 0 END) AS profiles_succeeded
    FROM experiments e
    LEFT JOIN generations g ON g.experiment_id = e.id
    LEFT JOIN judgments j ON j.generation_id = g.id
    GROUP BY e.id ORDER BY e.created_at DESC
  `).all();
}

export function getExperiment(id: string) {
  const experiment = sqlite.prepare("SELECT * FROM experiments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!experiment) return null;
  const conditionRows = sqlite.prepare("SELECT * FROM conditions WHERE experiment_id = ? ORDER BY display_order").all(id);
  const taskRows = sqlite.prepare("SELECT * FROM tasks WHERE experiment_id = ? ORDER BY display_order").all(id);
  const runRows = sqlite.prepare(`
    SELECT g.*, t.task_key, t.name AS task_name, t.family AS task_family, t.split AS task_split,
      t.placement AS task_placement, t.prompt AS task_prompt, t.neutral_task AS task_neutral_task,
      t.output_format AS task_output_format,
      c.word, c.normalized_word, c.is_control, c.display_order,
      j.id AS judgment_id, j.status AS judgment_status, j.candidate_order_json,
      j.prediction, j.probabilities_json, j.modifier_present_probability,
      j.profile_scores_json, j.error AS judgment_error
    FROM generations g
    JOIN conditions c ON c.id = g.condition_id
    LEFT JOIN tasks t ON t.id = g.task_id
    JOIN judgments j ON j.generation_id = g.id
    WHERE g.experiment_id = ?
    ORDER BY COALESCE(t.display_order, 0), c.display_order, g.run_index
  `).all(id);
  const jobSummary = sqlite.prepare(`
    SELECT kind, state, COUNT(*) AS count FROM jobs WHERE experiment_id = ? GROUP BY kind, state
  `).all(id);
  const attemptRows = sqlite.prepare(`
    SELECT a.*, j.kind, j.target_id FROM attempts a JOIN jobs j ON j.id = a.job_id
    WHERE j.experiment_id = ? ORDER BY a.started_at
  `).all(id);
  return { experiment, conditions: conditionRows, tasks: taskRows, runs: runRows, jobs: jobSummary, attempts: attemptRows };
}

export function cancelExperiment(id: string): boolean {
  const result = db.update(experiments).set({ cancelRequested: true, status: "canceled", completedAt: new Date() }).where(eq(experiments.id, id)).run();
  sqlite.prepare("UPDATE jobs SET state = 'canceled', updated_at = ? WHERE experiment_id = ? AND state = 'pending'").run(Date.now(), id);
  return result.changes > 0;
}

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}
