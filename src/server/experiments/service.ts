import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createExperimentSchema, neutralTask, normalizeWord, type CreateExperimentInput, CONTROL_LABEL } from "@/shared/domain";
import { conditions, experiments, generations, jobs, judgments } from "@/server/db/schema";
import { db, sqlite } from "@/server/db/client";
import { seededShuffle } from "./random";

const sdkVersion = "0.151.0";

export function createExperiment(inputValue: CreateExperimentInput): string {
  const input = createExperimentSchema.parse(inputValue);
  const id = randomUUID();
  const seed = randomBytes(32).toString("hex");
  const createdAt = new Date();
  const conditionRows = [
    { id: randomUUID(), experimentId: id, word: null, normalizedWord: CONTROL_LABEL, isControl: true, displayOrder: 0 },
    ...input.words.map((word, index) => ({
      id: randomUUID(), experimentId: id, word: word.trim(), normalizedWord: normalizeWord(word), isControl: false, displayOrder: index + 1,
    })),
  ];
  const labels = conditionRows.map((condition) => condition.word ?? CONTROL_LABEL);

  sqlite.transaction(() => {
    db.insert(experiments).values({
      id,
      name: input.name,
      basePrompt: input.basePrompt,
      neutralTask: neutralTask(input.basePrompt),
      seed,
      status: "queued",
      runsPerCondition: input.runsPerCondition,
      generatorModel: input.generatorModel,
      judgeModel: input.judgeModel,
      generatorReasoning: input.generatorReasoning,
      judgeReasoning: input.judgeReasoning,
      maxConcurrency: input.maxConcurrency,
      dimensionsJson: JSON.stringify(input.dimensions),
      sdkVersion,
      cancelRequested: false,
      createdAt,
      startedAt: createdAt,
    }).run();
    db.insert(conditions).values(conditionRows).run();
    for (const condition of conditionRows) {
      for (let runIndex = 1; runIndex <= input.runsPerCondition; runIndex += 1) {
        const generationId = randomUUID();
        const judgmentId = randomUUID();
        const now = new Date();
        db.insert(generations).values({
          id: generationId, experimentId: id, conditionId: condition.id, runIndex, status: "pending",
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
  const runRows = sqlite.prepare(`
    SELECT g.*, c.word, c.normalized_word, c.is_control, c.display_order,
      j.id AS judgment_id, j.status AS judgment_status, j.candidate_order_json,
      j.prediction, j.probabilities_json, j.modifier_present_probability,
      j.profile_scores_json, j.error AS judgment_error
    FROM generations g
    JOIN conditions c ON c.id = g.condition_id
    JOIN judgments j ON j.generation_id = g.id
    WHERE g.experiment_id = ?
    ORDER BY c.display_order, g.run_index
  `).all(id);
  const jobSummary = sqlite.prepare(`
    SELECT kind, state, COUNT(*) AS count FROM jobs WHERE experiment_id = ? GROUP BY kind, state
  `).all(id);
  const attemptRows = sqlite.prepare(`
    SELECT a.*, j.kind, j.target_id FROM attempts a JOIN jobs j ON j.id = a.job_id
    WHERE j.experiment_id = ? ORDER BY a.started_at
  `).all(id);
  return { experiment, conditions: conditionRows, runs: runRows, jobs: jobSummary, attempts: attemptRows };
}

export function cancelExperiment(id: string): boolean {
  const result = db.update(experiments).set({ cancelRequested: true, status: "canceled", completedAt: new Date() }).where(eq(experiments.id, id)).run();
  sqlite.prepare("UPDATE jobs SET state = 'canceled', updated_at = ? WHERE experiment_id = ? AND state = 'pending'").run(Date.now(), id);
  return result.changes > 0;
}

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}
