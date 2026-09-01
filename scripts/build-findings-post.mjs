// Builds the findings write-up at .agent/artifacts/words-of-meaning-findings.html
// from the seven JSON exports in the repository root. Self-contained, script-free,
// dark surface. Run with: node scripts/build-findings-post.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => JSON.parse(readFileSync(join(root, f), "utf8"));

const WRITING = [
  { file: "poem-positive-export.json", task: "poem", family: "positive" },
  { file: "poem-neutral-export.json", task: "poem", family: "neutral" },
  { file: "poem-negative-export.json", task: "poem", family: "negative" },
  { file: "paragraph-positive-export.json", task: "paragraph", family: "positive" },
  { file: "paragraph-neutral-export.json", task: "paragraph", family: "neutral" },
  { file: "paragraph-negative-export.json", task: "paragraph", family: "negative" },
];
const CODE = { file: "five-runs-per-condition-export.json", task: "react", family: "code" };

const data = WRITING.map((m) => ({ ...m, json: read(m.file) }));
const code = { ...CODE, json: read(CODE.file) };
const all = [...data, code];

// ---------------------------------------------------------------- statistics

const lgamma = (n) => {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
};
const lchoose = (n, k) => lgamma(n) - lgamma(k) - lgamma(n - k);
// One-sided exact binomial: P(X >= k) under X ~ Binomial(n, p).
const binomTail = (k, n, p) => {
  let s = 0;
  for (let i = k; i <= n; i++) s += Math.exp(lchoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, s);
};
// Wilson score interval for a binomial proportion.
const wilson = (k, n, z = 1.959963985) => {
  const ph = k / n;
  const d = 1 + (z * z) / n;
  const c = ph + (z * z) / (2 * n);
  const m = z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
};
const CHANCE = 1 / 6;

