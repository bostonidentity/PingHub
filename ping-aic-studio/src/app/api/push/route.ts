import { NextRequest } from "next/server";
import { spawnFrConfig, ConfigScope } from "@/lib/fr-config";
import { ScopeSelection } from "@/lib/fr-config-types";
import { scopeLabel as getScopeLabel } from "@/lib/git";
import { appendOpLog } from "@/lib/op-history";
import { spawnFrodo, FRODO_SCOPES } from "@/lib/frodo";
import { runIgaApi, IGA_API_SCOPES } from "@/lib/iga-api";

function mergeStreams(streams: ReadableStream<string>[]): ReadableStream<string> {
  if (streams.length === 1) return streams[0];
  return new ReadableStream<string>({
    async start(controller) {
      let lastCode = 0;
      for (const s of streams) {
        const reader = s.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of value.split("\n")) {
            if (!line.trim()) continue;
            try {
              const p = JSON.parse(line) as { type: string; code?: number };
              if (p.type === "exit") { lastCode = Math.max(lastCode, p.code ?? 0); continue; }
            } catch { /* pass through */ }
            controller.enqueue(line + "\n");
          }
        }
      }
      controller.enqueue(JSON.stringify({ type: "exit", code: lastCode, ts: Date.now() }) + "\n");
      controller.close();
    },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { environment, scopes, scopeSelections } = body as {
    environment: string;
    scopes?: ConfigScope[];
    scopeSelections?: ScopeSelection[];
  };

  if (!environment) {
    return new Response("Missing environment", { status: 400 });
  }

  // Partition scopes by command type
  const allScopes: string[] = scopeSelections
    ? scopeSelections.map((s) => s.scope)
    : scopes ?? [];

  const frodoScopes = allScopes.filter((s) => FRODO_SCOPES.includes(s));
  const igaScopes   = allScopes.filter((s) => IGA_API_SCOPES.includes(s));
  const frScopeSelections = scopeSelections
    ? scopeSelections.filter((s) => !FRODO_SCOPES.includes(s.scope) && !IGA_API_SCOPES.includes(s.scope))
    : undefined;
  const frScopes = scopes
    ? scopes.filter((s) => !FRODO_SCOPES.includes(s) && !IGA_API_SCOPES.includes(s)) as ConfigScope[]
    : undefined;

  const streams: ReadableStream<string>[] = [];
  if (frScopeSelections?.length || frScopes?.length) {
    streams.push(spawnFrConfig({
      command: "fr-config-push",
      environment,
      ...(frScopeSelections ? { scopeSelections: frScopeSelections } : { scopes: frScopes }),
    }).stream);
  }
  if (frodoScopes.length) streams.push(spawnFrodo({ command: "fr-config-push", environment, scopes: frodoScopes }).stream);
  if (igaScopes.length)   streams.push(runIgaApi({ command: "fr-config-push", environment, scopes: igaScopes }).stream);

  const pushStream = streams.length > 0 ? mergeStreams(streams) : new ReadableStream<string>({
    start(c) { c.enqueue(JSON.stringify({ type: "exit", code: 0, ts: Date.now() }) + "\n"); c.close(); }
  });

  const startTime = Date.now();
  const startedAt = new Date(startTime).toISOString();

  // Wrap the push stream to record op-log entry
  const stream = new ReadableStream<string>({
    async start(controller) {
      const reader = pushStream.getReader();
      let lastExitCode = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.enqueue(value);
        for (const line of value.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "exit") lastExitCode = parsed.code;
          } catch {
            // ignore
          }
        }
      }

      // Record op-log entry
      try {
        const scopeList = scopeSelections
          ? scopeSelections.map((s) => s.scope)
          : scopes ?? [];

        let totalItems = 0;
        if (scopeSelections) {
          for (const { items } of scopeSelections) {
            if (items && items.length > 0) totalItems += items.length;
          }
        }

        const scopeNames = scopeList.map((s) => getScopeLabel(s)).join(", ");
        const summary = totalItems > 0
          ? `${totalItems} items across ${scopeList.length} scope${scopeList.length !== 1 ? "s" : ""} (${scopeNames})`
          : `${scopeList.length} scope${scopeList.length !== 1 ? "s" : ""} (${scopeNames})`;

        appendOpLog({
          type: "push",
          environment,
          scopes: scopeList,
          status: lastExitCode === 0 ? "success" : "failed",
          startedAt,
          durationMs: Date.now() - startTime,
          summary,
        });
      } catch {
        // op-log append failed — don't break the stream
      }

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
