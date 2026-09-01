"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

type ResultData = {
  experiment: Record<string, string | number | boolean | null>;
  conditions: Array<Record<string, string | number | boolean | null>>;
  runs: Array<Record<string, string | number | boolean | null>>;
  jobs: Array<{ kind: string; state: string; count: number }>;
  attempts: Array<Record<string, string | number | null>>;
  metrics: {
    labels: string[];
    chance: number | null;
    eligibleCount: number;
    excludedCount: number;
    accuracy: number | null;
    correctCount: number;
    significance: {
      nullHypothesis: string;
      alternative: string;
      alpha: number;
      oneSidedPValue: number | null;
      significant: boolean;
      accuracyWilson95: [number, number] | null;
    };
    logLoss: number | null;
    controlRecall: number | null;
    recalls: Record<string, { correct: number; total: number; rate: number | null }>;
    confusion: Record<string, Record<string, number>>;
    pairConfusions: Array<{ pair: [string, string]; count: number }>;
    profiles: Record<string, Record<string, { mean: number | null; delta: number | null; standardDeviation: number | null; count: number; values: number[] }>>;
  };
};

export function ExperimentResults({ id }: { id: string }) {
  const [data, setData] = useState<ResultData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/experiments/${id}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load experiment");
      setData(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load experiment");
    }
  }, [id]);

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 3_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [refresh]);

  async function cancel() {
    await fetch(`/api/experiments/${id}/cancel`, { method: "POST" });
    await refresh();
  }

  if (error) return <main className="page-shell"><p className="error-box">{error}</p></main>;
  if (!data) return <main className="page-shell"><p className="loading">Loading experiment…</p></main>;

  const status = String(data.experiment.status);
  const dimensions = JSON.parse(String(data.experiment.dimensions_json)) as Array<{ key: string; label: string }>;
  const active = ["queued", "running"].includes(status);
  const jobCounts = new Map(data.jobs.map((row) => [`${row.kind}:${row.state}`, Number(row.count)]));
  const generationTotal = data.runs.length;
  const generationDone = data.runs.filter((run) => run.status === "succeeded").length;
  const classificationDone = data.runs.filter((run) => run.prediction).length;
  const profileDone = data.runs.filter((run) => run.profile_scores_json).length;

  return (
    <main className="page-shell results-page">
      <Link className="back-link" href="/">← All experiments</Link>
      <section className="result-header">
        <div>
          <p className="eyebrow">Experiment</p>
          <h1>{String(data.experiment.name)}</h1>
          <p>{String(data.experiment.neutral_task)}</p>
        </div>
        <div className="header-actions">
          <span className={`status ${status}`}>{status.replaceAll("_", " ")}</span>
          <a className="secondary-button" href={`/api/experiments/${id}/export`}>Export JSON</a>
          {active && <button className="danger-button" onClick={cancel}>Cancel</button>}
        </div>
      </section>

      {active && (
        <section className="panel">
          <div className="section-heading"><div><p className="eyebrow">Live run</p><h2>Progress</h2></div><span>{data.attempts.length} isolated processes recorded</span></div>
          <div className="progress-grid">
            <Progress label="Generate source" value={generationDone} total={generationTotal} />
            <Progress label="Blind classification" value={classificationDone} total={generationTotal} />
            <Progress label="Behavioral profiles" value={profileDone} total={generationTotal} />
          </div>
          {(jobCounts.get("generate:failed_final") || jobCounts.get("classify:failed_final") || jobCounts.get("profile:failed_final")) && <p className="error-box">Some jobs exhausted their retries. Details remain in the run table.</p>}
        </section>
      )}

      <section className="metric-grid">
        <Metric label="Identification accuracy" value={formatPercent(data.metrics.accuracy)} note={`${data.metrics.correctCount}/${data.metrics.eligibleCount} eligible`} />
        <Metric label="Chance" value={formatPercent(data.metrics.chance)} note={`${data.metrics.labels.length} candidates`} />
        <Metric label="Chance p-value" value={formatNumber(data.metrics.significance.oneSidedPValue)} note={data.metrics.significance.significant ? "Above chance at α=0.05" : "Not above chance at α=0.05"} />
        <Metric label="95% accuracy interval" value={formatInterval(data.metrics.significance.accuracyWilson95)} note="Wilson score interval" />
        <Metric label="Log loss" value={formatNumber(data.metrics.logLoss)} note="Lower is better" />
        <Metric label="Control recall" value={formatPercent(data.metrics.controlRecall)} note={`${data.metrics.excludedCount} excluded`} />
      </section>

      <section className="panel">
        <div className="section-heading"><div><p className="eyebrow">Where labels collapse</p><h2>Confusion matrix</h2></div><span>Raw counts</span></div>
        <div className="table-scroll">
          <table className="matrix">
            <thead><tr><th>Actual ↓ / predicted →</th>{data.metrics.labels.map((label) => <th key={label}>{label}</th>)}</tr></thead>
            <tbody>{data.metrics.labels.map((actual) => (
              <tr key={actual}><th>{actual}</th>{data.metrics.labels.map((predicted) => {
                const value = data.metrics.confusion[actual]?.[predicted] ?? 0;
                return <td className={actual === predicted ? "diagonal" : ""} key={predicted}><span style={{ opacity: 0.35 + Math.min(0.65, value / 5) }}>{value}</span></td>;
              })}</tr>
            ))}</tbody>
          </table>
        </div>
        <div className="rank-list">
          {data.metrics.labels.map((label) => <div key={label}><strong>{label}</strong><span>{formatPercent(data.metrics.recalls[label]?.rate)} · {data.metrics.recalls[label]?.correct}/{data.metrics.recalls[label]?.total}</span></div>)}
        </div>
      </section>

      <section className="panel">
        <div className="section-heading"><div><p className="eyebrow">What changed</p><h2>Behavioral profile vs. control</h2></div><span>Mean score delta</span></div>
        <div className="table-scroll">
          <table className="profile-table">
            <thead><tr><th>Dimension</th>{data.metrics.labels.filter((label) => label !== "control").map((label) => <th key={label}>{label}</th>)}</tr></thead>
            <tbody>{dimensions.map((dimension) => (
              <tr key={dimension.key}><th>{dimension.label}</th>{data.metrics.labels.filter((label) => label !== "control").map((label) => {
                const profile = data.metrics.profiles[label]?.[dimension.key];
                return <td key={label} title={profile ? `n=${profile.count}, raw mean ${formatNumber(profile.mean)}` : "No score"}>{formatDelta(profile?.delta ?? null)}</td>;
              })}</tr>
            ))}</tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading"><div><p className="eyebrow">Audit trail</p><h2>Individual generations</h2></div><span>{data.runs.length} runs</span></div>
        <div className="run-list">
          {data.runs.map((run) => <RunDetail key={String(run.id)} run={run} attempts={data.attempts.filter((attempt) => attempt.target_id === run.id || attempt.target_id === run.judgment_id)} />)}
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <section className="metric-card"><span>{label}</span><strong>{value}</strong><small>{note}</small></section>;
}