const pct = (x, d = 1) => `${(100 * x).toFixed(d)}%`;
const sgn = (x, d = 2) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}`;
const pfmt = (p) =>
  p < 0.001 ? "&lt; 0.001" : p < 0.01 ? p.toFixed(4).replace(/0+$/, "") : p.toFixed(3);
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ------------------------------------------------------------- run flattening

// One row per classified run, joined to its true label. word_leak rows are kept
// but marked; every headline metric drops them.
const runsOf = (entry) =>
  entry.json.runs
    .filter((r) => r.judgment_status === "succeeded")
    .map((r) => {
      const probs = JSON.parse(r.probabilities_json);
      return {
        task: entry.task,
        family: entry.family,
        experiment: entry.json.experiment.name,
        word: r.normalized_word,
        isControl: !!r.is_control,
        runIndex: r.run_index,
        leak: !!r.word_leak,
        prediction: r.prediction,
        correct: r.prediction === r.normalized_word,
        probs,
        // Probability mass the blind judge put on "an adjective was in the prompt".
        presence: 1 - (probs.control || 0),
        text: r.artifact_bundle.replace(/^=== file-\d+\.\w+ ===\n/, "").trim(),
        bytes: r.artifact_bytes,
        profile: JSON.parse(r.profile_scores_json),
      };
    });

const writingRuns = data.flatMap(runsOf);
const codeRuns = runsOf(code);
const eligible = writingRuns.filter((r) => !r.leak);

const tally = (rows) => {
  const k = rows.filter((r) => r.correct).length;
  const n = rows.length;
  const [lo, hi] = wilson(k, n);
  return { k, n, acc: k / n, p: binomTail(k, n, CHANCE), lo, hi };
};

const overall = tally(eligible);
const families = ["positive", "neutral", "negative"].map((f) => ({
  family: f,
  ...tally(eligible.filter((r) => r.family === f)),
}));
const tasks = ["poem", "paragraph"].map((t) => ({ task: t, ...tally(eligible.filter((r) => r.task === t)) }));
const codeStats = tally(codeRuns);

// Presence detection: threshold the judge's P(adjective present) at 0.5 and ask
// whether it recovered the fact that a word was injected at all.
const presenceOf = (rows) => {
  const ctrl = rows.filter((r) => r.isControl);
  const word = rows.filter((r) => !r.isControl);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const wordHit = word.filter((r) => r.presence >= 0.5).length;
  const ctrlHit = ctrl.filter((r) => r.presence < 0.5).length;
  return {
    ctrlMean: mean(ctrl.map((r) => r.presence)),
    wordMean: mean(word.map((r) => r.presence)),
    wordHit,
    wordN: word.length,
    ctrlHit,
    ctrlN: ctrl.length,
    acc: (wordHit + ctrlHit) / rows.length,
  };
};
const presenceFamilies = ["positive", "neutral", "negative"].map((f) => ({
  family: f,
  ...presenceOf(eligible.filter((r) => r.family === f)),
}));
const presenceOverall = presenceOf(eligible);

// Per-word recall and prediction share, pooled across poem and paragraph.
const familyWords = {};
const familyPredShare = {};
const familyConfusion = {};
for (const f of ["positive", "neutral", "negative"]) {
  const rows = eligible.filter((r) => r.family === f);
  const labels = data.find((d) => d.family === f && d.task === "poem").json.metrics.labels;
  const rec = Object.fromEntries(labels.map((l) => [l, { c: 0, t: 0 }]));
  const share = Object.fromEntries(labels.map((l) => [l, 0]));
  const conf = Object.fromEntries(labels.map((l) => [l, Object.fromEntries(labels.map((m) => [m, 0]))]));
  for (const r of rows) {
    rec[r.word].t++;
    if (r.correct) rec[r.word].c++;
    share[r.prediction]++;
    conf[r.word][r.prediction]++;
  }
  familyWords[f] = { labels, rec };
  familyPredShare[f] = { labels, share, total: rows.length };
  familyConfusion[f] = { labels, conf };
}

// Behavioral profile deltas, pooled across the two writing tasks. Each word is
// compared against the control condition of its own experiment.
const DIMS = JSON.parse(data[0].json.experiment.dimensions_json);
const profileTable = {};
for (const f of ["positive", "neutral", "negative"]) {
  const labels = familyWords[f].labels;
  const rows = {};
  for (const label of labels) {
    rows[label] = {};
    for (const d of DIMS) {
      const parts = data
        .filter((e) => e.family === f)
        .map((e) => e.json.metrics.profiles[label][d.key]);
      const n = parts.reduce((a, b) => a + b.count, 0);
      rows[label][d.key] = {
        mean: parts.reduce((a, b) => a + b.mean * b.count, 0) / n,
        delta: parts.reduce((a, b) => a + b.delta * b.count, 0) / n,
      };
    }
  }
  profileTable[f] = { labels, rows };
}

// ------------------------------------------------------------------ isolation

const attempts = all.flatMap((e) => e.json.attempts);
const okAttempts = attempts.filter((a) => a.exit_code === 0 && !a.error);
const failedAttempts = attempts.filter((a) => a.exit_code !== 0 || a.error);
const distinct = (rows, key) => new Set(rows.map((r) => r[key])).size;
const kinds = okAttempts.reduce((a, x) => ((a[x.kind] = (a[x.kind] || 0) + 1), a), {});
const durations = okAttempts.map((a) => (a.completed_at - a.started_at) / 1000).sort((a, b) => a - b);
const quantile = (q) => durations[Math.floor(q * (durations.length - 1))];
const medianKind = Object.fromEntries(
  Object.keys(kinds).map((k) => {
    const d = okAttempts.filter((a) => a.kind === k).map((a) => (a.completed_at - a.started_at) / 1000).sort((a, b) => a - b);
    return [k, d[Math.floor(d.length / 2)]];
  })
);
const badProbabilityFailures = failedAttempts.filter((a) => /Probabilities must sum/.test(String(a.error))).length;
const restartFailures = failedAttempts.length - badProbabilityFailures;
const totalComputeMin = durations.reduce((a, b) => a + b, 0) / 60;
// The six writing experiments ran concurrently in one batch. The earlier code
// experiment ran on its own the previous evening, so the two are timed apart.
const writingAttempts = data.flatMap((e) => e.json.attempts).filter((a) => a.exit_code === 0 && !a.error);
const writingComputeMin =
  writingAttempts.reduce((a, x) => a + (x.completed_at - x.started_at), 0) / 60000;
const writingStart = Math.min(...data.map((e) => e.json.experiment.started_at));
const writingEnd = Math.max(...data.map((e) => e.json.experiment.completed_at));
const writingWallMin = (writingEnd - writingStart) / 60000;

// -------------------------------------------------------------- svg utilities

const C = {
  blue: "#3987e5",
  orange: "#d95926",
  red: "#e66767",
  mid: "#383835",
  grid: "#242424",
  text: "#ffffff",
  muted: "#a3a3a3",
};
// Sequential blue ramp, 100 to 700, used for the confusion heatmaps.
const RAMP = ["#0d366b", "#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4", "#cde2fb"];
const rampIndex = (t) => Math.min(RAMP.length - 1, Math.max(0, Math.round(t * (RAMP.length - 1))));
const rampAt = (t) => (t <= 0 ? "transparent" : RAMP[rampIndex(t)]);
// Steps 3 and lighter do not clear 4.5:1 against white text, so they take dark ink.
const inkOn = (t) => (rampIndex(t) >= 3 ? "#000000" : "#ffffff");

const svgOpen = (w, h, label) =>
  `<svg viewBox="0 0 ${w} ${h}" width="100%" height="auto" role="img" aria-label="${esc(label)}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif" style="max-width:100%;display:block">`;

// Horizontal bars, one series, with a dashed reference line for chance.
function accuracyChart(rows, { title, ref, refLabel }) {
  const w = 720;
  const rowH = 46;
  const padL = 132;
  const padR = 96;
  const top = 34;
  const h = top + rows.length * rowH + 34;
  const max = 0.55;
  const scale = (v) => padL + (v / max) * (w - padL - padR);
  let s = svgOpen(w, h, title);
  for (let i = 0; i <= 5; i++) {
    const v = (i / 5) * max;
    s += `<line x1="${scale(v).toFixed(1)}" y1="${top}" x2="${scale(v).toFixed(1)}" y2="${top + rows.length * rowH}" stroke="${C.grid}" stroke-width="1"/>`;
    s += `<text x="${scale(v).toFixed(1)}" y="${top + rows.length * rowH + 22}" fill="${C.muted}" font-size="13" text-anchor="middle">${Math.round(v * 100)}%</text>`;
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH + 9;
    const bw = Math.max(3, scale(r.acc) - padL);
    s += `<text x="${padL - 12}" y="${y + 18}" fill="${C.text}" font-size="14" text-anchor="end">${esc(r.label)}</text>`;
    s += `<rect x="${padL}" y="${y}" width="${bw.toFixed(1)}" height="26" rx="4" fill="${r.color || C.blue}"><title>${esc(r.label)}: ${pct(r.acc)} (${r.k} of ${r.n})</title></rect>`;
    s += `<text x="${(padL + bw + 10).toFixed(1)}" y="${y + 18}" fill="${C.text}" font-size="14" font-weight="600">${pct(r.acc)}</text>`;
    s += `<text x="${w - 4}" y="${y + 18}" fill="${C.muted}" font-size="12" text-anchor="end">${r.k}/${r.n}</text>`;
  });
  const rx = scale(ref);
  // The reference label sits above the plot so it cannot collide with an axis tick.
  s += `<line x1="${rx.toFixed(1)}" y1="${top - 18}" x2="${rx.toFixed(1)}" y2="${top + rows.length * rowH + 2}" stroke="${C.orange}" stroke-width="2" stroke-dasharray="5 4"/>`;
  s += `<text x="${(rx + 8).toFixed(1)}" y="${top - 10}" fill="${C.orange}" font-size="12">${esc(refLabel)}</text>`;
  return s + "</svg>";
}

// Two-series dot plot on a 0 to 1 probability axis.
function presenceChart(rows) {
  const w = 720;
  const rowH = 58;
  const padL = 132;
  const padR = 40;
  const top = 34;
  const h = top + rows.length * rowH + 34;
  const scale = (v) => padL + v * (w - padL - padR);
  let s = svgOpen(w, h, "Judge probability that an adjective was in the prompt");
  s += `<circle cx="${padL}" cy="14" r="6" fill="${C.orange}"/><text x="${padL + 14}" y="19" fill="${C.text}" font-size="13">Control runs (no adjective)</text>`;
  s += `<circle cx="${padL + 250}" cy="14" r="6" fill="${C.blue}"/><text x="${padL + 264}" y="19" fill="${C.text}" font-size="13">Runs with an adjective</text>`;
  for (let i = 0; i <= 4; i++) {
    const v = i / 4;
    s += `<line x1="${scale(v).toFixed(1)}" y1="${top}" x2="${scale(v).toFixed(1)}" y2="${top + rows.length * rowH}" stroke="${C.grid}" stroke-width="1"/>`;
    s += `<text x="${scale(v).toFixed(1)}" y="${top + rows.length * rowH + 22}" fill="${C.muted}" font-size="13" text-anchor="middle">${v.toFixed(2)}</text>`;
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH + rowH / 2;
    s += `<text x="${padL - 12}" y="${y + 5}" fill="${C.text}" font-size="14" text-anchor="end">${esc(r.label)}</text>`;
    const a = scale(Math.min(r.ctrlMean, r.wordMean));
    const b = scale(Math.max(r.ctrlMean, r.wordMean));
    s += `<line x1="${a.toFixed(1)}" y1="${y}" x2="${b.toFixed(1)}" y2="${y}" stroke="${C.mid}" stroke-width="2"/>`;
    s += `<circle cx="${scale(r.ctrlMean).toFixed(1)}" cy="${y}" r="7" fill="${C.orange}" stroke="#000" stroke-width="2"><title>${esc(r.label)} control mean ${r.ctrlMean.toFixed(3)}</title></circle>`;
    s += `<circle cx="${scale(r.wordMean).toFixed(1)}" cy="${y}" r="7" fill="${C.blue}" stroke="#000" stroke-width="2"><title>${esc(r.label)} adjective mean ${r.wordMean.toFixed(3)}</title></circle>`;
    s += `<text x="${scale(r.ctrlMean).toFixed(1)}" y="${y - 14}" fill="${C.muted}" font-size="12" text-anchor="middle">${r.ctrlMean.toFixed(2)}</text>`;
    s += `<text x="${scale(r.wordMean).toFixed(1)}" y="${y + 25}" fill="${C.muted}" font-size="12" text-anchor="middle">${r.wordMean.toFixed(2)}</text>`;
  });
  return s + "</svg>";
}

// Diverging bars around a zero axis. Blue arm is positive, red arm is negative.
function divergingChart(rows, { title, max, unit }) {
  const w = 720;
  const rowH = 30;
  const padL = 132;
  const padR = 24;
  const top = 26;
  const h = top + rows.length * rowH + 30;
  const zero = padL + (w - padL - padR) / 2;
  const half = (w - padL - padR) / 2;
  const scale = (v) => zero + (v / max) * half;
  let s = svgOpen(w, h, title);
  for (const v of [-max, -max / 2, 0, max / 2, max]) {
    const x = scale(v);
    s += `<line x1="${x.toFixed(1)}" y1="${top - 8}" x2="${x.toFixed(1)}" y2="${top + rows.length * rowH}" stroke="${v === 0 ? C.mid : C.grid}" stroke-width="${v === 0 ? 2 : 1}"/>`;
    s += `<text x="${x.toFixed(1)}" y="${top - 14}" fill="${C.muted}" font-size="12" text-anchor="middle">${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}</text>`;
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH + 4;
    const x = scale(r.value);
    const bw = Math.abs(x - zero);
    s += `<text x="${padL - 12}" y="${y + 15}" fill="${r.emphasis ? C.text : C.muted}" font-size="13" text-anchor="end">${esc(r.label)}</text>`;
    s += `<rect x="${Math.min(x, zero).toFixed(1)}" y="${y}" width="${Math.max(2, bw).toFixed(1)}" height="21" rx="4" fill="${r.value < 0 ? C.red : C.blue}"><title>${esc(r.label)}: ${sgn(r.value)} ${esc(unit)}</title></rect>`;
    // Long bars carry the value inside so it can never collide with the row label.
    const inside = bw > 44;
    const lx = r.value < 0 ? Math.min(x, zero) + (inside ? 8 : -8) : Math.max(x, zero) + (inside ? -8 : 8);
    const anchor = r.value < 0 ? (inside ? "start" : "end") : inside ? "end" : "start";
    s += `<text x="${lx.toFixed(1)}" y="${y + 15}" fill="${inside ? "#000000" : C.text}" font-size="12" font-weight="${inside ? 600 : 400}" text-anchor="${anchor}">${sgn(r.value, 1)}</text>`;
  });
  return s + "</svg>";
}

