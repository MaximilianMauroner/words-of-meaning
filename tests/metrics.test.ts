import { describe, expect, it } from "vitest";
import { computeMetrics, type MetricRun } from "@/server/metrics/compute";

function run(overrides: Partial<MetricRun>): MetricRun {
  return {
    normalized_word: "control",
    word: null,
    is_control: 1,
    status: "succeeded",
    word_leak: 0,
    prediction: "elegant",
    probabilities_json: JSON.stringify({ elegant: 0.6, polished: 0.4 }),
    modifier_present_probability: 100_000,
    profile_scores_json: JSON.stringify({ simplicity: 3 }),
    ...overrides,
  };
}

describe("metrics", () => {
  it("computes accuracy, confusion, loss, pair confusion, and control deltas", () => {
    const runs = [
      run({}),
      run({ normalized_word: "elegant", word: "elegant", is_control: 0, prediction: "elegant", probabilities_json: JSON.stringify({ elegant: 0.9, polished: 0.1 }), modifier_present_probability: 900_000, profile_scores_json: JSON.stringify({ simplicity: 6 }) }),
      run({ normalized_word: "elegant", word: "elegant", is_control: 0, prediction: "polished", probabilities_json: JSON.stringify({ elegant: 0.3, polished: 0.7 }), modifier_present_probability: 400_000, profile_scores_json: JSON.stringify({ simplicity: 4 }) }),
      run({ normalized_word: "polished", word: "polished", is_control: 0, prediction: "polished", probabilities_json: JSON.stringify({ elegant: 0.1, polished: 0.9 }), modifier_present_probability: 900_000, profile_scores_json: JSON.stringify({ simplicity: 5 }) }),
    ];
    const metrics = computeMetrics(runs, ["simplicity"]);
    expect(metrics.accuracy).toBeCloseTo(2 / 3);
    expect(metrics.confusion.elegant.polished).toBe(1);
    expect(metrics.confusion.elegant.elegant).toBe(1);
    expect(metrics.pairConfusions[0]).toEqual({ pair: ["elegant", "polished"], count: 1 });
    expect(metrics.profiles.elegant.simplicity.delta).toBe(2);
    expect(metrics.logLoss).toBeGreaterThan(0);
    expect(metrics.significance.oneSidedPValue).toBeCloseTo(0.5);
    expect(metrics.significance.significant).toBe(false);
    expect(metrics.significance.accuracyWilson95).not.toBeNull();
    expect(metrics.hierarchical.exactModifier.accuracy).toBeCloseTo(2 / 3);
    expect(metrics.hierarchical.modifierDetection.accuracy).toBeCloseTo(3 / 4);
  });

  it("excludes failed and word-leaking runs from primary metrics", () => {
    const metrics = computeMetrics([
      run({ normalized_word: "elegant", word: "elegant", is_control: 0, word_leak: 1 }),
      run({ normalized_word: "polished", word: "polished", is_control: 0, status: "failed" }),
    ], ["simplicity"]);
    expect(metrics.eligibleCount).toBe(0);
    expect(metrics.excludedCount).toBe(2);
    expect(metrics.accuracy).toBeNull();
    expect(metrics.significance.oneSidedPValue).toBeNull();
    expect(metrics.significance.accuracyWilson95).toBeNull();
  });

  it("resamples whole task blocks when several task templates are present", () => {
    const rows = ["task-a", "task-b"].flatMap((task_id) => [
      run({ task_id }),
      run({ task_id, normalized_word: "elegant", word: "elegant", is_control: 0, prediction: "elegant", probabilities_json: JSON.stringify({ control: 0.1, elegant: 0.9 }), modifier_present_probability: 900_000 }),
    ]);
    const metrics = computeMetrics(rows, ["simplicity"]);
    expect(metrics.taskAware.taskCount).toBe(2);
    expect(metrics.taskAware.taskBootstrapAccuracy95).toEqual([1, 1]);
    expect(metrics.taskAware.blockedPermutationPValue).not.toBeNull();
  });
});
