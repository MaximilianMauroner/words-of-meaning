import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalizeWorkspace, containsWordLeak } from "@/server/artifacts/canonicalize";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("artifact canonicalization", () => {
  it("sorts files, hides original paths from the bundle, and ignores dependencies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "artifact-test-"));
    roots.push(root);
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "src", "Z.ts"), "export const z = 1;\r\n");
    await writeFile(path.join(root, "src", "A.tsx"), "export const A = () => <div />;\n");
    await writeFile(path.join(root, "node_modules", "secret.js"), "doNotInclude();\n");
    const artifact = await canonicalizeWorkspace(root);
    expect(artifact.manifest.map((file) => file.originalPath)).toEqual(["src/A.tsx", "src/Z.ts"]);
    expect(artifact.bundle).toContain("=== file-001.tsx ===");
    expect(artifact.bundle).not.toContain("src/A.tsx");
    expect(artifact.bundle).not.toContain("doNotInclude");
    expect(artifact.hash).toHaveLength(64);
  });

  it("detects whole-word leaks case-insensitively", () => {
    expect(containsWordLeak("// An ELEGANT solution", "elegant")).toBe(true);
    expect(containsWordLeak("const elegantlyNamed = true", "elegant")).toBe(false);
  });
});
