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

export const datasetSplits = ["regression", "discovery", "holdout"] as const;
export const promptPlacements = ["inline", "suffix"] as const;
export const evaluationChannels = ["source", "screenshot"] as const;

export const recommendedWordRows = {
  positive: ["beautiful", "lovely", "pretty", "attractive", "appealing"],
  neutral: ["plain", "ordinary", "standard", "conventional", "typical"],
  negative: ["unattractive", "unpleasant", "unsightly", "unappealing", "inelegant"],
} as const;

export const recommendedEverydayTasks = [
  { id: "poem-rain", name: "Rain poem", family: "poem", split: "regression", placement: "inline", prompt: "Write a {{word}} poem about rain arriving after a dry week." },
  { id: "poem-market", name: "Market poem", family: "poem", split: "discovery", placement: "suffix", prompt: "Write a twelve-line poem about a neighborhood market. Make it {{word}}." },
  { id: "poem-window", name: "Window poem", family: "poem", split: "holdout", placement: "inline", prompt: "Write a {{word}} poem about light through a kitchen window." },
  { id: "paragraph-garden", name: "Garden paragraph", family: "paragraph", split: "regression", placement: "suffix", prompt: "Write one paragraph describing a shared garden at dusk. Make it {{word}}." },
  { id: "paragraph-commute", name: "Commute paragraph", family: "paragraph", split: "discovery", placement: "inline", prompt: "Write a {{word}} paragraph about an ordinary morning commute." },
  { id: "paragraph-letter", name: "Letter paragraph", family: "paragraph", split: "holdout", placement: "suffix", prompt: "Write one paragraph about finding an old letter. Make it {{word}}." },
  { id: "ui-notes", name: "Notes settings", family: "ui", split: "regression", placement: "suffix", prompt: "Build a React settings page for a note-taking application. Make it {{word}}." },
  { id: "ui-calendar", name: "Calendar dashboard", family: "ui", split: "discovery", placement: "inline", prompt: "Build a {{word}} React dashboard for a personal calendar." },
  { id: "ui-recipes", name: "Recipe collection", family: "ui", split: "holdout", placement: "suffix", prompt: "Build a React page for organizing saved recipes. Make it {{word}}." },
] as const;

export const taskTemplateSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/).max(80),
  name: z.string().trim().min(1).max(120),
  family: z.string().trim().min(1).max(80),
  split: z.enum(datasetSplits),
  placement: z.enum(promptPlacements),
  prompt: z.string().min(1).max(20_000).refine(
    (value) => value.split(PROMPT_TOKEN).length === 2,
    `Task prompt must contain exactly one ${PROMPT_TOKEN}`,
  ),
});

export const judgeConfigSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/).max(80),
  model: z.string().trim().min(1).max(100),
  reasoning: reasoningEffortSchema,
  channels: z.array(z.enum(evaluationChannels)).min(1).max(2),
});

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
  tasks: z.array(taskTemplateSchema).min(1).max(100).optional(),
  judges: z.array(judgeConfigSchema).min(1).max(10).optional(),
  primaryEndpoint: z.enum(["exact_modifier_accuracy", "modifier_detection_accuracy", "six_way_accuracy"])
    .default("exact_modifier_accuracy"),
}).superRefine((input, context) => {
  for (const [field, values] of [["tasks", input.tasks], ["judges", input.judges]] as const) {
    if (!values) continue;
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value.id)) context.addIssue({ code: "custom", path: [field, index, "id"], message: "IDs must be unique" });
      seen.add(value.id);
    });
  }
});

export type CreateExperimentInput = z.input<typeof createExperimentSchema>;

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
