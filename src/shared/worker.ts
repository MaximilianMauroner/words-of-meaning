import { z } from "zod";
import { dimensionSchema, reasoningEffortSchema } from "./domain";

const settingsSchema = z.object({
  model: z.string().min(1),
  reasoningEffort: reasoningEffortSchema,
});

export const generateEnvelopeSchema = z.object({
  kind: z.literal("generate"),
  settings: settingsSchema,
  prompt: z.string().min(1),
});

export const classifyEnvelopeSchema = z.object({
  kind: z.literal("classify"),
  settings: settingsSchema,
  neutralTask: z.string().min(1),
  sourceBundle: z.string().min(1),
  candidates: z.array(z.string().min(1)).min(2),
});

export const profileEnvelopeSchema = z.object({
  kind: z.literal("profile"),
  settings: settingsSchema,
  neutralTask: z.string().min(1),
  sourceBundle: z.string().min(1),
  dimensions: z.array(dimensionSchema).min(1),
});

export const workerEnvelopeSchema = z.discriminatedUnion("kind", [
  generateEnvelopeSchema,
  classifyEnvelopeSchema,
  profileEnvelopeSchema,
]);

export type WorkerEnvelope = z.infer<typeof workerEnvelopeSchema>;

export const workerResultSchema = z.object({
  threadId: z.string().min(1),
  finalResponse: z.string(),
  usage: z.object({
    input_tokens: z.number(),
    cached_input_tokens: z.number(),
    cache_write_input_tokens: z.number(),
    output_tokens: z.number(),
    reasoning_output_tokens: z.number(),
  }).nullable(),
});

export type WorkerResult = z.infer<typeof workerResultSchema>;

export function forbiddenJudgeFields(serialized: string): string[] {
  return ["conditionId", "condition_id", "word", "renderedPrompt", "runIndex", "threadId"]
    .filter((field) => serialized.includes(`\"${field}\"`));
}
