import { CONTROL_LABEL } from "@/shared/domain";

export type MetricRun = {
  normalized_word: string;
  word: string | null;
  is_control: number | boolean;
  status: string;
  word_leak: number | boolean;
  prediction: string | null;
  probabilities_json: string | null;
  modifier_present_probability: number | null;
  profile_scores_json: string | null;
};

export type ExperimentMetrics = ReturnType<typeof computeMetrics>;

function mean(values: number[]): number | null {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function binomialUpperTail(successes: number, trials: number, probability: number): number | null {
  if (trials === 0) return null;
  if (probability <= 0) return successes === 0 ? 1 : 0;
  if (probability >= 1) return 1;
  const logFactorials = [0];
  for (let value = 1; value <= trials; value += 1) {
    logFactorials[value] = logFactorials[value - 1] + Math.log(value);
  }
  const terms: number[] = [];
  for (let value = successes; value <= trials; value += 1) {
    terms.push(
      logFactorials[trials] - logFactorials[value] - logFactorials[trials - value]
      + value * Math.log(probability) + (trials - value) * Math.log1p(-probability),
    );
  }
  const maximum = Math.max(...terms);
  return Math.min(1, Math.exp(maximum) * terms.reduce((sum, term) => sum + Math.exp(term - maximum), 0));
}

function wilsonInterval(successes: number, trials: number): [number, number] | null {
  if (trials === 0) return null;
  const z = 1.959963984540054;
  const observed = successes / trials;
  const denominator = 1 + z ** 2 / trials;
  const center = (observed + z ** 2 / (2 * trials)) / denominator;
  const halfWidth = z * Math.sqrt(observed * (1 - observed) / trials + z ** 2 / (4 * trials ** 2)) / denominator;
  return [Math.max(0, center - halfWidth), Math.min(1, center + halfWidth)];
}

export function computeMetrics(runs: MetricRun[], dimensionKeys: string[]) {
  const labels = [...new Set(runs.map((run) => run.is_control ? CONTROL_LABEL : run.word!))];
  const eligible = runs.filter((run) => run.status === "succeeded" && !run.word_leak && run.prediction && run.probabilities_json);
  const confusion = Object.fromEntries(labels.map((actual) => [
    actual,
    Object.fromEntries(labels.map((predicted) => [predicted, 0])),
  ])) as Record<string, Record<string, number>>;
  let correct = 0;
  let logLossTotal = 0;
  const recalls = Object.fromEntries(labels.map((label) => [label, { correct: 0, total: 0, rate: null as number | null } ]));
  const modifierByLabel = Object.fromEntries(labels.map((label) => [label, [] as number[]]));

  for (const run of eligible) {
    const actual = run.is_control ? CONTROL_LABEL : run.word!;
    const predicted = run.prediction!;
    if (confusion[actual]?.[predicted] !== undefined) confusion[actual][predicted] += 1;
    recalls[actual].total += 1;
    if (actual === predicted) {
      correct += 1;
      recalls[actual].correct += 1;
    }
    const probabilities = JSON.parse(run.probabilities_json!) as Record<string, number>;
    logLossTotal += -Math.log(Math.max(1e-12, probabilities[actual] ?? 0));
    if (run.modifier_present_probability !== null) modifierByLabel[actual].push(run.modifier_present_probability / 1_000_000);
  }
  for (const label of labels) {
    recalls[label].rate = recalls[label].total ? recalls[label].correct / recalls[label].total : null;
  }

  const pairConfusions: { pair: [string, string]; count: number }[] = [];
  for (let left = 0; left < labels.length; left += 1) {
    for (let right = left + 1; right < labels.length; right += 1) {
      const a = labels[left];
      const b = labels[right];
      pairConfusions.push({ pair: [a, b], count: confusion[a][b] + confusion[b][a] });
    }
  }
  pairConfusions.sort((a, b) => b.count - a.count);

  const profileRaw: Record<string, Record<string, number[]>> = Object.fromEntries(labels.map((label) => [
    label,
    Object.fromEntries(dimensionKeys.map((key) => [key, []])),
  ]));
  for (const run of runs.filter((candidate) => candidate.status === "succeeded" && !candidate.word_leak && candidate.profile_scores_json)) {
    const label = run.is_control ? CONTROL_LABEL : run.word!;
    const scores = JSON.parse(run.profile_scores_json!) as Record<string, number | null>;
    for (const key of dimensionKeys) if (scores[key] !== null && scores[key] !== undefined) profileRaw[label][key].push(scores[key]!);
  }
  const controlMeans = Object.fromEntries(dimensionKeys.map((key) => [key, mean(profileRaw[CONTROL_LABEL]?.[key] ?? [])]));
  const profiles = Object.fromEntries(labels.map((label) => [label, Object.fromEntries(dimensionKeys.map((key) => {
    const values = profileRaw[label][key];
    const rawMean = mean(values);
    const controlMean = controlMeans[key];
    const standardDeviation = rawMean === null || values.length === 0 ? null : Math.sqrt(
      values.reduce((total, value) => total + (value - rawMean) ** 2, 0) / values.length,
    );
    return [key, {
      mean: rawMean,
      delta: rawMean === null || controlMean === null ? null : rawMean - controlMean,
      standardDeviation,
      count: values.length,
      values,
    }];
  }))]));

  const chance = labels.length ? 1 / labels.length : null;
  const chancePValue = chance === null ? null : binomialUpperTail(correct, eligible.length, chance);
  return {
    labels,
    chance,
    eligibleCount: eligible.length,
    excludedCount: runs.length - eligible.length,
    accuracy: eligible.length ? correct / eligible.length : null,
    correctCount: correct,
    significance: {
      nullHypothesis: "random_guessing",
      alternative: "accuracy_above_chance",
      alpha: 0.05,
      oneSidedPValue: chancePValue,
      significant: chancePValue !== null && chancePValue < 0.05,
      accuracyWilson95: wilsonInterval(correct, eligible.length),
    },
    logLoss: eligible.length ? logLossTotal / eligible.length : null,
    controlRecall: recalls[CONTROL_LABEL]?.rate ?? null,
    recalls,
    confusion,
    pairConfusions,
    modifierPresentMean: Object.fromEntries(labels.map((label) => [label, mean(modifierByLabel[label])])),
    profiles,
  };
}
