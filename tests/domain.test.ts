import { describe, expect, it } from "vitest";
import {
  CONTROL_LABEL,
  createExperimentSchema,
  neutralTask,
  normalizeWord,
  renderPrompt,
  validateClassification,
  validateProfile,
} from "@/shared/domain";

describe("experiment domain", () => {
  it("renders words and removes the control placeholder cleanly", () => {
    const prompt = "Build a page. Make it {{word}}.";
    expect(renderPrompt(prompt, "elegant")).toBe("Build a page. Make it elegant.");
    expect(neutralTask(prompt)).toBe("Build a page. Make it.");
  });

  it("normalizes Unicode and rejects duplicate words", () => {
    expect(normalizeWord("  ÉLÉGANT  ")).toBe("élégant");
    const result = createExperimentSchema.safeParse({
      name: "Duplicate test",
      basePrompt: "Make {{word}} code",
      words: ["Elegant", "elegant"],
      runsPerCondition: 5,
      generatorModel: "test",
      judgeModel: "test",
      generatorReasoning: "medium",
      judgeReasoning: "medium",
      maxConcurrency: 1,
    });
    expect(result.success).toBe(false);
  });

  it("reserves the control label", () => {
    const result = createExperimentSchema.safeParse({
      name: "Control test",
      basePrompt: "Make {{word}} code",
      words: [CONTROL_LABEL, "elegant"],
      runsPerCondition: 1,
      generatorModel: "test",
      judgeModel: "test",
      generatorReasoning: "low",
      judgeReasoning: "low",
      maxConcurrency: 1,
    });
    expect(result.success).toBe(false);
  });

  it("validates complete probability maps and argmax predictions", () => {
    expect(validateClassification({
      prediction: "elegant",
      modifier_present_probability: 0.8,
      probabilities: { control: 0.2, elegant: 0.8 },
    }, ["control", "elegant"]).prediction).toBe("elegant");
    expect(() => validateClassification({
      prediction: "control",
      modifier_present_probability: 0.5,
      probabilities: { control: 0.2, elegant: 0.8 },
    }, ["control", "elegant"])).toThrow(/maximum-probability/);
    expect(() => validateClassification({
      prediction: "elegant",
      modifier_present_probability: 0.5,
      probabilities: { control: 0.3, elegant: 0.3 },
    }, ["control", "elegant"])).toThrow(/sum to 1/);
  });

  it("requires five adjective probabilities and excludes control from exact identification", () => {
    const candidates = ["lovely", "beautiful", "elegant", "polished", "refined"];
    const result = validateClassification({
      prediction: "elegant",
      modifier_present_probability: 0.9,
      probabilities: {
        lovely: 0.1,
        beautiful: 0.15,
        elegant: 0.45,
        polished: 0.2,
        refined: 0.1,
      },
    }, candidates);
    expect(Object.keys(result.probabilities).sort()).toEqual([...candidates].sort());
    expect(() => validateClassification({
      prediction: "elegant",
      modifier_present_probability: 0.9,
      probabilities: {
        lovely: 0.1,
        beautiful: 0.15,
        elegant: 0.5,
        polished: 0.2,
        control: 0.05,
      },
    }, candidates)).toThrow(/labels/);
  });

  it("requires an exact profile key set", () => {
    expect(validateProfile({ scores: { simplicity: 5 } }, [{ key: "simplicity" }])).toEqual({ scores: { simplicity: 5 } });
    expect(() => validateProfile({ scores: { simplicity: 5, extra: 2 } }, [{ key: "simplicity" }])).toThrow(/labels/);
  });

  it("validates blocked task metadata, prompt placement, splits, and independent judges", () => {
    const result = createExperimentSchema.parse({
      name: "Task suite",
      basePrompt: "Write a {{word}} poem.",
      words: ["lovely", "beautiful", "pretty", "attractive", "appealing"],
      runsPerCondition: 5,
      generatorModel: "generator",
      judgeModel: "legacy-judge",
      generatorReasoning: "medium",
      judgeReasoning: "medium",
      maxConcurrency: 1,
      tasks: [
        { id: "poem-rain", name: "Rain poem", family: "poem", split: "regression", placement: "inline", prompt: "Write a {{word}} poem about rain." },
        { id: "poem-market", name: "Market poem", family: "poem", split: "holdout", placement: "suffix", prompt: "Write a poem about a market. Make it {{word}}." },
      ],
      judges: [
        { id: "judge-a", model: "judge-a", reasoning: "medium", channels: ["source"] },
        { id: "judge-b", model: "judge-b", reasoning: "medium", channels: ["source", "screenshot"] },
      ],
    });
    expect(result.primaryEndpoint).toBe("exact_modifier_accuracy");
    expect(result.tasks).toHaveLength(2);
    expect(result.judges).toHaveLength(2);
  });

  it("rejects markdown output for UI design tasks", () => {
    const result = createExperimentSchema.safeParse({
      name: "Static UI",
      basePrompt: "Build a {{word}} page.",
      words: ["elegant", "polished"],
      runsPerCondition: 1,
      generatorModel: "generator",
      judgeModel: "judge",
      generatorReasoning: "max",
      judgeReasoning: "max",
      maxConcurrency: 1,
      tasks: [{ id: "ui", name: "UI", family: "ui", split: "regression", placement: "inline", prompt: "Build a {{word}} page.", outputFormat: "markdown" }],
    });
    expect(result.success).toBe(false);
  });
});
