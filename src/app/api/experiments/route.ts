import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { createExperimentSchema } from "@/shared/domain";
import { createExperiment, listExperiments } from "@/server/experiments/service";
import { startScheduler } from "@/server/jobs/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  startScheduler();
  return NextResponse.json({ experiments: listExperiments() });
}

export async function POST(request: Request) {
  try {
    const input = createExperimentSchema.parse(await request.json());
    const id = createExperiment(input);
    startScheduler();
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) return NextResponse.json({ error: "Invalid experiment", issues: error.issues }, { status: 400 });
    const message = error instanceof Error ? error.message : "Could not create experiment";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
