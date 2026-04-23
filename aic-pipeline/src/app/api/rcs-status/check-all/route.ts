import { getEnvironments } from "@/lib/fr-config";
import { pLimit } from "@/lib/rcs/p-limit";

const ENV_CONCURRENCY = 2;

export async function POST(req: Request) {
  const origin = new URL(req.url).origin;
  const envs = getEnvironments();

  const stream = new ReadableStream<string>({
    async start(controller) {
      const emit = (type: string, env: string, data: string) =>
        controller.enqueue(JSON.stringify({ type, env, data, ts: Date.now() }) + "\n");
      const limit = pLimit(ENV_CONCURRENCY);

      await Promise.all(
        envs.map((e) =>
          limit(async () => {
            emit("env-start", e.name, `Starting ${e.name}`);
            try {
              const res = await fetch(`${origin}/api/rcs-status/check`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ env: e.name }),
              });
              if (!res.ok || !res.body) {
                emit("env-error", e.name, `HTTP ${res.status}`);
                return;
              }
              const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
              let buf = "";
              while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += value;
                let idx: number;
                while ((idx = buf.indexOf("\n")) >= 0) {
                  const line = buf.slice(0, idx);
                  buf = buf.slice(idx + 1);
                  if (!line) continue;
                  try {
                    const evt = JSON.parse(line) as { type: string; data?: string };
                    emit(evt.type, e.name, typeof evt.data === "string" ? evt.data : "");
                  } catch {
                    // ignore malformed line
                  }
                }
              }
              emit("env-end", e.name, "done");
            } catch (err) {
              emit("env-error", e.name, err instanceof Error ? err.message : String(err));
            }
          }),
        ),
      );

      controller.enqueue(JSON.stringify({ type: "exit", code: 0, ts: Date.now() }) + "\n");
      controller.close();
    },
  });

  return new Response(stream as unknown as ReadableStream<Uint8Array>, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
