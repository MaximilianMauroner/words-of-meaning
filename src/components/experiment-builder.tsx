"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { defaultDimensions, FIXED_BENCHMARK_MODEL, FIXED_BENCHMARK_REASONING, recommendedDesignTasks } from "@/shared/domain";

type Preflight = {
  ok: boolean;
  authFilePresent: boolean;
  sdkVersion: string;
  nodeVersion: string;
  controls: Record<string, boolean | string>;
};

type ExperimentSummary = {
  id: string;
  name: string;
  status: string;
  created_at: number;
  generation_count: number;
  generations_succeeded: number;
  classifications_succeeded: number;
  profiles_succeeded: number;
};

const initialPrompt = recommendedDesignTasks[0].prompt;

export function ExperimentBuilder() {
  const router = useRouter();
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [name, setName] = useState("Static design adjectives");
  const basePrompt = initialPrompt;
  const [wordsText, setWordsText] = useState("lovely\nbeautiful\nelegant\npolished\nrefined");
  const [runs, setRuns] = useState(5);
  const generatorModel = FIXED_BENCHMARK_MODEL;
  const judgeModel = FIXED_BENCHMARK_MODEL;
  const generatorReasoning = FIXED_BENCHMARK_REASONING;
  const judgeReasoning = FIXED_BENCHMARK_REASONING;
  const [maxConcurrency, setMaxConcurrency] = useState(1);
  const [selectedDimensions, setSelectedDimensions] = useState<string[]>(defaultDimensions.map((dimension) => dimension.key));
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>(recommendedDesignTasks.map((task) => task.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const words = useMemo(() => wordsText.split("\n").map((word) => word.trim()).filter(Boolean), [wordsText]);
  const selectedTasks = useMemo(() => recommendedDesignTasks.filter((task) => selectedTaskIds.includes(task.id)), [selectedTaskIds]);
  const conditions = words.length + 1;
  const outputs = conditions * runs * selectedTasks.length;
  const calls = outputs * 3;

  async function refresh() {
    const [preflightResponse, experimentResponse] = await Promise.all([
      fetch("/api/preflight", { cache: "no-store" }),
      fetch("/api/experiments", { cache: "no-store" }),
    ]);
    setPreflight(await preflightResponse.json());
    const data = await experimentResponse.json();
    setExperiments(data.experiments ?? []);
  }

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), 5_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/experiments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          basePrompt: selectedTasks[0]?.prompt || basePrompt,
          words,
          runsPerCondition: runs,
          generatorModel,
          judgeModel,
          generatorReasoning,
          judgeReasoning,
          maxConcurrency,
          dimensions: defaultDimensions.filter((dimension) => selectedDimensions.includes(dimension.key)),
          tasks: selectedTasks,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.issues?.[0]?.message || data.error || "Could not create experiment");
      router.push(`/experiments/${data.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create experiment");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="preflight-card" aria-live="polite">
        <div>
          <p className="eyebrow">Isolation preflight</p>
          <h2>{preflight?.ok ? "Ready for isolated runs" : "Codex login needed"}</h2>
          <p>
            {preflight?.ok
              ? `SDK ${preflight.sdkVersion}. Every call gets a fresh process, thread, workspace, and Codex home.`
              : "Run `codex login` on this machine. The benchmark fails closed unless it can copy file-backed auth into each temporary Codex home."}
          </p>
        </div>
        <span className={preflight?.ok ? "status ready" : "status blocked"}>{preflight?.ok ? "Passed" : "Blocked"}</span>
      </section>

      <div className="two-column">
        <form className="panel experiment-form" onSubmit={submit}>
          <div className="section-heading">
            <div><p className="eyebrow">New experiment</p><h2>Configure the blind test</h2></div>
            <span className="control-chip">+ control</span>
          </div>

          <fieldset className="dimension-picker">
            <legend>Behavioral dimensions</legend>
            <div>{defaultDimensions.map((dimension) => (
              <label key={dimension.key}>
                <input
                  type="checkbox"
                  checked={selectedDimensions.includes(dimension.key)}
                  onChange={(event) => setSelectedDimensions((current) => event.target.checked
                    ? [...current, dimension.key]
                    : current.filter((key) => key !== dimension.key))}
                />
                <span>{dimension.label}</span>
              </label>
            ))}</div>
            <small>Keep at least one. Scores use fixed 1, 4, and 7 anchors so experiments remain auditable.</small>
          </fieldset>

          <label>
            Experiment name
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <fieldset className="task-picker">
            <legend>Static HTML/CSS designs</legend>
            <div>{recommendedDesignTasks.map((task) => (
              <label key={task.id}>
                <input
                  type="checkbox"
                  checked={selectedTaskIds.includes(task.id)}
                  onChange={(event) => setSelectedTaskIds((current) => event.target.checked
                    ? [...current, task.id]
                    : current.filter((id) => id !== task.id))}
                />
                <span><strong>{task.name}</strong><small>{task.prompt}</small></span>
              </label>
            ))}</div>
            <small>Each selected design is a separate task block. Every output must contain only <code>index.html</code> and <code>styles.css</code>; React and JavaScript are not allowed.</small>
          </fieldset>
          <label>
            Candidate words, one per line
            <textarea className="word-list" rows={7} value={wordsText} onChange={(event) => setWordsText(event.target.value)} required />
          </label>

          <div className="field-grid">
            <label>
              Runs per condition
              <input type="number" min="1" max="100" value={runs} onChange={(event) => setRuns(Number(event.target.value))} />
            </label>
            <label>
              Generator model
              <input value={generatorModel} readOnly aria-readonly="true" />
              <small>Fixed for every generation.</small>
            </label>
            <label>
              Generator reasoning
              <input value={generatorReasoning} readOnly aria-readonly="true" />
              <small>Fixed at maximum reasoning.</small>
            </label>
            <label>
              Judge model
              <input value={judgeModel} readOnly aria-readonly="true" />
              <small>Fixed for every judge call.</small>
            </label>
            <label>
              Judge reasoning
              <input value={judgeReasoning} readOnly aria-readonly="true" />
              <small>Fixed at maximum reasoning.</small>
            </label>
            <label>
              Maximum concurrency
              <input type="number" min="1" max="8" value={maxConcurrency} onChange={(event) => setMaxConcurrency(Number(event.target.value))} />
            </label>
          </div>

          <div className="call-preview">
            <span><strong>{selectedTasks.length}</strong> designs</span>
            <span><strong>{conditions}</strong> conditions/design</span>
            <span><strong>{outputs}</strong> outputs</span>
            <span><strong>{calls}</strong> Codex calls</span>
          </div>
          <p className="fine-print">One output needs one generation, one blind classification, and one profile evaluation. Account limits still apply.</p>
          {error && <p className="error-box">{error}</p>}
          <button className="primary-button" disabled={busy || !preflight?.ok || selectedDimensions.length === 0 || selectedTasks.length === 0}>{busy ? "Starting…" : "Start experiment"}</button>
        </form>

        <section className="panel experiment-list">
          <div className="section-heading"><div><p className="eyebrow">History</p><h2>Experiments</h2></div></div>
          {experiments.length === 0 && <p className="empty-state">No experiments yet.</p>}
          {experiments.map((experiment) => {
            const total = Number(experiment.generation_count) * 3;
            const done = Number(experiment.generations_succeeded) + Number(experiment.classifications_succeeded) + Number(experiment.profiles_succeeded);
            return (
              <a className="experiment-row" href={`/experiments/${experiment.id}`} key={experiment.id}>
                <div><strong>{experiment.name}</strong><small>{new Date(experiment.created_at).toLocaleString()}</small></div>
                <div className="row-progress"><span>{done}/{total}</span><span className={`status ${experiment.status}`}>{humanStatus(experiment.status)}</span></div>
              </a>
            );
          })}
        </section>
      </div>
    </>
  );
}

function humanStatus(status: string) {
  return status.replaceAll("_", " ");
}
