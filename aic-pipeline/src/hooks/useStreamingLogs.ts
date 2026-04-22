"use client";

import { useState, useCallback, useRef } from "react";
import type { CompareReport } from "@/lib/diff-types";

export type { CompareReport };

export interface LogEntry {
  type: "stdout" | "stderr" | "exit" | "error" | "scope-start" | "scope-end" | "report" | "git";
  side?: "source" | "target";
  data?: string;
  code?: number;
  scope?: string;
  action?: string;
  hash?: string;
  message?: string;
  warning?: string;
  ts: number;
}

export function useStreamingLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [sourceExitCode, setSourceExitCode] = useState<number | null>(null);
  const [targetExitCode, setTargetExitCode] = useState<number | null>(null);
  const [report, setReport] = useState<CompareReport | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<string> | null>(null);

  const run = useCallback(async (url: string, body: object) => {
    setLogs([]);
    setExitCode(null);
    setSourceExitCode(null);
    setTargetExitCode(null);
    setReport(null);
    setRunning(true);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) {
        const text = await res.text();
        setLogs([{ type: "error", data: text || "Request failed", ts: Date.now() }]);
        setRunning(false);
        return;
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      readerRef.current = reader;
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry: LogEntry = JSON.parse(line);
            if (entry.type === "report") {
              if (entry.data) setReport(JSON.parse(entry.data) as CompareReport);
            } else if ((entry.type as string) === "heartbeat") {
              // Server-side keepalive ping (see fr-config.ts spawnFrConfig).
              // Drop it — it's only there to keep the browser fetch reader
              // from timing out during a long-running PUT.
            } else {
              setLogs((prev) => [...prev, entry]);
              if (entry.type === "exit") {
                if (entry.side === "source") setSourceExitCode(entry.code ?? null);
                else if (entry.side === "target") setTargetExitCode(entry.code ?? null);
                else setExitCode(entry.code ?? null);
              }
            }
          } catch {
            // ignore malformed lines
          }
        }
      }
    } catch (err) {
      // Browser fetch readers raise generic "TypeError: network error" when
      // the server-side stream is interrupted (server crash, dev-server
      // reload, proxy timeout, or a hung upstream that the browser gave up
      // on). The raw message is unhelpful — make it explicit so the operator
      // checks the server console rather than assuming the operation failed.
      const raw = err instanceof Error ? err.message : String(err);
      const isNetworkDrop = err instanceof TypeError && /network|fetch|load failed/i.test(raw);
      const data = isNetworkDrop
        ? `Streaming connection to server was interrupted (${raw}). The operation may still be running, succeeded, or failed on the server — check the dev-server console for the actual outcome before re-running.`
        : raw;
      setLogs((prev) => [
        ...prev,
        { type: "error", data, ts: Date.now() },
      ]);
    } finally {
      setRunning(false);
      readerRef.current = null;
    }
  }, []);

  const abort = useCallback(() => {
    readerRef.current?.cancel();
    setRunning(false);
  }, []);

  const clear = useCallback(() => {
    setLogs([]);
    setExitCode(null);
    setSourceExitCode(null);
    setTargetExitCode(null);
    setReport(null);
  }, []);

  return { logs, running, exitCode, sourceExitCode, targetExitCode, report, run, abort, clear };
}
