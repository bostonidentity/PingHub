/** Next.js calls register() once per server process at startup. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startScheduler } = await import("@/lib/scheduler/engine");
  startScheduler();
}
