import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalizeWorkspace, containsWordLeak, validatePlainHtmlCssArtifact } from "@/server/artifacts/canonicalize";

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

  it("requires plain UI artifacts to be HTML and CSS only", () => {
    const artifact = {
      bundle: "",
      bytes: 0,
      hash: "",
      manifest: [
        { ordinalPath: "file-001.html", originalPath: "index.html", bytes: 10 },
        { ordinalPath: "file-002.css", originalPath: "styles.css", bytes: 10 },
      ],
    };
    expect(() => validatePlainHtmlCssArtifact(artifact)).not.toThrow();
    expect(() => validatePlainHtmlCssArtifact({ ...artifact, manifest: [...artifact.manifest, { ordinalPath: "file-003.tsx", originalPath: "App.tsx", bytes: 10 }] })).toThrow(/JavaScript or React/);
    expect(() => validatePlainHtmlCssArtifact({ ...artifact, manifest: [...artifact.manifest, { ordinalPath: "file-003.md", originalPath: "README.md", bytes: 10 }] })).toThrow(/only index.html and styles.css/);
    expect(() => validatePlainHtmlCssArtifact({ ...artifact, manifest: [artifact.manifest[0]] })).toThrow(/styles.css/);
  });
});
