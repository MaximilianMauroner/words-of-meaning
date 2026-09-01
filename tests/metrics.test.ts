import { describe, expect, it } from "vitest";
import { computeMetrics, type MetricRun } from "@/server/metrics/compute";

function run(overrides: Partial<MetricRun>): MetricRun {
  return {
    normalized_word: "control",
    word: null,
    is_control: 1,
    status: "succeeded",
    word_leak: 0,
    prediction: "control",
    probabilities_json: JSON.stringify({ control: 0.8, elegant: 0.2 }),
    modifier_present_probability: 100_000,
    profile_scores_json: JSON.stringify({ simplicity: 3 }),
    ...overrides,
  };
}

describe("metrics", () => {
  it("computes accuracy, confusion, loss, pair confusion, and control deltas", () => {
    const runs = [
      run({}),
      run({ normalized_word: "elegant", word: "elegant", is_control: 0, prediction: "elegant", probabilities_json: JSON.stringify({ control: 0.1, elegant: 0.9 }), profile_scores_json: JSON.stringify({ simplicity: 6 }) }),
      run({ normalized_word: "elegant", word: "elegant", is_control: 0, prediction: "control", probabilities_json: JSON.stringify({ control: 0.7, elegant: 0.3 }), profile_scores_json: JSON.stringify({ simplicity: 4 }) }),
    ];
    const metrics = computeMetrics(runs, ["simplicity"]);
    expect(metrics.accuracy).toBeCloseTo(2 / 3);
    expect(metrics.confusion.elegant.control).toBe(1);
    expect(metrics.confusion.elegant.elegant).toBe(1);
    expect(metrics.pairConfusions[0]).toEqual({ pair: ["control", "elegant"], count: 1 });
    expect(metrics.profiles.elegant.simplicity.delta).toBe(2);
    expect(metrics.logLoss).toBeGreaterThan(0);
    expect(metrics.significance.oneSidedPValue).toBeCloseTo(0.5);
    expect(metrics.significance.significant).toBe(false);
    expect(metrics.significance.accuracyWilson95).not.toBeNull();
  });

  it("excludes failed and word-leaking runs from primary metrics", () => {
    const metrics = computeMetrics([
      run({ word_leak: 1 }),
      run({ status: "failed" }),
    ], ["simplicity"]);
    expect(metrics.eligibleCount).toBe(0);
    expect(metrics.excludedCount).toBe(2);
    expect(metrics.accuracy).toBeNull();
    expect(metrics.significance.oneSidedPValue).toBeNull();
    expect(metrics.significance.accuracyWilson95).toBeNull();
  });
});
