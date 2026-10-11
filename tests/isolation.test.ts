import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isolationPreflight, runIsolatedCall } from "@/server/runner/isolation";
import { forbiddenJudgeFields } from "@/shared/worker";

beforeAll(() => { process.env.WORDS_FAKE_CODEX = "1"; });
afterAll(() => { delete process.env.WORDS_FAKE_CODEX; });

describe("isolated runner", () => {
  it("uses distinct processes, threads, and workspaces for consecutive calls", async () => {
    const envelope = {
      kind: "generate" as const,
      settings: { model: "fake", reasoningEffort: "low" as const },
      prompt: "Build a settings page. Make it elegant.",
    };
    const first = await runIsolatedCall(envelope);
    const second = await runIsolatedCall(envelope);
    expect(first.processId).not.toBe(second.processId);
    expect(first.result.threadId).not.toBe(second.result.threadId);
    expect(first.workspaceFingerprint).not.toBe(second.workspaceFingerprint);
    expect(first.artifact?.bundle).toBe(second.artifact?.bundle);
  }, 20_000);

  it("keeps truth-bearing fields out of evaluator envelopes", () => {
    const serialized = JSON.stringify({
      kind: "classify",
      settings: { model: "fake", reasoningEffort: "low" },
      neutralTask: "Build a settings page.",
      sourceBundle: "=== file-001.tsx ===\nexport const App = () => null;",
      candidates: ["control", "elegant"],
    });
    expect(forbiddenJudgeFields(serialized)).toEqual([]);
    expect(forbiddenJudgeFields(JSON.stringify({ ...JSON.parse(serialized), conditionId: "secret" }))).toEqual(["conditionId"]);
  });
});

describe("isolation preflight", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("discloses fake worker mode", () => {
    expect(isolationPreflight().fakeCodex).toBe(true);
    vi.stubEnv("WORDS_FAKE_CODEX", "0");
    expect(isolationPreflight().fakeCodex).toBe(false);
  });
});
