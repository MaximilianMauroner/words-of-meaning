CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`process_id` integer,
	`workspace_fingerprint` text NOT NULL,
	`thread_id` text,
	`input_hash` text NOT NULL,
	`output_hash` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`exit_code` integer,
	`error` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attempts_job_ordinal_unique` ON `attempts` (`job_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `conditions` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`word` text,
	`normalized_word` text NOT NULL,
	`is_control` integer NOT NULL,
	`display_order` integer NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conditions_experiment_word_unique` ON `conditions` (`experiment_id`,`normalized_word`);--> statement-breakpoint
CREATE UNIQUE INDEX `conditions_experiment_order_unique` ON `conditions` (`experiment_id`,`display_order`);--> statement-breakpoint
CREATE TABLE `experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_prompt` text NOT NULL,
	`neutral_task` text NOT NULL,
	`seed` text NOT NULL,
	`status` text NOT NULL,
	`runs_per_condition` integer NOT NULL,
	`generator_model` text NOT NULL,
	`judge_model` text NOT NULL,
	`generator_reasoning` text NOT NULL,
	`judge_reasoning` text NOT NULL,
	`max_concurrency` integer NOT NULL,
	`dimensions_json` text NOT NULL,
	`sdk_version` text NOT NULL,
	`cancel_requested` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `generations` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`condition_id` text NOT NULL,
	`run_index` integer NOT NULL,
	`status` text NOT NULL,
	`artifact_bundle` text,
	`artifact_manifest_json` text,
	`artifact_hash` text,
	`artifact_bytes` integer,
	`word_leak` integer DEFAULT false NOT NULL,
	`error` text,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`condition_id`) REFERENCES `conditions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `generations_condition_run_unique` ON `generations` (`condition_id`,`run_index`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`state` text NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`max_retries` integer DEFAULT 2 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_kind_target_unique` ON `jobs` (`kind`,`target_id`);--> statement-breakpoint
CREATE TABLE `judgments` (
	`id` text PRIMARY KEY NOT NULL,
	`generation_id` text NOT NULL,
	`status` text NOT NULL,
	`candidate_order_json` text NOT NULL,
	`prediction` text,
	`probabilities_json` text,
	`modifier_present_probability` integer,
	`profile_scores_json` text,
	`error` text,
	FOREIGN KEY (`generation_id`) REFERENCES `generations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `judgments_generation_unique` ON `judgments` (`generation_id`);