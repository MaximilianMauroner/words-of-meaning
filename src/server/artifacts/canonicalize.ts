import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const allowedExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".json", ".md", ".html"]);
const excludedNames = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".codex"]);
const maxFileBytes = 256_000;
const maxBundleBytes = 1_500_000;

export type ArtifactManifestEntry = {
  ordinalPath: string;
  originalPath: string;
  bytes: number;
};

export type CanonicalArtifact = {
  bundle: string;
  manifest: ArtifactManifestEntry[];
  bytes: number;
  hash: string;
};

export function validatePlainHtmlCssArtifact(artifact: CanonicalArtifact): void {
  const paths = artifact.manifest.map((entry) => entry.originalPath.toLowerCase());
  if (!paths.includes("index.html")) throw new Error("Plain HTML artifact must include index.html");
  if (!paths.includes("styles.css")) throw new Error("Plain HTML artifact must include styles.css");
  const forbidden = paths.filter((file) => /\.(?:js|jsx|ts|tsx)$/.test(file));
  if (forbidden.length) throw new Error("Plain HTML artifact cannot include JavaScript or React files");
  if (paths.length !== 2 || paths.some((file) => !["index.html", "styles.css"].includes(file))) {
    throw new Error("Plain HTML artifact must contain only index.html and styles.css");
  }
  if (/<script\b|javascript:/i.test(artifact.bundle)) throw new Error("Plain HTML artifact cannot include JavaScript");
}

async function walk(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || excludedNames.has(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(root, absolute));
    if (entry.isFile() && allowedExtensions.has(path.extname(entry.name).toLowerCase())) paths.push(absolute);
  }
  return paths;
}

export async function canonicalizeWorkspace(root: string): Promise<CanonicalArtifact> {
  const files = (await walk(root)).sort((left, right) => {
    const a = path.relative(root, left).split(path.sep).join("/");
    const b = path.relative(root, right).split(path.sep).join("/");
    return Buffer.from(a).compare(Buffer.from(b));
  });
  if (files.length === 0) throw new Error("Generation produced no allowed source files");

  const parts: string[] = [];
  const manifest: ArtifactManifestEntry[] = [];
  let bytes = 0;
  for (const [index, absolute] of files.entries()) {
    const info = await stat(absolute);
    if (info.size > maxFileBytes) throw new Error(`Generated file exceeds ${maxFileBytes} bytes`);
    const raw = await readFile(absolute);
    if (raw.includes(0)) throw new Error("Generated source contains binary data");
    const content = raw.toString("utf8").replace(/\r\n?/g, "\n");
    const extension = path.extname(absolute).toLowerCase();
    const ordinalPath = `file-${String(index + 1).padStart(3, "0")}${extension}`;
    const block = `=== ${ordinalPath} ===\n${content.endsWith("\n") ? content : `${content}\n`}`;
    bytes += Buffer.byteLength(block);
    if (bytes > maxBundleBytes) throw new Error(`Generated bundle exceeds ${maxBundleBytes} bytes`);
    parts.push(block);
    manifest.push({
      ordinalPath,
      originalPath: path.relative(root, absolute).split(path.sep).join("/"),
      bytes: Buffer.byteLength(content),
    });
  }
  const bundle = parts.join("\n");
  return { bundle, manifest, bytes: Buffer.byteLength(bundle), hash: createHash("sha256").update(bundle).digest("hex") };
}

export function containsWordLeak(bundle: string, word: string | null): boolean {
  if (!word) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, "iu").test(bundle);
}
