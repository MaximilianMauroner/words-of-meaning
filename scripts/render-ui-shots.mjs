// Renders the generated React settings panels to JPEG screenshots.
//
// Each run in the code experiment produced an App.tsx and a styles.css with no
// external dependencies. This bundles each pair against the project's own React
// with esbuild, renders it in headless Chromium, and writes a JPEG per run.
// Output goes to a scratch directory outside the repository so nothing is left
// behind in the working tree.
//
// Usage: node scripts/render-ui-shots.mjs [outDir]
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2] || "/tmp/words-ui-shots";
const workDir = "/tmp/words-ui-build";
const CHROME = join(
  process.env.HOME,
  ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome"
);
if (!existsSync(CHROME)) throw new Error(`chromium not found at ${CHROME}`);

const VIEWPORT_WIDTH = 1180;
const MAX_HEIGHT = 2000;
// Two output sizes: a wide one for the six-condition comparison, and a narrow
// one for the run-to-run strip where many images share a row.
const SIZES = {
  main: { width: 560, quality: "8" },
  strip: { width: 340, quality: "11" },
};

const experiment = JSON.parse(readFileSync(join(root, "five-runs-per-condition-export.json"), "utf8"));

// Split a canonicalized bundle back into its ordinal files.
function splitBundle(bundle) {
  const files = {};
  const parts = bundle.split(/^=== (.+?) ===$/m).slice(1);
  for (let i = 0; i < parts.length; i += 2) files[parts[i].trim()] = parts[i + 1].replace(/^\n/, "");
  return files;
}

const chrome = (args) =>
  execFileSync(CHROME, [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--disable-lcd-text",
    ...args,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

// Renders one run and returns the JPEG path, or an error record when it does not build.
async function renderRun(run, label, size) {
  const files = splitBundle(run.artifact_bundle);
  const manifest = JSON.parse(run.artifact_manifest_json);
  const dir = join(workDir, label);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // Restore the original filenames so the generated import paths resolve.
  let entryComponent = null;
  for (const item of manifest) {
    writeFileSync(join(dir, item.originalPath), files[item.ordinalPath] ?? "");
    if (/\.tsx?$/.test(item.originalPath)) entryComponent = item.originalPath;
  }
  if (!entryComponent) return { label, error: "no component file in bundle" };

  writeFileSync(
    join(dir, "entry.tsx"),
    `import { createRoot } from "react-dom/client";\n` +
      `import App from "./${entryComponent.replace(/\.tsx?$/, "")}";\n` +
      `createRoot(document.getElementById("root")).render(<App />);\n`
  );

  try {
    await esbuild.build({
      entryPoints: [join(dir, "entry.tsx")],
      bundle: true,
      outdir: dir,
      jsx: "automatic",
      loader: { ".css": "css" },
      define: { "process.env.NODE_ENV": '"production"' },
      nodePaths: [join(root, "node_modules")],
      logLevel: "silent",
      minify: true,
    });
  } catch (error) {
    return { label, error: `bundle failed: ${String(error.message).split("\n")[0]}` };
  }

  // Two of the thirty runs wrote styles.css but never imported it from the
  // component. Every generated stylesheet is linked directly so a run is not
  // rendered bare over a detail the task did not ask about.
  const stylesheets = manifest
    .filter((item) => item.originalPath.endsWith(".css"))
    .map((item) => `<link rel="stylesheet" href="${item.originalPath}">`)
    .join("");

  const page = join(dir, "index.html");
  writeFileSync(
    page,
    `<!doctype html><html><head><meta charset="utf-8">` +
      stylesheets +
      `<link rel="stylesheet" href="entry.css">` +
      `<style>html,body{margin:0}</style></head><body><div id="root"></div>` +
      `<script src="entry.js"></script>` +
      `<script>requestAnimationFrame(()=>{const h=Math.ceil(document.documentElement.scrollHeight);` +
      `document.body.setAttribute("data-height",String(h));});</script></body></html>`
  );

  // First pass reads the laid-out content height so the shot is not cropped.
  let height = 900;
  try {
    const dom = chrome([
      `--window-size=${VIEWPORT_WIDTH},900`,
      "--virtual-time-budget=2500",
      "--dump-dom",
      `file://${page}`,
    ]);
    const match = dom.match(/data-height="(\d+)"/);
    if (match) height = Math.min(MAX_HEIGHT, Math.max(420, Number(match[1])));
    if (!/id="root"><[a-z]/i.test(dom.replace(/\s+/g, ""))) {
      const rendered = /<div id="root">\s*<\w/.test(dom);
      if (!rendered) return { label, error: "component rendered nothing" };
    }
  } catch (error) {
    return { label, error: `dom pass failed: ${String(error.message).split("\n")[0]}` };
  }

  const png = join(dir, "shot.png");
  chrome([
    `--window-size=${VIEWPORT_WIDTH},${height}`,
    "--virtual-time-budget=2500",
    `--screenshot=${png}`,
    `file://${page}`,
  ]);
  if (!existsSync(png)) return { label, error: "screenshot not written" };

  mkdirSync(outDir, { recursive: true });
  const jpg = join(outDir, `${label}.jpg`);
  execFileSync("ffmpeg", [
    "-loglevel", "error", "-y", "-i", png,
    "-vf", `scale=${size.width}:-2:flags=lanczos`,
    "-q:v", size.quality, jpg,
  ]);
  return { label, path: jpg, sourceWidth: VIEWPORT_WIDTH, sourceHeight: height };
}

const runFor = (word, index) => {
  const condition = experiment.conditions.find((c) => c.normalized_word === word);
  return experiment.runs.find(
    (r) => r.condition_id === condition.id && r.run_index === index && r.status === "succeeded"
  );
};

const targets = [];
// One panel per condition for the side-by-side comparison.
for (const condition of experiment.conditions) {
  const run = runFor(condition.normalized_word, 1);
  if (run) targets.push({ run, label: `main-${condition.normalized_word}`, size: SIZES.main });
}
// All five runs of the pair the judge confused most often, to show that the
// spread inside one condition is as wide as the spread between the two.
for (const word of ["control", "polished"]) {
  for (let i = 1; i <= 5; i++) {
    const run = runFor(word, i);
    if (run) targets.push({ run, label: `strip-${word}-${i}`, size: SIZES.strip });
  }
}

const results = [];
for (const target of targets) {
  const result = await renderRun(target.run, target.label, target.size);
  results.push(result);
  console.log(
    result.error
      ? `${result.label}: FAILED (${result.error})`
      : `${result.label}: ${result.sourceHeight}px tall, ${(readFileSync(result.path).length / 1024).toFixed(1)} KB`
  );
}
console.log(
  `total ${(results.filter((r) => r.path).reduce((a, r) => a + readFileSync(r.path).length, 0) / 1024).toFixed(1)} KB`
);
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(results, null, 2));
rmSync(workDir, { recursive: true, force: true });