function Progress({ label, value, total }: { label: string; value: number; total: number }) {
  const percentage = total ? Math.round(value / total * 100) : 0;
  return <div className="progress-item"><div><strong>{label}</strong><span>{value}/{total}</span></div><div className="progress-track"><i style={{ width: `${percentage}%` }} /></div></div>;
}

function RunDetail({ run, attempts }: { run: Record<string, string | number | boolean | null>; attempts: Array<Record<string, string | number | null>> }) {
  const label = run.is_control ? "control" : String(run.word);
  const probabilities = run.probabilities_json ? JSON.parse(String(run.probabilities_json)) as Record<string, number> : null;
  const profiles = run.profile_scores_json ? JSON.parse(String(run.profile_scores_json)) as Record<string, number | null> : null;
  return (
    <details>
      <summary>
        <span><strong>{label}</strong> · run {String(run.run_index)}</span>
        <span>{run.word_leak ? "word leak · " : ""}{run.prediction ? `predicted ${run.prediction}` : String(run.status)}</span>
      </summary>
      <div className="run-detail-grid">
        <div>
          <h3>Judge probabilities</h3>
          {probabilities ? Object.entries(probabilities).sort((a, b) => b[1] - a[1]).map(([candidate, probability]) => (
            <div className="probability-row" key={candidate}><span>{candidate}</span><i><b style={{ width: `${probability * 100}%` }} /></i><strong>{formatPercent(probability)}</strong></div>
          )) : <p>No classification yet.</p>}
          <h3>Isolation evidence</h3>
          <ul className="evidence-list">{attempts.map((attempt) => <li key={String(attempt.id)}><code>{String(attempt.kind)}</code> · PID {String(attempt.process_id)} · thread <code>{String(attempt.thread_id || "pending").slice(0, 12)}</code></li>)}</ul>
          <h3>Behavioral scores</h3>
          {profiles ? <dl className="score-list">{Object.entries(profiles).map(([key, value]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{value ?? "n/a"}</dd></div>)}</dl> : <p>No profile yet.</p>}
        </div>
        <div>
          <h3>Canonical source bundle</h3>
          {run.artifact_bundle ? <pre className="source-viewer">{String(run.artifact_bundle)}</pre> : <p>{String(run.error || "No artifact yet.")}</p>}
        </div>
      </div>
    </details>
  );
}

function formatPercent(value: number | null) { return value === null ? "n/a" : `${Math.round(value * 1000) / 10}%`; }
function formatNumber(value: number | null) { return value === null ? "n/a" : String(Math.round(value * 100) / 100); }
function formatInterval(value: [number, number] | null) { return value === null ? "n/a" : `${formatPercent(value[0])} to ${formatPercent(value[1])}`; }
function formatDelta(value: number | null) { return value === null ? "n/a" : `${value > 0 ? "+" : ""}${Math.round(value * 100) / 100}`; }
