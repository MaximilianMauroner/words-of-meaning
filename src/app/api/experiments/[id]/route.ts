import { NextResponse } from "next/server";
import { defaultDimensions } from "@/shared/domain";
import { getExperiment } from "@/server/experiments/service";
import { computeMetrics, type MetricRun } from "@/server/metrics/compute";
import { startScheduler } from "@/server/jobs/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  startScheduler();
  const { id } = await context.params;
  const result = getExperiment(id);
  if (!result) return NextResponse.json({ error: "Experiment not found" }, { status: 404 });
  const dimensions = JSON.parse(String(result.experiment.dimensions_json || "[]")) as typeof defaultDimensions;
  const metrics = computeMetrics(result.runs as MetricRun[], dimensions.map((dimension) => dimension.key));
  return NextResponse.json({ ...result, metrics });
}