// Stacked share bar showing which labels the judge actually reached for.
function shareChart(rows) {
  const w = 720;
  const rowH = 64;
  const padL = 132;
  const h = rows.length * rowH + 10;
  let s = svgOpen(w, h, "Share of predicted labels by word family");
  rows.forEach((r, i) => {
    const y = i * rowH + 8;
    s += `<text x="0" y="${y + 20}" fill="${C.text}" font-size="14" font-weight="600">${esc(r.label)}</text>`;
    let x = padL;
    const width = w - padL;
    r.parts.forEach((p, j) => {
      const pw = (p.count / r.total) * width;
      const t = 0.85 - j * 0.16;
      const isCtrl = p.label === "control";
      const fill = isCtrl ? C.mid : rampAt(t);
      s += `<rect x="${x.toFixed(1)}" y="${y}" width="${Math.max(0, pw - 2).toFixed(1)}" height="26" rx="3" fill="${fill}"><title>${esc(p.label)}: ${p.count} of ${r.total} predictions</title></rect>`;
      if (pw > 62)
        s += `<text x="${(x + 8).toFixed(1)}" y="${y + 18}" fill="${isCtrl ? "#ffffff" : inkOn(t)}" font-size="12" font-weight="600">${esc(p.label)}</text>`;
      x += pw;
    });
    s += `<text x="${padL}" y="${y + 46}" fill="${C.muted}" font-size="12">${r.parts.map((p) => `${p.label} ${Math.round((100 * p.count) / r.total)}%`).join("  ·  ")}</text>`;
  });
  return s + "</svg>";
}

// -------------------------------------------------------------- html sections

const familyLabel = { positive: "Positive words", neutral: "Neutral words", negative: "Negative words" };

// Range of a profile shift across the five adjectives of one family, smallest
// magnitude first, so prose reads in the natural order.
const deltaRange = (family, dim) => {
  const mags = profileTable[family].labels
    .filter((l) => l !== "control")
    .map((l) => Math.abs(profileTable[family].rows[l][dim].delta));
  return { min: Math.min(...mags), max: Math.max(...mags) };
};
const biggestShift = (family, dim) => {
  let best = null;
  for (const l of profileTable[family].labels) {
    if (l === "control") continue;
    const d = profileTable[family].rows[l][dim].delta;
    if (!best || Math.abs(d) > Math.abs(best.delta)) best = { label: l, delta: d };
  }
  return best;
};
// Largest absolute shift anywhere in a family, across every word and dimension.
const largestShift = (family) => {
  let best = null;
  for (const l of profileTable[family].labels) {
    if (l === "control") continue;
    for (const d of DIMS) {
      const delta = profileTable[family].rows[l][d.key].delta;
      if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { label: l, dim: d.label, delta };
    }
  }
  return best;
};
// Control means for one task, averaged over the three families of that task.
const controlMean = (task, dim) => {
  const parts = data.filter((e) => e.task === task).map((e) => e.json.metrics.profiles.control[dim]);
  const n = parts.reduce((a, b) => a + b.count, 0);
  return parts.reduce((a, b) => a + b.mean * b.count, 0) / n;
};
const familyWordList = {
  positive: "beautiful, lovely, pretty, attractive, gorgeous",
  neutral: "ordinary, plain, normal, typical, standard",
  negative: "ugly, unattractive, hideous, unpleasant, unsightly",
};

const accRows = [
  ...families.map((f) => ({ label: familyLabel[f.family], acc: f.acc, k: f.k, n: f.n })),
];

const presenceRows = presenceFamilies.map((f) => ({ label: familyLabel[f.family], ...f }));

const pleasantnessRows = [];
for (const f of ["positive", "neutral", "negative"]) {
  for (const label of profileTable[f].labels) {
    if (label === "control") continue;
    pleasantnessRows.push({
      label,
      value: profileTable[f].rows[label].pleasantness.delta,
      emphasis: f === "negative",
    });
  }
}

const shareRows = ["positive", "neutral", "negative"].map((f) => {
  const { share, total } = familyPredShare[f];
  const parts = Object.entries(share)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }));
  return { label: familyLabel[f], parts, total };
});

function confusionTable(family) {
  const { labels, conf } = familyConfusion[family];
  let s = `<div class="scroll"><table class="grid"><caption>${esc(familyLabel[family])}: true label down the side, blind judge prediction across the top. Poem and paragraph runs pooled.</caption><thead><tr><th scope="col">True</th>`;
  for (const l of labels) s += `<th scope="col">${esc(l)}</th>`;
  s += `<th scope="col">Recall</th></tr></thead><tbody>`;
  for (const t of labels) {
    const row = conf[t];
    const total = Object.values(row).reduce((a, b) => a + b, 0);
    s += `<tr><th scope="row">${esc(t)}</th>`;
    for (const p of labels) {
      const v = row[p];
      const t01 = total ? v / total : 0;
      const step = 0.2 + 0.8 * t01;
      const bg = v === 0 ? "transparent" : rampAt(step);
      s += `<td class="cell${t === p ? " diag" : ""}" style="background:${bg};color:${v === 0 ? C.muted : inkOn(step)}">${v || "·"}</td>`;
    }
    s += `<td class="num">${total ? pct(row[t] / total, 0) : "·"}</td></tr>`;
  }
  return s + "</tbody></table></div>";
}

function profileTableHtml(family) {
  const { labels, rows } = profileTable[family];
  let s = `<div class="scroll"><table class="grid"><caption>${esc(familyLabel[family])}: control row is the absolute mean on a 1 to 7 scale. Every other row is the shift against that control.</caption><thead><tr><th scope="col">Condition</th>`;
  for (const d of DIMS) s += `<th scope="col">${esc(d.label)}</th>`;
  s += `</tr></thead><tbody>`;
  for (const label of labels) {
    const isC = label === "control";
    s += `<tr${isC ? ' class="baseline"' : ""}><th scope="row">${esc(isC ? "control (baseline)" : label)}</th>`;
    for (const d of DIMS) {
      const cellValue = isC ? rows[label][d.key].mean : rows[label][d.key].delta;
      const strong = !isC && Math.abs(cellValue) >= 1;
      const cls = isC ? "num" : `num ${strong ? (cellValue < 0 ? "neg" : "pos") : "flat"}`;
      s += `<td class="${cls}">${isC ? cellValue.toFixed(2) : sgn(cellValue)}</td>`;
    }
    s += `</tr>`;
  }
  return s + "</tbody></table></div>";
}

function sampleBlock(entry) {
  const r = entry;
  return `<article class="sample">
  <header class="sample-head">
    <span class="tag">${esc(r.task)}</span>
    <span class="tag ${r.isControl ? "tag-ctrl" : ""}">${esc(r.isControl ? "no adjective" : r.word)}</span>
    <span class="tag ${r.correct ? "tag-hit" : "tag-miss"}">judge said ${esc(r.prediction)}</span>
    <span class="tag">P(adjective) ${r.presence.toFixed(2)}</span>
  </header>
  <pre>${esc(r.text)}</pre>
</article>`;
}

