import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputPath = path.join(root, ".agent", "artifacts", "words-of-meaning-report.html");
const inputPaths = process.argv.slice(2);
if (inputPaths.length === 0) inputPaths.push("five-runs-per-condition-export.json");

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const title = (value) => String(value).replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
const pct = (value, digits = 1) => `${(Number(value || 0) * 100).toFixed(digits)}%`;
const fixed = (value, digits = 2) => Number(value || 0).toFixed(digits);
const pValue = (value) => Number(value) < 0.001 ? "&lt;0.001" : fixed(value, 3);
const shortId = (value) => String(value || "missing").slice(0, 12);
const parse = (value, fallback = {}) => {
  try { return typeof value === "string" ? JSON.parse(value) : value ?? fallback; } catch { return fallback; }
};

const datasets = await Promise.all(inputPaths.map(async (inputPath) => ({
  file: path.basename(inputPath),
  data: JSON.parse(await readFile(path.resolve(root, inputPath), "utf8")),
})));

let screenshots = [];
try {
  const oldReport = await readFile(outputPath, "utf8");
  screenshots = [...oldReport.matchAll(/<img src="(data:image\/jpeg;base64,[^"]+)"/g)].map((match) => match[1]).slice(0, 6);
} catch {}

const successfulAttempts = (dataset) => dataset.data.attempts.filter((attempt) => attempt.exit_code === 0);
const attemptsForRun = (dataset, run) => {
  const judgmentId = run.judgment_id;
  return dataset.data.attempts.filter((attempt) =>
    attempt.exit_code === 0 && (attempt.target_id === run.id || attempt.target_id === judgmentId));
};
const conditionName = (run) => run.word || "control";
const taskName = (dataset) => {
  const name = String(dataset.data.experiment.name || "");
  if (/poem/i.test(name)) return "Poem";
  if (/paragraph/i.test(name)) return "Paragraph";
  return "React UI";
};
const rowName = (dataset) => {
  const name = String(dataset.data.experiment.name || "");
  if (/positive/i.test(name)) return "Positive";
  if (/neutral/i.test(name)) return "Neutral";
  if (/negative/i.test(name)) return "Negative";
  return "Original aesthetic";
};

function binomialTail(n, k, p) {
  let term = Math.pow(1 - p, n);
  let sum = 0;
  for (let i = 0; i <= n; i += 1) {
    if (i >= k) sum += term;
    if (i < n) term *= ((n - i) / (i + 1)) * (p / (1 - p));
  }
  return Math.min(1, sum);
}

