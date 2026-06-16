import { NextRequest } from "next/server";
import { ConfigScope } from "@/lib/fr-config";
import { runSync } from "@/lib/operations/run-sync";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { environment, scopes } = body as { environment: string; scopes?: ConfigScope[] };
  if (!environment) return new Response("Missing environment", { status: 400 });

  const stream = new ReadableStream<string>({
    async start(controller) {
      const emit = (evt: object) => controller.enqueue(JSON.stringify(evt) + "\n");
      const result = await runSync({ environment, scopes, trigger: "manual" }, emit);
      emit({ type: "exit", code: result.status === "success" ? 0 : 1, ts: Date.now() });
      controller.close();
    },
  });

  return new Response(stream as unknown as ReadableStream<Uint8Array>, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