// Sample selection is explicit about which experiment a control comes from,
// because each family has its own control condition.
const findRun = (task, family, word, idx = 1) =>
  writingRuns.find((r) => r.task === task && r.family === family && r.word === word && r.runIndex === idx);

const leakRun = writingRuns.find((r) => r.leak);

// Compact per-run appendix table.
function runAppendix() {
  let s = `<div class="scroll"><table class="grid compact"><thead><tr><th scope="col">Task</th><th scope="col">Family</th><th scope="col">Condition</th><th scope="col">Run</th><th scope="col">Prediction</th><th scope="col">Hit</th><th scope="col">P(true label)</th><th scope="col">P(adjective)</th><th scope="col">Bytes</th></tr></thead><tbody>`;
  for (const r of writingRuns) {
    s += `<tr${r.leak ? ' class="excluded"' : ""}><td>${esc(r.task)}</td><td>${esc(r.family)}</td><td>${esc(r.isControl ? "control" : r.word)}</td><td class="num">${r.runIndex}</td><td>${esc(r.prediction)}</td><td class="num">${r.leak ? "excluded" : r.correct ? "yes" : "no"}</td><td class="num">${(r.probs[r.word] ?? 0).toFixed(3)}</td><td class="num">${r.presence.toFixed(3)}</td><td class="num">${r.bytes}</td></tr>`;
  }
  return s + "</tbody></table></div>";
}

function allTexts() {
  let s = "";
  for (const e of data) {
    const rows = writingRuns.filter((r) => r.task === e.task && r.family === e.family);
    s += `<details class="corpus"><summary>${esc(e.json.experiment.name)} (${rows.length} outputs)</summary>`;
    for (const r of rows) s += sampleBlock(r);
    s += `</details>`;
  }
  return s;
}

// --------------------------------------------------------- rendered ui shots

const SHOT_DIR = process.env.WORDS_SHOT_DIR || "/tmp/words-ui-shots";

