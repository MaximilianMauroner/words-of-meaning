// Render every successful UI generation at fixed desktop and mobile viewports.
// Usage: node scripts/render-ui-shots.mjs [export.json] [output-directory]
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exportPath = resolve(process.argv[2] || join(root, "five-runs-per-condition-export.json"));
const outDir = resolve(process.argv[3] || "/tmp/words-ui-shots");
const workDir = "/tmp/words-ui-build";
const chromePath = process.env.WORDS_CHROME_PATH || join(process.env.HOME || "", ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome");
if (!existsSync(chromePath)) throw new Error(`Chromium not found at ${chromePath}. Set WORDS_CHROME_PATH.`);

const viewports = {
  desktop: { width: 1920, height: 1080 },
  mobile: { width: 390, height: 844 },
};
const experiment = JSON.parse(readFileSync(exportPath, "utf8"));

function splitBundle(bundle) {
  const files = {};
  const parts = bundle.split(/^=== (.+?) ===$/m).slice(1);
  for (let index = 0; index < parts.length; index += 2) files[parts[index].trim()] = parts[index + 1].replace(/^\n/, "");
  return files;
}

function chrome(args) {
  return execFileSync(chromePath, ["--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars", "--force-color-profile=srgb", ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  });
}

async function buildRun(run, label) {
  const files = splitBundle(run.artifact_bundle);
  const manifest = JSON.parse(run.artifact_manifest_json || "[]");
  const directory = join(workDir, label);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  let entryComponent = null;
  const isPlainHtml = manifest.some((item) => item.originalPath.toLowerCase() === "index.html")
    && manifest.some((item) => item.originalPath.toLowerCase() === "styles.css");
  for (const item of manifest) {
    const target = join(directory, item.originalPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, files[item.ordinalPath] ?? "");
    if (!entryComponent && /(?:^|\/)App\.tsx?$/.test(item.originalPath)) entryComponent = item.originalPath;
    else if (!entryComponent && /\.tsx?$/.test(item.originalPath)) entryComponent = item.originalPath;
  }
  if (isPlainHtml) {
    const sourcePage = join(directory, "index.html");
    const sourceHtml = readFileSync(sourcePage, "utf8");
    const probeScript = `<script>setTimeout(()=>{document.body.dataset.horizontalOverflow=String(document.documentElement.scrollWidth>window.innerWidth+1)},1000)</script>`;
    const renderHtml = /<\/body>/i.test(sourceHtml)
      ? sourceHtml.replace(/<\/body>/i, `${probeScript}</body>`)
      : `${sourceHtml}${probeScript}`;
    const page = join(directory, "render.html");
    writeFileSync(page, renderHtml);
    return { directory, page, format: "plain_html_css" };
  }
  if (!entryComponent) return { error: "no component file" };
  const importPath = `./${entryComponent.replace(/\.tsx?$/, "")}`;
  writeFileSync(join(directory, "entry.tsx"), `import React from "react";\nimport {createRoot} from "react-dom/client";\nimport App from ${JSON.stringify(importPath)};\ncreateRoot(document.getElementById("root")).render(<App/>);\n`);
  try {
    await esbuild.build({ entryPoints: [join(directory, "entry.tsx")], bundle: true, outdir: directory, jsx: "automatic", loader: { ".css": "css" }, nodePaths: [join(root, "node_modules")], logLevel: "silent", minify: true });
  } catch (error) {
    return { error: `bundle failed: ${String(error.message).split("\n")[0]}` };
  }
  const stylesheets = manifest.filter((item) => item.originalPath.endsWith(".css")).map((item) => `<link rel="stylesheet" href="${item.originalPath}">`).join("");
  const page = join(directory, "index.html");
  writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8">${stylesheets}<link rel="stylesheet" href="entry.css"><style>html,body{margin:0}</style></head><body><div id="root"></div><script src="entry.js"></script><script>setTimeout(()=>{document.body.dataset.horizontalOverflow=String(document.documentElement.scrollWidth>window.innerWidth+1)},1000)</script></body></html>`);
  return { directory, page, format: "react" };
}

function renderViewport(page, label, viewportName, viewport) {
  const png = join(outDir, `${label}-${viewportName}.png`);
  try {
    const dom = chrome([`--window-size=${viewport.width},${viewport.height}`, "--virtual-time-budget=2500", "--dump-dom", `file://${page}`]);
    const rootMatch = dom.match(/<div id="root">([\s\S]*?)<\/div>/i);
    const bodyMatch = dom.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const renderedMarkup = rootMatch?.[1] || bodyMatch?.[1] || "";
    if (!renderedMarkup.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").trim()) return { viewport: viewportName, passed: false, gates: { rendered: false, noHorizontalOverflow: false, requiredTextPresent: false }, error: "page rendered nothing" };
    if (!existsSync(png)) chrome([`--window-size=${viewport.width},${viewport.height}`, "--virtual-time-budget=2500", `--screenshot=${png}`, `file://${page}`]);
    const bodyHtml = bodyMatch?.[1] || renderedMarkup;
    const visibleText = bodyHtml.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, " ").trim();
    const requiredTextPresent = visibleText.length > 0;
    // Chromium's dump does not expose layout widths, so overflow is checked in a second DOM pass.
    const probePage = `${page}?overflow-probe`;
    const probe = chrome([`--window-size=${viewport.width},${viewport.height}`, "--virtual-time-budget=2500", "--dump-dom", `file://${probePage}`]);
    const noHorizontalOverflow = !/data-horizontal-overflow="true"/.test(probe);
    const gates = { rendered: existsSync(png), noHorizontalOverflow, requiredTextPresent };
    return { viewport: viewportName, path: png, passed: Object.values(gates).every(Boolean), gates };
  } catch (error) {
    return { viewport: viewportName, passed: false, gates: { rendered: false, noHorizontalOverflow: false, requiredTextPresent: false }, error: String(error.message).split("\n")[0] };
  }
}

mkdirSync(outDir, { recursive: true });
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
const results = [];
for (const run of experiment.runs.filter((candidate) => candidate.status === "succeeded" && candidate.artifact_bundle)) {
  const condition = experiment.conditions.find((candidate) => candidate.id === run.condition_id);
  const label = `${run.task_key || "default"}-${condition?.normalized_word || "unknown"}-${run.run_index}-${run.id.slice(0, 8)}`;
  const built = await buildRun(run, label);
  if (built.error) {
    results.push({ generationId: run.id, label, passed: false, error: built.error, screenshots: [] });
    continue;
  }
  const screenshots = Object.entries(viewports).map(([name, viewport]) => renderViewport(built.page, label, name, viewport));
  results.push({ generationId: run.id, label, passed: screenshots.every((shot) => shot.passed), screenshots });
}
writeFileSync(join(outDir, "manifest.json"), JSON.stringify({ version: 2, exportPath, viewports, results }, null, 2));
rmSync(workDir, { recursive: true, force: true });
const passed = results.filter((result) => result.passed).length;
console.log(`Rendered ${results.length} runs at desktop and mobile. ${passed} passed all gates; ${results.length - passed} failed.`);
