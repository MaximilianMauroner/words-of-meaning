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

  it("requires an exact profile key set", () => {
    expect(validateProfile({ scores: { simplicity: 5 } }, [{ key: "simplicity" }])).toEqual({ scores: { simplicity: 5 } });
    expect(() => validateProfile({ scores: { simplicity: 5, extra: 2 } }, [{ key: "simplicity" }])).toThrow(/labels/);
  });
});
