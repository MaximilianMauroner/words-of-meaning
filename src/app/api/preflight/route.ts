import { NextResponse } from "next/server";
import { isolationPreflight } from "@/server/runner/isolation";
import { recoverAndStartScheduler } from "@/server/jobs/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  recoverAndStartScheduler();
  return NextResponse.json(isolationPreflight());
}
