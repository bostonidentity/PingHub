/** Concatenate runner streams sequentially into one, collapsing their `exit`
 *  events into a single trailing exit carrying the max code. */
export function mergeRunnerStreams(streams: ReadableStream<string>[]): ReadableStream<string> {
  if (streams.length === 0) {
    return new ReadableStream<string>({ start(c) { c.enqueue(JSON.stringify({ type: "exit", code: 0, ts: Date.now() }) + "\n"); c.close(); } });
  }
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
