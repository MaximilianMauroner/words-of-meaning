import { getExperiment } from "@/server/experiments/service";
import { computeMetrics, type MetricRun } from "@/server/metrics/compute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = getExperiment(id);
  if (!result) return Response.json({ error: "Experiment not found" }, { status: 404 });
  const dimensions = JSON.parse(String(result.experiment.dimensions_json || "[]")) as { key: string }[];
  const safeAttempts = (result.attempts as Record<string, unknown>[]).map((attempt) => {
    const { workspace_fingerprint: isolationId, ...copy } = attempt;
    return { ...copy, isolation_id: isolationId };
  });
  const body = JSON.stringify({
    version: 2,
    exportedAt: new Date().toISOString(),
    experiment: result.experiment,
    conditions: result.conditions,
    tasks: result.tasks,
    runs: result.runs,
    attempts: safeAttempts,
    metrics: computeMetrics(result.runs as MetricRun[], dimensions.map((dimension) => dimension.key)),
  }, null, 2);
  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="words-of-meaning-${id}.json"`,
    },
  });
}
