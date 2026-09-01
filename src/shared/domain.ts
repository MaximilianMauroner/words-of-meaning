import { z } from "zod";

export const CONTROL_LABEL = "control";
export const PROMPT_TOKEN = "{{word}}";

export const reasoningEfforts = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export const reasoningEffortSchema = z.enum(reasoningEfforts);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const defaultDimensions = [
  { key: "simplicity", label: "Simplicity", low: "many moving parts", mid: "ordinary complexity", high: "few clear moving parts" },
  { key: "abstraction", label: "Abstraction", low: "mostly concrete code", mid: "some reusable boundaries", high: "strong conceptual boundaries" },
  { key: "visual_ornamentation", label: "Visual ornamentation", low: "plain presentation", mid: "moderate decoration", high: "rich decorative treatment" },
  { key: "consistency", label: "Consistency", low: "uneven patterns", mid: "mostly consistent", high: "highly consistent patterns" },
  { key: "ux_detail", label: "UX detail", low: "few interaction details", mid: "expected interaction details", high: "many considered interaction details" },
  { key: "code_verbosity", label: "Code verbosity", low: "very concise", mid: "moderate", high: "very verbose" },
  { key: "defensive_programming", label: "Defensive programming", low: "assumes happy paths", mid: "handles common failures", high: "handles many edge cases" },
  { key: "modularity", label: "Modularity", low: "monolithic", mid: "some decomposition", high: "strong decomposition" },
  { key: "dependency_count", label: "Dependency count", low: "no added dependencies", mid: "a few dependencies", high: "many dependencies" },
  { key: "documentation", label: "Documentation", low: "little explanation", mid: "key choices explained", high: "extensive documentation" },
  { key: "type_strictness", label: "Type strictness", low: "loose types", mid: "ordinary strictness", high: "precise strict types" },
  { key: "accessibility", label: "Accessibility", low: "little accessibility support", mid: "common accessibility support", high: "thorough accessibility support" },
] as const;

export const dimensionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1).max(80),
  low: z.string().min(1).max(240),
  mid: z.string().min(1).max(240),
  high: z.string().min(1).max(240),
});

const wordSchema = z.string().trim().min(1).max(80);

export const createExperimentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  basePrompt: z.string().min(1).max(20_000).refine(
    (value) => value.split(PROMPT_TOKEN).length === 2,
    `Base prompt must contain exactly one ${PROMPT_TOKEN}`,
  ),
  words: z.array(wordSchema).min(2).max(20).superRefine((words, context) => {
    const seen = new Set<string>();
    words.forEach((word, index) => {
      const normalized = normalizeWord(word);
      if (normalized === CONTROL_LABEL) {
        context.addIssue({ code: "custom", path: [index], message: `"${CONTROL_LABEL}" is reserved` });
      }
      if (seen.has(normalized)) {
        context.addIssue({ code: "custom", path: [index], message: "Words must be unique" });
      }
      seen.add(normalized);
    });
  }),
  runsPerCondition: z.number().int().min(1).max(100),
  generatorModel: z.string().trim().min(1).max(100),
  judgeModel: z.string().trim().min(1).max(100),
  generatorReasoning: reasoningEffortSchema,
  judgeReasoning: reasoningEffortSchema,
  maxConcurrency: z.number().int().min(1).max(8).default(1),
  dimensions: z.array(dimensionSchema).min(1).max(30).default([...defaultDimensions]),
});

export type CreateExperimentInput = z.infer<typeof createExperimentSchema>;

export function normalizeWord(word: string): string {
  return word.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

export function renderPrompt(basePrompt: string, word: string | null): string {
  const rendered = basePrompt.replace(PROMPT_TOKEN, word ?? "");
  return rendered
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .trim();
}

export function neutralTask(basePrompt: string): string {
  return renderPrompt(basePrompt, null);
}

export const classificationResultSchema = z.object({
  prediction: z.string(),
  modifier_present_probability: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
});

export type ClassificationResult = z.infer<typeof classificationResultSchema>;

export function validateClassification(
  value: unknown,
  candidates: readonly string[],
): ClassificationResult {
  const parsed = classificationResultSchema.parse(value);
  const actualKeys = Object.keys(parsed.probabilities).sort();
  const expectedKeys = [...candidates].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error("Probability labels do not match the supplied candidates");
  }
  const sum = Object.values(parsed.probabilities).reduce((total, probability) => total + probability, 0);
  if (Math.abs(sum - 1) > 0.001) {
    throw new Error(`Probabilities must sum to 1, received ${sum}`);
  }
  const maximum = Math.max(...Object.values(parsed.probabilities));
  if (!(parsed.prediction in parsed.probabilities) || parsed.probabilities[parsed.prediction] !== maximum) {
    throw new Error("Prediction must be a maximum-probability candidate");
  }
  return parsed;
}

export const profileResultSchema = z.object({
  scores: z.record(z.string(), z.number().int().min(1).max(7).nullable()),
});

export type ProfileResult = z.infer<typeof profileResultSchema>;

export function validateProfile(value: unknown, dimensions: readonly { key: string }[]): ProfileResult {
  const parsed = profileResultSchema.parse(value);
  const actualKeys = Object.keys(parsed.scores).sort();
  const expectedKeys = dimensions.map((dimension) => dimension.key).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error("Profile score labels do not match the supplied dimensions");
  }
  return parsed;
}
