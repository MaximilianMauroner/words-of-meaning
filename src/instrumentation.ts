export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { recoverAndStartScheduler } = await import("@/server/jobs/scheduler");
    recoverAndStartScheduler();
  }
}
