import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const experiments = sqliteTable("experiments", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  basePrompt: text("base_prompt").notNull(),
  neutralTask: text("neutral_task").notNull(),
  seed: text("seed").notNull(),
  status: text("status").notNull(),
  runsPerCondition: integer("runs_per_condition").notNull(),
  generatorModel: text("generator_model").notNull(),
  judgeModel: text("judge_model").notNull(),
  generatorReasoning: text("generator_reasoning").notNull(),
  judgeReasoning: text("judge_reasoning").notNull(),
  maxConcurrency: integer("max_concurrency").notNull(),
  dimensionsJson: text("dimensions_json").notNull(),
  sdkVersion: text("sdk_version").notNull(),
  cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
});

export const conditions = sqliteTable("conditions", {
  id: text("id").primaryKey(),
  experimentId: text("experiment_id").notNull().references(() => experiments.id, { onDelete: "cascade" }),
  word: text("word"),
  normalizedWord: text("normalized_word").notNull(),
  isControl: integer("is_control", { mode: "boolean" }).notNull(),
  displayOrder: integer("display_order").notNull(),
}, (table) => [
  uniqueIndex("conditions_experiment_word_unique").on(table.experimentId, table.normalizedWord),
  uniqueIndex("conditions_experiment_order_unique").on(table.experimentId, table.displayOrder),
]);

export const generations = sqliteTable("generations", {
  id: text("id").primaryKey(),
  experimentId: text("experiment_id").notNull().references(() => experiments.id, { onDelete: "cascade" }),
  conditionId: text("condition_id").notNull().references(() => conditions.id, { onDelete: "cascade" }),
  runIndex: integer("run_index").notNull(),
  status: text("status").notNull(),
  artifactBundle: text("artifact_bundle"),
  artifactManifestJson: text("artifact_manifest_json"),
  artifactHash: text("artifact_hash"),
  artifactBytes: integer("artifact_bytes"),
  wordLeak: integer("word_leak", { mode: "boolean" }).notNull().default(false),
  error: text("error"),
}, (table) => [uniqueIndex("generations_condition_run_unique").on(table.conditionId, table.runIndex)]);

export const judgments = sqliteTable("judgments", {
  id: text("id").primaryKey(),
  generationId: text("generation_id").notNull().references(() => generations.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  candidateOrderJson: text("candidate_order_json").notNull(),
  prediction: text("prediction"),
  probabilitiesJson: text("probabilities_json"),
  modifierPresentProbability: integer("modifier_present_probability"),
  profileScoresJson: text("profile_scores_json"),
  error: text("error"),
}, (table) => [uniqueIndex("judgments_generation_unique").on(table.generationId)]);

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  experimentId: text("experiment_id").notNull().references(() => experiments.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  targetId: text("target_id").notNull(),
  state: text("state").notNull(),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(2),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("jobs_kind_target_unique").on(table.kind, table.targetId)]);

export const attempts = sqliteTable("attempts", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobs.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  processId: integer("process_id"),
  workspaceFingerprint: text("workspace_fingerprint").notNull(),
  threadId: text("thread_id"),
  inputHash: text("input_hash").notNull(),
  outputHash: text("output_hash"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  exitCode: integer("exit_code"),
  error: text("error"),
}, (table) => [uniqueIndex("attempts_job_ordinal_unique").on(table.jobId, table.ordinal)]);