function wilson(n, k, z = 1.959963984540054) {
  if (!n) return [0, 0];
  const p = k / n;
  const denominator = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

const writing = datasets.filter((dataset) => taskName(dataset) !== "React UI");
const writingRuns = writing.flatMap((dataset) => dataset.data.runs.filter((run) => run.judgment_status === "succeeded" && !run.word_leak));
const writingCorrect = writingRuns.filter((run) => run.prediction === conditionName(run)).length;
const writingChance = writing.length ? 1 / 6 : 0;
const writingInterval = wilson(writingRuns.length, writingCorrect);
const writingP = writingRuns.length ? binomialTail(writingRuns.length, writingCorrect, writingChance) : 0;

function resultRows() {
  return datasets.map((dataset) => {
    const metrics = dataset.data.metrics;
    const significant = metrics.significance?.significant ? "yes" : "no";
    const interval = metrics.significance?.accuracyWilson95 || [0, 0];
    return `<tr><th>${escapeHtml(taskName(dataset))}</th><td>${escapeHtml(rowName(dataset))}</td><td>${metrics.correctCount} / ${metrics.eligibleCount}</td><td>${pct(metrics.accuracy)}</td><td>${pct(metrics.chance)}</td><td>${pValue(metrics.significance?.oneSidedPValue)}</td><td>${pct(interval[0])} to ${pct(interval[1])}</td><td>${significant}</td></tr>`;
  }).join("");
}

function confusionTable(dataset) {
  const metrics = dataset.data.metrics;
  const header = metrics.labels.map((label) => `<th>${escapeHtml(title(label))}</th>`).join("");
  const rows = metrics.labels.map((actual) => `<tr><th>${escapeHtml(title(actual))}</th>${metrics.labels.map((predicted) => {
    const value = metrics.confusion?.[actual]?.[predicted] || 0;
    return `<td class="${actual === predicted ? "diag" : value ? "miss" : ""}">${value}</td>`;
  }).join("")}</tr>`).join("");
  return `<details class="matrix-block"><summary>${escapeHtml(taskName(dataset))}, ${escapeHtml(rowName(dataset))} row</summary><div class="table-wrap"><table class="matrix"><thead><tr><th>Actual / predicted</th>${header}</tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

function recallTable(dataset) {
  const recalls = dataset.data.metrics.recalls || {};
  return `<div class="mini-card"><h3>${escapeHtml(taskName(dataset))}, ${escapeHtml(rowName(dataset))}</h3>${Object.entries(recalls).map(([label, value]) => {
    const rate = typeof value === "number" ? value : value.rate;
    const count = typeof value === "number" ? pct(rate, 0) : `${value.correct} / ${value.total}`;
    return `<div class="rank"><span>${escapeHtml(title(label))}</span><i><b style="width:${Number(rate) * 100}%"></b></i><strong>${count}</strong></div>`;
  }).join("")}</div>`;
}

function profileTable(dataset) {
  const profiles = dataset.data.metrics.profiles || {};
  const dimensions = parse(dataset.data.experiment.dimensions_json, []);
  const labels = dataset.data.metrics.labels || [];
  return `<details><summary>${escapeHtml(taskName(dataset))}, ${escapeHtml(rowName(dataset))} behavioral means</summary><div class="table-wrap"><table><thead><tr><th>Condition</th>${dimensions.map((d) => `<th>${escapeHtml(d.label)}</th>`).join("")}</tr></thead><tbody>${labels.map((label) => `<tr><th>${escapeHtml(title(label))}</th>${dimensions.map((d) => `<td>${profiles[label]?.[d.key]?.mean == null ? "n/a" : fixed(profiles[label][d.key].mean, 1)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>`;
}

function probabilityLine(run) {
  const probabilities = parse(run.probabilities_json);
  return Object.entries(probabilities).sort((a, b) => b[1] - a[1]).map(([label, value]) => `${escapeHtml(title(label))} ${pct(value)}`).join(" · ");
}

function outputText(dataset, run) {
  const bundle = String(run.artifact_bundle || "");
  if (taskName(dataset) !== "React UI") return bundle.replace(/^=== file-\d+\.md ===\n/, "").trim();
  const manifest = parse(run.artifact_manifest_json, []);
  const excerpt = bundle.slice(0, 500).trim();
  return `Files: ${manifest.map((file) => `${file.originalPath} (${file.bytes} bytes)`).join(", ")}\n\nSource excerpt:\n${excerpt}${bundle.length > excerpt.length ? "\n\n[Full source is in the linked JSON export.]" : ""}`;
}

function runCard(dataset, run) {
  const attempts = attemptsForRun(dataset, run);
  const profiles = parse(run.profile_scores_json);
  const modifier = run.modifier_present_probability == null ? null : run.modifier_present_probability / 1_000_000;
  const correct = run.prediction === conditionName(run);
  const excluded = Boolean(run.word_leak);
  const scoreLine = Object.entries(profiles).map(([key, value]) => `${escapeHtml(title(key))} ${value ?? "n/a"}`).join(" · ");
  const isolationLines = attempts.map((attempt) => `${title(attempt.kind)} | PID ${attempt.process_id} | thread ${shortId(attempt.thread_id)} | workspace ${shortId(attempt.isolation_id)}`).join("\n");
  return `<details class="run"><summary><span>${escapeHtml(taskName(dataset))} · ${escapeHtml(rowName(dataset))} · ${escapeHtml(title(conditionName(run)))} · run ${run.run_index}</span><span class="${excluded ? "wrong" : correct ? "correct" : "wrong"}">${excluded ? "Excluded word leak" : escapeHtml(title(run.prediction || "no judgment"))}</span></summary><div class="run-body"><p><strong>True:</strong> ${escapeHtml(title(conditionName(run)))} · <strong>Blind prediction:</strong> ${escapeHtml(title(run.prediction))} · <strong>Modifier present:</strong> ${modifier == null ? "n/a" : pct(modifier)}${excluded ? " · <strong>Excluded from scoring because the output repeats the hidden word.</strong>" : ""}</p><p class="compact"><strong>Probabilities:</strong> ${probabilityLine(run)}</p><p class="compact"><strong>Behavioral scores:</strong> ${scoreLine}</p><p class="compact"><strong>Artifact:</strong> ${run.artifact_bytes} bytes · <code>${escapeHtml(run.artifact_hash)}</code></p><details class="isolation"><summary>Three fresh-call records</summary><pre>${escapeHtml(isolationLines)}</pre></details><h4>Generated output</h4><pre>${escapeHtml(outputText(dataset, run))}</pre></div></details>`;
}

function exampleCard(dataset, word) {
  const run = dataset.data.runs.find((candidate) => conditionName(candidate) === word && candidate.run_index === 1);
  if (!run) return "";
  return `<article class="example"><p class="label">${escapeHtml(taskName(dataset))} · ${escapeHtml(rowName(dataset))}</p><h3>${escapeHtml(title(word))}</h3><pre>${escapeHtml(outputText(dataset, run))}</pre><p class="note">Blind prediction: ${escapeHtml(title(run.prediction))}</p></article>`;
}

const writingExamples = writing.flatMap((dataset) => {
  const labels = dataset.data.conditions.filter((condition) => !condition.is_control).slice(0, 2).map((condition) => condition.normalized_word);
  return labels.map((word) => exampleCard(dataset, word));
}).join("");

const screenshotLabels = ["Control", "Lovely", "Beautiful", "Elegant", "Polished", "Refined"];
const screenshotHtml = screenshots.map((src, index) => `<figure><img src="${src}" alt="${screenshotLabels[index]} React settings page run"><figcaption><strong>${screenshotLabels[index]}, run 1</strong><span>Rendered from the generated React and CSS files.</span></figcaption></figure>`).join("");

const allSuccessful = datasets.flatMap(successfulAttempts);
const allAttempts = datasets.flatMap((dataset) => dataset.data.attempts);
const rejectedAttempts = allAttempts.filter((attempt) => attempt.exit_code !== 0);
const leakedRuns = datasets.flatMap((dataset) => dataset.data.runs).filter((run) => run.word_leak);
const processCount = new Set(allSuccessful.map((attempt) => attempt.process_id)).size;
const threadCount = new Set(allSuccessful.map((attempt) => attempt.thread_id)).size;
const workspaceCount = new Set(allSuccessful.map((attempt) => attempt.isolation_id)).size;
const runCount = datasets.reduce((sum, dataset) => sum + dataset.data.runs.length, 0);

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Words of Meaning benchmark report</title><style>
:root{color-scheme:light;--ink:#20231f;--muted:#626960;--line:#d8ddd4;--paper:#fafbf8;--panel:#fff;--green:#365e48;--soft:#e9f1eb;--amber:#865912;--amber-soft:#fff3d8;--red:#8b3636;--red-soft:#fbeaea}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{width:min(1200px,calc(100% - 28px));margin:auto;padding:30px 0 60px}header{border-bottom:2px solid var(--ink);padding-bottom:18px}h1{margin:3px 0 8px;font:700 clamp(29px,5vw,45px)/1.08 Georgia,serif;letter-spacing:-.025em}h2{margin:0 0 12px;font:700 24px/1.2 Georgia,serif}h3,h4{margin:0 0 7px}h4{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}p{margin:0 0 10px}.kicker,.label{color:var(--green);font-size:12px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}.lede{max-width:880px;color:#454a43;font-size:17px}.meta{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:14px;color:var(--muted);font-size:13px}section{margin-top:30px}.summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.metric,.card,.mini-card,.example{padding:15px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}.metric strong{display:block;margin:7px 0 2px;font:700 25px/1 Georgia,serif}.metric small,.note{color:var(--muted);font-size:13px}.verdict,.callout{padding:14px 16px;border-left:4px solid var(--amber);background:var(--amber-soft)}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:8px 9px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}thead th{color:var(--muted);font-size:12px}.matrix td{text-align:center}.diag{background:var(--soft);color:var(--green);font-weight:750}.miss{background:#f4f5f2}.matrices,.profiles{display:grid;gap:8px}.recalls,.examples{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.rank,.prob{display:grid;grid-template-columns:92px 1fr 55px;gap:8px;align-items:center;margin:6px 0}.rank i,.prob i{height:8px;overflow:hidden;border-radius:9px;background:#ecefe9}.rank b,.prob b{display:block;height:100%;background:var(--green)}.rank strong,.prob strong{text-align:right;font-size:12px}details{border:1px solid var(--line);border-radius:7px;background:var(--panel)}summary{padding:11px 13px;cursor:pointer;font-weight:650}details[open]>summary{border-bottom:1px solid var(--line)}.matrix-block .table-wrap,.profiles .table-wrap{padding:8px}.screens{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}figure{margin:0;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:white}figure img{display:block;width:100%}figcaption{padding:9px 11px;border-top:1px solid var(--line)}figcaption strong,figcaption span{display:block}figcaption span{color:var(--muted);font-size:12px}.run-list{display:grid;gap:7px}.run summary{display:flex;justify-content:space-between;gap:12px}.correct{color:var(--green)}.wrong{color:var(--red)}.run-body{padding:14px}.run-grid{display:grid;grid-template-columns:1fr 1fr 1.2fr;gap:16px}dl{margin:0}dl div{display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid var(--line);padding:4px 0}dd{margin:0;font-weight:700}.attempt{font-size:12px}.attempt code,.run code{overflow-wrap:anywhere}pre{max-height:420px;overflow:auto;margin:8px 0 0;padding:12px;border-radius:6px;background:#f1f3ef;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}.example pre{max-height:300px}.audit{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.audit div{padding:14px;border:1px solid #bed0c2;background:var(--soft);border-radius:8px}.audit strong{display:block;color:var(--green);font-size:22px}code{font:12px ui-monospace,SFMono-Regular,Consolas,monospace}ul{padding-left:20px}footer{margin-top:32px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}a{color:var(--green)}
@media(max-width:900px){.summary{grid-template-columns:repeat(3,1fr)}.recalls,.examples{grid-template-columns:repeat(2,1fr)}.run-grid{grid-template-columns:1fr 1fr}}@media(max-width:620px){main{width:min(100% - 18px,1200px);padding-top:18px}.summary,.recalls,.examples,.screens,.audit,.run-grid{grid-template-columns:1fr}.run summary{display:block}.run summary span{display:block}.metric{min-height:0}th,td{padding:7px}.prob,.rank{grid-template-columns:78px 1fr 50px}}
</style></head><body><main>
<header><p class="kicker">Blind prompt-identification benchmark</p><h1>Do descriptive words leave a visible trace?</h1><p class="lede">This benchmark tests whether a blind judge can recover a descriptive word from model output. It measures observable behavior. It cannot establish that a model has a specific hidden definition of "lovely," "beautiful," or any other word.</p><div class="meta"><span>Generated September 1, 2026</span><span>Generator and judge: GPT-5.6 Terra</span><span>5 runs per condition</span><span>${runCount} outputs in this report</span></div></header>

<section><h2>Expanded writing result</h2>${writingRuns.length ? `<div class="summary"><div class="metric"><span class="label">Accuracy</span><strong>${pct(writingCorrect / writingRuns.length)}</strong><small>${writingCorrect} correct of ${writingRuns.length}</small></div><div class="metric"><span class="label">Chance</span><strong>${pct(writingChance)}</strong><small>Six labels within each row</small></div><div class="metric"><span class="label">Exact p-value</span><strong>${fixed(writingP,3)}</strong><small>One-sided binomial test</small></div><div class="metric"><span class="label">95% interval</span><strong>${pct(writingInterval[0])} to ${pct(writingInterval[1])}</strong><small>Wilson interval</small></div><div class="metric"><span class="label">Writing outputs</span><strong>${writingRuns.length}</strong><small>Poems and paragraphs</small></div></div><p class="verdict"><strong>${writingP < .05 ? "The writing classifier scored above chance." : "The writing classifier did not score above chance."}</strong> This statement applies to the pooled writing runs. The row-level table below shows where the signal came from.</p>` : `<p class="callout">Writing experiments are still running. This draft contains the completed React UI benchmark.</p>`}</section>

<section><h2>Design</h2><div class="table-wrap card"><table><thead><tr><th>Task</th><th>Word row</th><th>Conditions</th><th>Runs each</th><th>Outputs</th></tr></thead><tbody>${datasets.map((dataset) => `<tr><th>${escapeHtml(taskName(dataset))}</th><td>${escapeHtml(rowName(dataset))}</td><td>${dataset.data.conditions.length}</td><td>${dataset.data.experiment.runs_per_condition}</td><td>${dataset.data.runs.length}</td></tr>`).join("")}</tbody></table></div><p class="note">Writing rows use five familiar related words plus a no-modifier control. Each judge sees only the six labels in its own row. Positive, neutral, and negative rows never share a judging call.</p></section>

<section><h2>Statistical results by task and row</h2><div class="table-wrap card"><table><thead><tr><th>Task</th><th>Row</th><th>Correct</th><th>Accuracy</th><th>Chance</th><th>Exact p</th><th>Wilson 95%</th><th>p &lt; 0.05</th></tr></thead><tbody>${resultRows()}</tbody></table></div><p class="note">The exact test is one-sided. The table uses p &lt; 0.05 without correction. A Bonferroni threshold across these seven rows is 0.0071. The negative poem row passes that threshold; the negative paragraph row does not.</p></section>

<section><h2>Confusion matrices</h2><p class="note">Open a task and row. Rows are true conditions and columns are blind predictions.</p><div class="matrices">${datasets.map(confusionTable).join("")}</div></section>

<section><h2>Recall by word</h2><div class="recalls">${datasets.map(recallTable).join("")}</div></section>

${writingExamples ? `<section><h2>Everyday writing examples</h2><p class="note">These are first runs, chosen by a fixed rule before reading their content. Open all runs later in the report to compare every poem and paragraph.</p><div class="examples">${writingExamples}</div></section>` : ""}

${screenshotHtml ? `<section><h2>React examples</h2><p class="note">Run 1 from each original UI condition, rendered from its generated React and CSS files.</p><div class="screens">${screenshotHtml}</div></section>` : ""}

<section><h2>Behavioral profiles</h2><p class="note">A separate blind evaluator scored observable output properties from 1 to 7. These are descriptive means, not proof of a hidden definition.</p><div class="profiles">${datasets.map(profileTable).join("")}</div></section>

<section><h2>Isolation audit</h2><div class="audit"><div><strong>${processCount} / ${allSuccessful.length}</strong><span>distinct successful process IDs</span></div><div><strong>${threadCount} / ${allSuccessful.length}</strong><span>distinct successful thread IDs</span></div><div><strong>${workspaceCount} / ${allSuccessful.length}</strong><span>distinct successful workspace IDs</span></div></div><ul><li>Every generation, classification, and profile call used a new OS process, SDK client, Codex thread, temporary workspace, and temporary Codex home.</li><li>The judge received the neutral task, one canonical artifact, and a randomized candidate order. It did not receive the true word, run number, experiment name, or another run.</li><li>The parent process joined true labels to judgments only during scoring.</li><li>${rejectedAttempts.length} rejected or interrupted attempts remain in the exports. Every retry used a new process, thread, workspace, and home.</li><li>${leakedRuns.length} output repeated its hidden word and was excluded before scoring.</li></ul></section>

<section><h2>All ${runCount} runs</h2><p class="note">Every run is listed below, including the excluded word leak. Open any row to inspect its judgment, probability distribution, behavioral scores, artifact identity, and call-by-call isolation evidence. The IDs are shortened here; the exports contain the full values. Writing output appears in full. React source is excerpted to keep this self-contained report below 512 KB.</p><div class="run-list">${datasets.flatMap((dataset) => dataset.data.runs.map((run) => runCard(dataset, run))).join("")}</div></section>

<section class="callout"><h2>How to read this</h2><ul><li>Accuracy above chance means the modifier changed output in a way this judge could recognize.</li><li>Accuracy at chance does not prove that the words had no effect. The effect may be weak, inconsistent, or invisible to this judge.</li><li>Five runs per condition are enough to expose large differences, but one error moves condition recall by 20 percentage points.</li><li>The pooled writing test has more samples. It still combines tasks and word rows, so the row-level results matter.</li></ul></section>

<footer><p>Input exports: ${datasets.map((dataset) => `<code>${escapeHtml(dataset.file)}</code>`).join(", ")}</p><p>Official SDK reference: <a href="https://learn.chatgpt.com/docs/codex-sdk" target="_blank" rel="noopener noreferrer">OpenAI Codex SDK documentation</a>. The SDK starts a new thread with <code>startThread()</code>; this benchmark adds a fresh process, client, workspace, and temporary home for each call.</p></footer>
</main></body></html>`;

await writeFile(outputPath, html);
const bytes = Buffer.byteLength(html);
const hash = createHash("sha256").update(html).digest("hex");
console.log(JSON.stringify({ outputPath, bytes, sha256: hash, datasets: datasets.length, runs: runCount }, null, 2));