// Minimal JPEG dimension reader, so every <img> can carry width and height and
// the page does not reflow as images decode.
function jpegSize(buffer) {
  let i = 2;
  while (i < buffer.length) {
    if (buffer[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buffer[i + 1];
    const length = buffer.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  throw new Error("could not read JPEG dimensions");
}

const shot = (name, alt) => {
  const buffer = readFileSync(join(SHOT_DIR, `${name}.jpg`));
  const { width, height } = jpegSize(buffer);
  return `<img src="data:image/jpeg;base64,${buffer.toString("base64")}" width="${width}" height="${height}" alt="${esc(alt)}" loading="lazy" decoding="async">`;
};

const codeRunFor = (word, index) =>
  codeRuns.find((r) => r.word === word && r.runIndex === index);

// One card per condition: the rendered panel plus what the blind judge called it.
function panelCard(word, index, prefix) {
  const run = codeRunFor(word, index);
  const isControl = word === "control";
  return `<figure class="panel-shot">
  ${shot(`${prefix}-${word}${prefix === "strip" ? `-${index}` : ""}`, `Settings panel generated under the ${isControl ? "no adjective" : word} condition, run ${index}`)}
  <figcaption>
    <span class="shot-word">${esc(isControl ? "no adjective" : word)}${prefix === "strip" ? ` &middot; run ${index}` : ""}</span>
    <span class="shot-guess ${run.correct ? "hit" : "miss"}">judge said ${esc(run.prediction)}</span>
  </figcaption>
</figure>`;
}

const CODE_WORDS = ["control", "lovely", "beautiful", "elegant", "polished", "refined"];

const DL = [
  ["Complete project and results archive", "https://tools.mauroner.net/files/xtEsJUuNn0WNHyP1JtlCISnNYpV3vZVY/words-of-meaning-expanded-complete.tar.gz"],
  ["Original React UI dataset", "https://tools.mauroner.net/files/xP06ocTYWsy6Zk2nFL9rndXJbEjdlGbE/five-runs-per-condition-export.json"],
  ["Positive poems", "https://tools.mauroner.net/files/EYO7cxvsxlgaWFlCOpA1Nr87wToLEQUm/poem-positive-export.json"],
  ["Neutral poems", "https://tools.mauroner.net/files/YFcnMBMUWX-JcbfN3Y0YXrqQqYU3Qa-f/poem-neutral-export.json"],
  ["Negative poems", "https://tools.mauroner.net/files/z-DIB8Oew6mH_o1G3GAlUgQMvwOzVmYs/poem-negative-export.json"],
  ["Positive paragraphs", "https://tools.mauroner.net/files/vJyo1kCRNdjnbyxw6A97iazub_oFOuLy/paragraph-positive-export.json"],
  ["Neutral paragraphs", "https://tools.mauroner.net/files/-5FnaPyyGiO-7NLtyw9zeB6UMSb3v-5m/paragraph-neutral-export.json"],
  ["Negative paragraphs", "https://tools.mauroner.net/files/gGdIx77JzDc21Tft0snN_uEvl8W6l9iM/paragraph-negative-export.json"],
];
const REPORT_URL = "https://tools.mauroner.net/artifacts/m0OBJXAr9i6usgpLjrhh2zWN_I1jlR9r";

const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;

// ------------------------------------------------------------------- document

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Words of Meaning: what an adjective does to a model's output</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; background: #000; color: #fff;
    font: 16px/1.62 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 62rem; margin: 0 auto; padding: 2.2rem 1.1rem 5rem; }
  h1 { font-size: clamp(1.7rem, 4.6vw, 2.5rem); line-height: 1.16; letter-spacing: -0.02em; margin: 0 0 .7rem; }
  h2 { font-size: clamp(1.2rem, 3vw, 1.5rem); letter-spacing: -0.01em; margin: 3rem 0 .9rem; padding-top: 1.4rem; border-top: 1px solid #262626; }
  h3 { font-size: 1.02rem; margin: 1.9rem 0 .55rem; }
  p { margin: 0 0 1rem; }
  a { color: #7fb4f2; }
  a:hover { color: #fff; }
  code, pre, .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
  code { background: #121212; border: 1px solid #262626; border-radius: 4px; padding: .06em .34em; font-size: .87em; }
  .lede { font-size: 1.09rem; color: #d6d6d6; }
  .meta { color: #a3a3a3; font-size: .85rem; margin: 0 0 1.6rem; }
  .panel { background: #0b0b0b; border: 1px solid #262626; border-radius: 10px; padding: 1rem 1.1rem; margin: 1.3rem 0; }
  .panel > :last-child { margin-bottom: 0; }
  .callout { border-left: 3px solid #3987e5; }
  .warn { border-left: 3px solid #d95926; }
  figure { margin: 1.3rem 0; }
  figcaption { color: #a3a3a3; font-size: .84rem; margin-top: .55rem; }
  .stats { display: grid; gap: .6rem; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); margin: 1.5rem 0 1.9rem; }
  .stat { background: #0b0b0b; border: 1px solid #262626; border-radius: 10px; padding: .8rem .85rem; }
  .stat b { display: block; font-size: 1.55rem; line-height: 1.12; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .stat span { display: block; color: #a3a3a3; font-size: .78rem; margin-top: .25rem; }
  .scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 1rem 0; }
  table { border-collapse: collapse; width: 100%; font-size: .88rem; }
  caption { text-align: left; color: #a3a3a3; font-size: .82rem; padding-bottom: .5rem; }
  th, td { border: 1px solid #262626; padding: .4rem .55rem; text-align: left; white-space: nowrap; }
  thead th { background: #101010; font-size: .79rem; color: #d6d6d6; font-weight: 600; }
  tbody th { background: #0b0b0b; font-weight: 500; }
  .num { text-align: right; font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .cell { text-align: center; font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; min-width: 2.6rem; }
  .diag { outline: 2px solid currentColor; outline-offset: -3px; font-weight: 700; }
  .pos { color: #7fb4f2; }
  .neg { color: #e66767; }
  .flat { color: #7d7d7d; }
  .baseline th, .baseline td { background: #101010; }
  .excluded { opacity: .55; }
  .compact { font-size: .8rem; }
  .compact td, .compact th { padding: .24rem .45rem; }
  ul, ol { margin: 0 0 1rem; padding-left: 1.2rem; }
  li { margin-bottom: .34rem; }
  .sample { background: #0b0b0b; border: 1px solid #262626; border-radius: 10px; padding: .8rem .9rem; margin: .8rem 0; }
  .sample-head { display: flex; flex-wrap: wrap; gap: .35rem; margin-bottom: .6rem; }
  .tag { background: #171717; border: 1px solid #2e2e2e; border-radius: 999px; padding: .1rem .55rem; font-size: .74rem; color: #d6d6d6; }
  .tag-ctrl { border-color: #4a4a46; }
  .tag-hit { border-color: #3987e5; color: #9ec5f4; }
  .tag-miss { border-color: #6b2f18; color: #f0a184; }
  .sample pre { margin: 0; white-space: pre-wrap; word-wrap: break-word; font-size: .87rem; line-height: 1.55; color: #e6e6e6; }
  .pair { display: grid; gap: .8rem; grid-template-columns: 1fr; }
  @media (min-width: 45rem) { .pair { grid-template-columns: 1fr 1fr; } }
  details { background: #0b0b0b; border: 1px solid #262626; border-radius: 10px; padding: .7rem .9rem; margin: .8rem 0; }
  summary { cursor: pointer; font-weight: 600; }
  details .sample { background: #0f0f0f; }
  .shots { display: grid; gap: .8rem; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); margin: 1.2rem 0; }
  .strip { display: grid; gap: .55rem; grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr)); margin: .8rem 0 1.4rem; }
  .panel-shot { margin: 0; background: #0b0b0b; border: 1px solid #262626; border-radius: 10px; padding: .5rem; }
  .panel-shot img { width: 100%; height: auto; display: block; border-radius: 6px; background: #101010; }
  .panel-shot figcaption { display: flex; flex-wrap: wrap; gap: .3rem .5rem; align-items: baseline; margin-top: .5rem; font-size: .8rem; }
  .shot-word { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #fff; }
  .shot-guess { color: #a3a3a3; font-size: .74rem; }
  .shot-guess.hit { color: #9ec5f4; }
  .strip .panel-shot figcaption { display: block; font-size: .72rem; line-height: 1.35; }
  .strip .shot-guess { display: block; }
  .dl { list-style: none; padding: 0; }
  .dl li { margin-bottom: .4rem; }
  .kv { display: grid; grid-template-columns: 1fr; gap: .1rem .9rem; font-size: .9rem; }
  @media (min-width: 40rem) { .kv { grid-template-columns: max-content 1fr; } }
  .kv dt { color: #a3a3a3; }
  .kv dd { margin: 0 0 .35rem; }
  footer { margin-top: 3rem; padding-top: 1.3rem; border-top: 1px solid #262626; color: #a3a3a3; font-size: .84rem; }
</style>
</head>
<body>
<main>

<h1>Words of Meaning: an adjective only moves the output when it points away from the default</h1>
<p class="lede">A blind identification benchmark over 210 isolated model runs. A generator writes a poem, a paragraph, or a React panel under one injected adjective. A separate blind judge, which never sees the prompt, tries to name the adjective from the output alone. Across 179 eligible writing runs the judge was right 25.1% of the time against 16.7% chance. Almost all of that signal came from one family of words.</p>
<p class="meta">Generator and judge: <span class="mono">gpt-5.6-terra</span>, low reasoning, Codex SDK 0.151.0 &middot; 7 experiments &middot; 210 generations &middot; ${okAttempts.length} successful isolated model calls &middot; writing batch run ${new Date(writingStart).toISOString().slice(0, 10)}</p>

<div class="stats">
  <div class="stat"><b>${pct(overall.acc)}</b><span>Identification, all writing runs (${overall.k} of ${overall.n})</span></div>
  <div class="stat"><b>${pfmt(overall.p)}</b><span>Exact one-sided p against 16.7% chance</span></div>
  <div class="stat"><b>${pct(families[2].acc)}</b><span>Negative words</span></div>
  <div class="stat"><b>${pct(families[0].acc)}</b><span>Positive words</span></div>
  <div class="stat"><b>${pct(families[1].acc)}</b><span>Neutral words</span></div>
  <div class="stat"><b>${presenceFamilies[2].wordHit}/${presenceFamilies[2].wordN}</b><span>Negative adjectives detected as present</span></div>
  <div class="stat"><b>${presenceFamilies[1].wordHit}/${presenceFamilies[1].wordN}</b><span>Neutral adjectives detected as present</span></div>
  <div class="stat"><b>${sgn(profileTable.negative.rows.unpleasant.pleasantness.delta, 1)}</b><span>Largest pleasantness shift, 1 to 7 scale</span></div>
</div>

<div class="panel callout">
<p><strong>The finding in one line.</strong> Positive aesthetic adjectives such as <code>beautiful</code> and <code>lovely</code> are close to no-ops, because the model already writes at the top of the pleasantness scale without being asked. Neutral adjectives such as <code>ordinary</code> and <code>plain</code> leave no measurable trace at all. Only negative adjectives move the output, and they move it far.</p>
</div>

<h2>What the benchmark does</h2>
<p>Each experiment fixes one task and six conditions: five adjectives plus a required no-adjective control. Each condition runs five times. Every run is a three-stage pipeline, and every stage is a separate short-lived process with its own thread and its own temporary workspace.</p>
<ol>
  <li><strong>Generate.</strong> A fresh model process receives the task with one adjective spliced into it, and writes <code>output.md</code>.</li>
  <li><strong>Classify.</strong> A second fresh process receives only the adjective-free task and the generated text, plus a randomized list of the six candidate labels. It returns a probability for each. It never sees the condition, the run index, the generator thread, or the true label.</li>
  <li><strong>Profile.</strong> A third fresh process scores the same text on a fixed 1 to 7 rubric, also blind.</li>
</ol>
<p>Truth is joined only in the parent process, at scoring time. A run whose output contains its own condition word is excluded from every accuracy metric, because that is leakage rather than style.</p>

<div class="scroll">
<table class="grid">
<caption>The seven experiments. The first six share two everyday writing tasks; the seventh is the earlier code-generation run kept for contrast.</caption>
<thead><tr><th scope="col">Experiment</th><th scope="col">Task</th><th scope="col">Conditions</th><th scope="col">Runs</th><th scope="col">Eligible</th><th scope="col">Correct</th><th scope="col">Accuracy</th><th scope="col">p</th><th scope="col">95% Wilson</th><th scope="col">Log loss</th></tr></thead>
<tbody>
${all
  .map((e) => {
    const m = e.json.metrics;
    const w = m.significance.accuracyWilson95;
    return `<tr><th scope="row">${esc(e.json.experiment.name)}</th><td>${esc(e.task)}</td><td class="mono" style="white-space:normal">${esc(m.labels.filter((l) => l !== "control").join(", "))}</td><td class="num">${e.json.runs.length}</td><td class="num">${m.eligibleCount}</td><td class="num">${m.correctCount}</td><td class="num">${pct(m.accuracy)}</td><td class="num">${pfmt(m.significance.oneSidedPValue)}</td><td class="num">${pct(w[0], 0)} to ${pct(w[1], 0)}</td><td class="num">${m.logLoss.toFixed(2)}</td></tr>`;
  })
  .join("\n")}
</tbody>
</table>
</div>

<h2>Result 1: the pooled signal is real but narrow</h2>
<p>Pooling the six writing experiments gives ${overall.k} correct identifications out of ${overall.n} eligible runs, or ${pct(overall.acc)} against a ${pct(CHANCE)} chance rate. The exact one-sided binomial p is ${pfmt(overall.p)} and the 95% Wilson interval is ${pct(overall.lo)} to ${pct(overall.hi)}. Both writing tasks clear the threshold on their own: poems at ${pct(tasks[0].acc)} (p = ${pfmt(tasks[0].p)}) and paragraphs at ${pct(tasks[1].acc)} (p = ${pfmt(tasks[1].p)}).</p>
<p>Splitting by word family shows the pooled number is an average over three very different regimes.</p>

<figure>
${accuracyChart(accRows, { title: "Identification accuracy by word family", ref: CHANCE, refLabel: "chance 16.7%" })}
<figcaption>Blind identification accuracy, poem and paragraph runs pooled. Dashed line is the ${pct(CHANCE)} rate expected from guessing among six labels. Negative words: p = ${pfmt(families[2].p)}. Positive: p = ${pfmt(families[0].p)}. Neutral: p = ${pfmt(families[1].p)}.</figcaption>
</figure>

<div class="scroll">
<table class="grid">
<caption>Family totals, poem and paragraph pooled.</caption>
<thead><tr><th scope="col">Family</th><th scope="col">Words</th><th scope="col">Correct</th><th scope="col">Eligible</th><th scope="col">Accuracy</th><th scope="col">One-sided p</th><th scope="col">95% Wilson</th></tr></thead>
<tbody>
${families
  .map(
    (f) =>
      `<tr><th scope="row">${esc(familyLabel[f.family])}</th><td class="mono" style="white-space:normal">${esc(familyWordList[f.family])}</td><td class="num">${f.k}</td><td class="num">${f.n}</td><td class="num">${pct(f.acc)}</td><td class="num">${pfmt(f.p)}</td><td class="num">${pct(f.lo)} to ${pct(f.hi)}</td></tr>`
  )
  .join("\n")}
<tr class="baseline"><th scope="row">All writing runs</th><td>15 adjectives and 6 controls</td><td class="num">${overall.k}</td><td class="num">${overall.n}</td><td class="num">${pct(overall.acc)}</td><td class="num">${pfmt(overall.p)}</td><td class="num">${pct(overall.lo)} to ${pct(overall.hi)}</td></tr>
</tbody>
</table>
</div>

<h2>Result 2: the judge can always tell when a negative word was used, and almost never when a neutral one was</h2>
<p>Identification is a hard six-way task. A softer question separates the families much more cleanly: did any adjective appear in the prompt at all? That is the probability mass the judge put on every label except <code>control</code>. It is a single number per run, and it does not require the judge to pick the right synonym.</p>

<figure>
${presenceChart(presenceRows)}
<figcaption>Mean judged probability that an adjective was present. The gap between the two dots is the whole effect of the word family. Negative words open a gap of ${(presenceFamilies[2].wordMean - presenceFamilies[2].ctrlMean).toFixed(2)}. Neutral words open a gap of ${(presenceFamilies[1].wordMean - presenceFamilies[1].ctrlMean).toFixed(2)}.</figcaption>
</figure>

<div class="scroll">
<table class="grid">
<caption>Presence detection at a 0.5 threshold. "Adjective found" counts worded runs judged as worded. "Control clean" counts control runs judged as unworded.</caption>
<thead><tr><th scope="col">Family</th><th scope="col">Control mean</th><th scope="col">Adjective mean</th><th scope="col">Adjective found</th><th scope="col">Control clean</th><th scope="col">Presence accuracy</th></tr></thead>
<tbody>
${presenceFamilies
  .map(
    (f) =>
      `<tr><th scope="row">${esc(familyLabel[f.family])}</th><td class="num">${f.ctrlMean.toFixed(3)}</td><td class="num">${f.wordMean.toFixed(3)}</td><td class="num">${f.wordHit} / ${f.wordN}</td><td class="num">${f.ctrlHit} / ${f.ctrlN}</td><td class="num">${pct(f.acc)}</td></tr>`
  )
  .join("\n")}
<tr class="baseline"><th scope="row">All writing runs</th><td class="num">${presenceOverall.ctrlMean.toFixed(3)}</td><td class="num">${presenceOverall.wordMean.toFixed(3)}</td><td class="num">${presenceOverall.wordHit} / ${presenceOverall.wordN}</td><td class="num">${presenceOverall.ctrlHit} / ${presenceOverall.ctrlN}</td><td class="num">${pct(presenceOverall.acc)}</td></tr>
</tbody>
</table>
</div>

<p>Three regimes fall out of that table.</p>
<ul>
  <li><strong>Negative words are fully legible.</strong> Every one of the ${presenceFamilies[2].wordN} eligible negative runs was flagged as worded, and every one of the ${presenceFamilies[2].ctrlN} controls was flagged as clean. That is ${presenceFamilies[2].wordN + presenceFamilies[2].ctrlN} of ${presenceFamilies[2].wordN + presenceFamilies[2].ctrlN} correct on presence.</li>
  <li><strong>Neutral words are invisible.</strong> Only ${presenceFamilies[1].wordHit} of ${presenceFamilies[1].wordN} runs under <code>ordinary</code>, <code>plain</code>, <code>normal</code>, <code>typical</code>, or <code>standard</code> looked worded to the judge. Asking for an ordinary poem produced text the judge could not distinguish from asking for a poem.</li>
  <li><strong>Positive words are detected, but so are the controls.</strong> The mean for positive runs is ${presenceFamilies[0].wordMean.toFixed(2)}, which is high. The problem is that the mean for their own controls is ${presenceFamilies[0].ctrlMean.toFixed(2)}, and only ${presenceFamilies[0].ctrlHit} of ${presenceFamilies[0].ctrlN} controls were recognized as unworded. The unprompted default already looks like someone asked for something beautiful.</li>
</ul>

<div class="panel callout">
<p><strong>Why the pooled number understates the effect.</strong> Presence accuracy for the negative family is ${pct(presenceFamilies[2].acc, 0)}. The six-way identification score for the same runs is ${pct(families[2].acc)}. The judge knows something happened long before it can name which synonym caused it. Identification accuracy measures naming, not detection, and the two come apart.</p>
</div>

<h2>Result 3: predictions collapse onto a prototype word</h2>
<p>Within a family the judge does not spread its guesses. It reaches for one prototype and stays there.</p>

<figure>
${shareChart(shareRows)}
<figcaption>Share of the ${overall.n} predicted labels, by family. Every label was available in every run; the randomized candidate order removes position bias. Labels absent from a bar were never predicted once.</figcaption>
</figure>

<p>Under negative prompts, <code>ugly</code> absorbed ${familyPredShare.negative.share.ugly} of ${familyPredShare.negative.total} predictions while <code>unsightly</code> was never chosen. Under positive prompts, <code>beautiful</code> and <code>gorgeous</code> took ${familyPredShare.positive.share.beautiful + familyPredShare.positive.share.gorgeous} of ${familyPredShare.positive.total}, and <code>pretty</code> and <code>attractive</code> were never chosen. Under neutral prompts, <code>control</code> took ${familyPredShare.neutral.share.control} of ${familyPredShare.neutral.total}. Five distinct neutral adjectives collapsed into "no adjective was used".</p>
<p>This is what caps identification accuracy in the negative family. The effect on the text is unmistakable, but the five negative words produce nearly the same text as each other, so the judge cannot split them.</p>

${confusionTable("negative")}
${confusionTable("positive")}
${confusionTable("neutral")}

<h3>Per-word recall</h3>
<div class="scroll">
<table class="grid">
<caption>Recall for each condition, poem and paragraph pooled. The <code>ugly</code> denominator is 9 because one poem repeated the word and was excluded.</caption>
<thead><tr><th scope="col">Family</th><th scope="col">Condition</th><th scope="col">Correct</th><th scope="col">Runs</th><th scope="col">Recall</th></tr></thead>
<tbody>
${["negative", "positive", "neutral"]
  .flatMap((f) =>
    familyWords[f].labels.map(
      (l) =>
        `<tr><td>${esc(familyLabel[f])}</td><th scope="row">${esc(l === "control" ? "control" : l)}</th><td class="num">${familyWords[f].rec[l].c}</td><td class="num">${familyWords[f].rec[l].t}</td><td class="num">${pct(familyWords[f].rec[l].c / familyWords[f].rec[l].t, 0)}</td></tr>`
    )
  )
  .join("\n")}
</tbody>
</table>
</div>

<h2>Result 4: the behavioral scores show where the movement is</h2>
<p>A third blind pass scores each output on seven dimensions from 1 to 7, with no knowledge of the condition. Comparing each word against the control of its own experiment turns the classification result into a magnitude.</p>

<figure>
${divergingChart(pleasantnessRows, { title: "Pleasantness shift against control", max: 6, unit: "points of pleasantness" })}
<figcaption>Change in judged pleasantness against the matched control, on a 1 to 7 scale, poem and paragraph pooled. Negative adjectives move the text by ${Math.abs(profileTable.negative.rows.ugly.pleasantness.delta).toFixed(1)} to ${Math.abs(profileTable.negative.rows.unpleasant.pleasantness.delta).toFixed(1)} points. No positive adjective moves it by more than ${Math.max(...profileTable.positive.labels.filter((l) => l !== "control").map((l) => Math.abs(profileTable.positive.rows[l].pleasantness.delta))).toFixed(1)}.</figcaption>
</figure>

<p>The asymmetry has a simple cause: a ceiling. Without any adjective at all, control poems already average ${controlMean("poem", "pleasantness").toFixed(1)} of 7 on pleasantness and control paragraphs average ${controlMean("paragraph", "pleasantness").toFixed(1)} of 7. There is almost no headroom above the default. There is a great deal of room below it, and the negative words use all of it.</p>

${profileTableHtml("negative")}
${profileTableHtml("positive")}
${profileTableHtml("neutral")}

<p>Reading down the negative table, the shift is not only in valence. Negative tone rises by ${deltaRange("negative", "negative_tone").min.toFixed(1)} to ${deltaRange("negative", "negative_tone").max.toFixed(1)} points, conventionality drops by ${deltaRange("negative", "conventionality").min.toFixed(1)} to ${deltaRange("negative", "conventionality").max.toFixed(1)} points, and formality drops as well, so a negative adjective also buys rougher and less predictable diction. Sensory imagery barely moves in any family, which suggests the model treats density of detail as part of the task rather than part of the adjective.</p>
<p>The neutral table is the flattest thing in the study. Across five words and seven dimensions its largest single shift is ${sgn(largestShift("neutral").delta, 1)} points, on ${esc(largestShift("neutral").dim.toLowerCase())} under <code>${esc(largestShift("neutral").label)}</code>. For comparison, the largest shift in the negative family is ${sgn(largestShift("negative").delta, 1)} points. Asking for ordinary output makes the output very slightly more expected, and nothing else.</p>

<h2>What the outputs actually look like</h2>
<p>The statistics describe a difference that is obvious on sight. These are first runs, unedited.</p>

<h3>Poem, no adjective</h3>
${sampleBlock(findRun("poem", "positive", "control", 1))}
<h3>Poem, "beautiful"</h3>
${sampleBlock(findRun("poem", "positive", "beautiful", 1))}
<h3>Poem, "ordinary"</h3>
${sampleBlock(findRun("poem", "neutral", "ordinary", 1))}
<h3>Poem, "ugly"</h3>
${sampleBlock(findRun("poem", "negative", "ugly", 1))}

<p>The first three are the same poem written three times. A train or a bus, leaves at a gate, a key, warm lamplight, a kettle. The judge swapped the first two outright: it called the unprompted control "beautiful" and called the "beautiful" one a control. Both readings are defensible, which is the point. Only "ugly" writes a different poem, with a fence that leans like a bad tooth and a home that opens its tired mouth.</p>

<div class="pair">
<div>
<h3>Paragraph, no adjective</h3>
${sampleBlock(findRun("paragraph", "negative", "control", 1))}
</div>
<div>
<h3>Paragraph, "ugly"</h3>
${sampleBlock(findRun("paragraph", "negative", "ugly", 1))}
</div>
</div>

<p>Same bakery, same pre-dawn hour, same four beats: flour on the floor, croissants on a rack, a delivery passing, a first customer at the glass. One has croissants in neat golden rows; the other has them sitting crookedly with butter leaking onto the sheet pan, under a flickering bulb that makes the cakes look gray at the edges. The judge scored the second at ${findRun("paragraph", "negative", "ugly", 1).presence.toFixed(2)} on "an adjective was used" and guessed <code>${esc(findRun("paragraph", "negative", "ugly", 1).prediction)}</code>, which is the wrong synonym and the right family.</p>

<h3>Paragraph, "gorgeous"</h3>
${sampleBlock(findRun("paragraph", "positive", "gorgeous", 1))}
<h3>Paragraph, "plain"</h3>
${sampleBlock(findRun("paragraph", "neutral", "plain", 1))}
<p>The "gorgeous" paragraph is richer than the control, and the judge did notice, but it guessed <code>beautiful</code>. The "plain" paragraph is indistinguishable from an unprompted one, and the judge said so with a probability of ${findRun("paragraph", "neutral", "plain", 1).presence.toFixed(2)}.</p>

<h2>The one exclusion</h2>
<p>One run out of 180 wrote its own condition word into the output. It is excluded from every accuracy figure, which is why the negative poem denominator is 29 and the pooled denominator is ${overall.n} rather than 180.</p>
${sampleBlock(leakRun)}
<p>The leak check is a literal substring test on the normalized output, applied before scoring. It is deliberately blunt: an output that names its own adjective would let the judge win by reading rather than by recognizing style.</p>

<h2>The code experiment, for contrast</h2>
<p>The earlier experiment used the same machinery on a React settings panel with the words <code>lovely</code>, <code>beautiful</code>, <code>elegant</code>, <code>polished</code>, and <code>refined</code>. It scored ${codeStats.k} of ${codeStats.n}, or ${pct(codeStats.acc)}, which is exactly chance (p = ${pfmt(codeStats.p)}).</p>
<p>That is consistent with the writing result rather than in tension with it. All five of those words are positive, and the positive family is the family with no headroom. The judge did detect that something was asked for, with a mean presence probability of ${(Object.entries(code.json.metrics.modifierPresentMean).filter(([k]) => k !== "control").reduce((a, [, v]) => a + v, 0) / 5).toFixed(2)} across the five words, but the control sat at ${code.json.metrics.modifierPresentMean.control.toFixed(2)} as well. Behavioral scoring shows the same compressed range: visual ornamentation moves by at most ${Math.max(...Object.keys(code.json.metrics.profiles).filter((k) => k !== "control").map((k) => Math.abs(code.json.metrics.profiles[k].visual_ornamentation.delta))).toFixed(1)} points on a 1 to 7 scale.</p>

<h3>The six conditions, side by side</h3>
<p>Every panel below is run 1 of its condition, bundled against React 19 and rendered in a headless browser at 1180 pixels wide from nothing but the generated <code>App.tsx</code> and <code>styles.css</code>. The label under each one is what the blind judge guessed.</p>

<div class="shots">
${CODE_WORDS.map((w) => panelCard(w, 1, "main")).join("\n")}
</div>

<p>They are obviously different panels. What they are not is different in a way that tracks the word. The control invented a product called Notionary, "refined" invented Notespace, and "lovely" and "elegant" both independently invented Papertrail. Sidebar or modal, green accent or violet, serif heading or sans, none of it lines up with the adjective. ${CODE_WORDS.filter((w) => codeRunFor(w, 1).correct).length} of these six were identified correctly, which is what ${pct(CHANCE)} looks like at this sample size.</p>
<p>Where the judge does show structure, it is in the pairs it confuses. Across all 30 runs it mixed up <code>control</code> and <code>polished</code> ${code.json.metrics.pairConfusions.find((p) => p.pair.includes("control") && p.pair.includes("polished")).count} times and <code>elegant</code> and <code>refined</code> ${code.json.metrics.pairConfusions.find((p) => p.pair.includes("elegant") && p.pair.includes("refined")).count} times, which is visible above: the first and fifth panels share a green accent, a left sidebar, and a footer action bar, while the fourth and sixth share a warm rust accent and a serif display face.</p>

<h3>The same condition, five times</h3>
<p>This is the clearest picture of why identification sits at chance. The top row is five runs of the control condition, with no adjective at all. The bottom row is five runs of <code>polished</code>. Nothing changed between the runs in a row except the model's own sampling.</p>

<div class="strip">
${[1, 2, 3, 4, 5].map((i) => panelCard("control", i, "strip")).join("\n")}
</div>
<div class="strip">
${[1, 2, 3, 4, 5].map((i) => panelCard("polished", i, "strip")).join("\n")}
</div>

<p>The variation inside each row is larger than any difference between the rows. Both rows mix a green palette with a cooler blue or violet one, and both mix a full-bleed sidebar layout with a floating card. Control run 4 goes blue and polished runs 2 and 4 go violet, for no reason available in the prompt. The judge read it the same way: it called control run 4 <code>polished</code>, and it called three of the five <code>polished</code> runs <code>control</code>. The two conditions swap.</p>

<div class="panel warn">
<p>The correct reading of the code experiment is not "aesthetic words do nothing to code". It is "this benchmark cannot separate five positive aesthetic words on this task at five runs each". Testing it against a negative or a genuinely contrastive word list is the obvious next step.</p>
</div>
<p class="meta">Rendering note: 2 of the 30 runs wrote <code>styles.css</code> but never imported it from the component. Both are control runs. The render page links every generated stylesheet directly, so no run is shown unstyled over a detail the task did not ask for. Nothing else about the generated files was changed.</p>

<h2>Isolation and integrity</h2>
<p>The whole point of the design is that no two model calls can share state, so a result cannot be an artifact of a warm thread. The exports carry the evidence.</p>
<dl class="kv">
  <dt>Model calls attempted</dt><dd>${attempts.length}</dd>
  <dt>Successful calls</dt><dd>${okAttempts.length} (${kinds.generate} generate, ${kinds.classify} classify, ${kinds.profile} profile)</dd>
  <dt>Distinct OS process IDs</dt><dd>${distinct(okAttempts, "process_id")} across ${okAttempts.length} successful calls</dd>
  <dt>Distinct model thread IDs</dt><dd>${distinct(okAttempts, "thread_id")}</dd>
  <dt>Distinct workspace fingerprints</dt><dd>${distinct(okAttempts, "isolation_id")}</dd>
  <dt>Distinct values including failures</dt><dd>${distinct(attempts, "process_id")} processes and ${distinct(attempts, "isolation_id")} workspaces across all ${attempts.length} attempts, so retries were never reissued into a used environment</dd>
  <dt>Failed attempts</dt><dd>${failedAttempts.length} (${badProbabilityFailures} judge probability sets that did not sum to 1, ${restartFailures} generations interrupted by a process restart)</dd>
  <dt>Median call duration</dt><dd>${quantile(0.5).toFixed(1)}s overall; generate ${medianKind.generate.toFixed(1)}s, classify ${medianKind.classify.toFixed(1)}s, profile ${medianKind.profile.toFixed(1)}s</dd>
  <dt>p90 and max call duration</dt><dd>${quantile(0.9).toFixed(1)}s and ${quantile(1).toFixed(1)}s</dd>
  <dt>Total model time</dt><dd>${totalComputeMin.toFixed(0)} minutes across all seven experiments; the six writing experiments account for ${writingComputeMin.toFixed(0)} minutes of model time and ran concurrently in ${writingWallMin.toFixed(0)} minutes of wall clock</dd>
</dl>
<p>Each call also received a temporary <code>CODEX_HOME</code> containing only a mode 0600 copy of the credentials, workspace-write sandboxing, no approvals, and no extra readable directories. Judge inputs carry the adjective-free task, one canonicalized source bundle with path-neutral filenames, and either the shuffled candidate list or the fixed rubric. They do not carry condition identifiers, the rendered generation prompt, run indexes, generator thread IDs, or the true label.</p>
<p>The ${failedAttempts.length} failures are worth naming plainly. ${badProbabilityFailures} were judge responses whose probabilities did not sum to 1; the parser rejected them rather than renormalizing silently. ${restartFailures} were generations interrupted by a process restart. Each was retried in a completely fresh environment, which is why the distinct-workspace count matches the attempt count rather than the run count.</p>

<h2>Limits</h2>
<ul>
  <li><strong>Five runs per condition.</strong> One classification is worth 20 percentage points of per-word recall. The family-level and pooled numbers are the ones to trust; individual per-word recalls are noisy.</li>
  <li><strong>One judge, one model.</strong> Generator and judge are the same model at the same reasoning level. The judge's collapse onto <code>ugly</code> and <code>beautiful</code> may be a property of that judge rather than of the text. A second judge from a different family would separate those explanations.</li>
  <li><strong>Behavioral, not internal.</strong> This measures whether an instruction leaves a recognizable trace in the output. It says nothing about what the model represents internally, and nothing about whether it has a definition of any of these words.</li>
  <li><strong>Two tasks.</strong> A twelve-line autumn poem and a bakery paragraph. Both are warm, domestic, and pleasant by default, which is exactly the condition that creates the positive-side ceiling. A task with a cold or neutral default would test the ceiling explanation directly.</li>
  <li><strong>Presence at a 0.5 threshold.</strong> The presence numbers use a fixed cut on a continuous probability. The means in the same table do not depend on that choice, and they tell the same story.</li>
  <li><strong>Shared provider state.</strong> Process, thread, and workspace isolation is verified. Account, model version, and provider-side state are shared across every run and cannot be inspected from here.</li>
</ul>

<h2>What would change the conclusion</h2>
<ol>
  <li>Run the same six conditions at 20 to 50 runs each. That is the threshold at which per-word comparison becomes meaningful, rather than family-level comparison.</li>
  <li>Mix families inside one candidate list. A six-way choice among <code>beautiful</code>, <code>ordinary</code>, <code>ugly</code>, and control tests whether the judge can place a text on the valence axis when the axis is the thing being asked about.</li>
  <li>Run a task whose default is not already pleasant, such as an incident postmortem or an error message. If the ceiling explanation is right, positive adjectives should become detectable there.</li>
  <li>Swap the judge model. If <code>ugly</code> stops being an attractor, the collapse is a judge artifact.</li>
</ol>

<h2>Data</h2>
<p>${link(REPORT_URL, "The full 210-run report")} carries every run, the complete probability distributions, per-experiment confusion matrices, the isolation ledger, and screenshots of the six generated React panels. The JSON exports below are the raw source for every number on this page.</p>
<ul class="dl">
${DL.map(([label, href]) => `<li>${link(href, label)}</li>`).join("\n")}
</ul>
<p class="meta">Download links expire 2026-09-04 at approximately 08:22 UTC. The report link does not expire.</p>

<h2>Appendix A: every writing run</h2>
<p>All 180 classified writing runs. P(true label) is the probability the blind judge assigned to the condition that was actually used. The excluded row is dimmed.</p>
${runAppendix()}

<h2>Appendix B: the full corpus</h2>
<p>Every generated poem and paragraph, grouped by experiment.</p>
${allTexts()}

<footer>
<p>Words of Meaning is a local benchmark. Generator and judge are <span class="mono">gpt-5.6-terra</span> at low reasoning through Codex SDK 0.151.0. Seeds, prompts, and per-attempt isolation records are in the JSON exports. Validation for this run: 14 tests, typecheck, lint, and a production build all pass.</p>
</footer>

</main>
</body>
</html>
`;

const outDir = join(root, ".agent", "artifacts");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, "words-of-meaning-findings.html");
writeFileSync(out, html);
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
