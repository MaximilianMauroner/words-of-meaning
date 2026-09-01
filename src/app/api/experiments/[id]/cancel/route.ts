import { NextResponse } from "next/server";
import { abortExperimentJobs } from "@/server/jobs/scheduler";
import { cancelExperiment } from "@/server/experiments/service";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const canceled = cancelExperiment(id);
  if (!canceled) return NextResponse.json({ error: "Experiment not found" }, { status: 404 });
  abortExperimentJobs(id);
  return NextResponse.json({ canceled: true });
}
