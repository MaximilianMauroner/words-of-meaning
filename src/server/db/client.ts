import "server-only";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as schema from "./schema";

const globalDb = globalThis as typeof globalThis & {
  wordsSqlite?: Database.Database;
  wordsDb?: ReturnType<typeof drizzle<typeof schema>>;
};

function createClient() {
  const databasePath = process.env.WORDS_DB_PATH?.trim() || path.join(process.cwd(), ".data", "words-of-meaning.sqlite");
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const sqlite = new Database(databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, base_prompt TEXT NOT NULL, neutral_task TEXT NOT NULL,
      seed TEXT NOT NULL, status TEXT NOT NULL, runs_per_condition INTEGER NOT NULL,
      generator_model TEXT NOT NULL, judge_model TEXT NOT NULL, generator_reasoning TEXT NOT NULL,
      judge_reasoning TEXT NOT NULL, max_concurrency INTEGER NOT NULL, dimensions_json TEXT NOT NULL,
      sdk_version TEXT NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS conditions (
      id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      word TEXT, normalized_word TEXT NOT NULL, is_control INTEGER NOT NULL, display_order INTEGER NOT NULL,
      UNIQUE(experiment_id, normalized_word), UNIQUE(experiment_id, display_order)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      task_key TEXT NOT NULL, name TEXT NOT NULL, family TEXT NOT NULL, split TEXT NOT NULL,
      placement TEXT NOT NULL, prompt TEXT NOT NULL, neutral_task TEXT NOT NULL,
      output_format TEXT NOT NULL, display_order INTEGER NOT NULL,
      UNIQUE(experiment_id, task_key), UNIQUE(experiment_id, display_order)
    );
    CREATE TABLE IF NOT EXISTS generations (
      id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      condition_id TEXT NOT NULL REFERENCES conditions(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE, run_index INTEGER NOT NULL,
      status TEXT NOT NULL, artifact_bundle TEXT, artifact_manifest_json TEXT, artifact_hash TEXT,
      artifact_bytes INTEGER, word_leak INTEGER NOT NULL DEFAULT 0, error TEXT
    );
    CREATE TABLE IF NOT EXISTS judgments (
      id TEXT PRIMARY KEY, generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
      status TEXT NOT NULL, candidate_order_json TEXT NOT NULL, prediction TEXT, probabilities_json TEXT,
      modifier_present_probability INTEGER, profile_scores_json TEXT, error TEXT,
      UNIQUE(generation_id)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, target_id TEXT NOT NULL, state TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 2, lease_owner TEXT, lease_expires_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(kind, target_id)
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL,
      process_id INTEGER, workspace_fingerprint TEXT NOT NULL, thread_id TEXT, input_hash TEXT NOT NULL,
      output_hash TEXT, started_at INTEGER NOT NULL, completed_at INTEGER, exit_code INTEGER, error TEXT,
      UNIQUE(job_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS jobs_state_idx ON jobs(state, created_at);
    CREATE INDEX IF NOT EXISTS generations_experiment_idx ON generations(experiment_id);
  `);
  const generationColumns = sqlite.prepare("PRAGMA table_info(generations)").all() as Array<{ name: string }>;
  if (!generationColumns.some((column) => column.name === "task_id")) {
    // Rebuild the legacy table so its old UNIQUE(condition_id, run_index)
    // constraint cannot prevent the same word being run for several tasks.
    sqlite.exec("PRAGMA foreign_keys=OFF");
    sqlite.exec(`CREATE TABLE generations_new (
      id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      condition_id TEXT NOT NULL REFERENCES conditions(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE, run_index INTEGER NOT NULL,
      status TEXT NOT NULL, artifact_bundle TEXT, artifact_manifest_json TEXT, artifact_hash TEXT,
      artifact_bytes INTEGER, word_leak INTEGER NOT NULL DEFAULT 0, error TEXT
    )`);
    sqlite.exec(`INSERT INTO generations_new
      (id, experiment_id, condition_id, task_id, run_index, status, artifact_bundle, artifact_manifest_json,
       artifact_hash, artifact_bytes, word_leak, error)
      SELECT id, experiment_id, condition_id, NULL, run_index, status, artifact_bundle, artifact_manifest_json,
       artifact_hash, artifact_bytes, word_leak, error FROM generations`);
    sqlite.exec("DROP TABLE generations; ALTER TABLE generations_new RENAME TO generations; PRAGMA foreign_keys=ON");
  }
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS generations_condition_task_run_unique ON generations(condition_id, task_id, run_index); CREATE INDEX IF NOT EXISTS generations_experiment_idx ON generations(experiment_id)");
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

if (!globalDb.wordsSqlite || !globalDb.wordsDb) {
  const created = createClient();
  globalDb.wordsSqlite = created.sqlite;
  globalDb.wordsDb = created.db;
}

export const sqlite = globalDb.wordsSqlite;
export const db = globalDb.wordsDb;
