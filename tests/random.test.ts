import { describe, expect, it } from "vitest";
import { seededShuffle } from "@/server/experiments/random";

describe("seededShuffle", () => {
  it("is repeatable and preserves every candidate", () => {
    const candidates = ["control", "lovely", "elegant", "polished"];
    const first = seededShuffle(candidates, "seed", "judgment-1");
    const second = seededShuffle(candidates, "seed", "judgment-1");
    expect(second).toEqual(first);
    expect([...first].sort()).toEqual([...candidates].sort());
    expect(seededShuffle(candidates, "seed", "judgment-2")).not.toEqual(first);
  });
});
