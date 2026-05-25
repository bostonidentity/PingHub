import { NextResponse } from "next/server";
import { getEnvironments } from "@/lib/fr-config";
import { summarizeReport } from "@/lib/compare";
import type { CompareReport } from "@/lib/diff-types";
import type { ConfigScope } from "@/lib/fr-config-types";

interface DiffRequest {
  target: string;
  scopes?: ConfigScope[];
  mode?: "dry-run" | "compare";
}

export async function POST(req: Request) {
  let body: DiffRequest;
  try {
    body = (await req.json()) as DiffRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { target, scopes = [], mode = "dry-run" } = body;

  if (!target) {
    return NextResponse.json({ error: "missing target" }, { status: 400 });
  }

  const envs = getEnvironments();
  if (!envs.some((e) => e.name === target)) {
    return NextResponse.json({ error: `unknown target env: ${target}` }, { status: 400 });
  }

  // Build an absolute URL for the internal compare call. Next.js runtime expects
  // absolute URLs when fetching its own routes from a server handler.
  const origin = new URL(req.url).origin;
  const compareUrl = `${origin}/api/compare`;

  let compareRes: Response;
  try {
    compareRes = await fetch(compareUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: { environment: "repo", mode: "local" },
        target: { environment: target, mode: "remote" },
        scopes,
        mode,
      }),
    });
  } catch (e) {
    return NextResponse.json({ error: `compare fetch failed: ${(e as Error).message}` }, { status: 500 });
  }

  if (!compareRes.ok || !compareRes.body) {
    return NextResponse.json({ error: `compare returned ${compareRes.status}` }, { status: 500 });
  }

  // Drain the NDJSON stream and extract the final { type: "report", data: "..." } line.
  let reportJson: string | null = null;
  try {
    const reader = compareRes.body.pipeThrough(new TextDecoderStream()).getReader();
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
          const entry = JSON.parse(line) as { type: string; data?: string };
          if (entry.type === "report" && typeof entry.data === "string") {
            reportJson = entry.data;
          }
        } catch {
          // ignore malformed lines
        }
      }
    }
    // handle trailing buffer
    if (buffer.trim()) {
      try {
        const entry = JSON.parse(buffer) as { type: string; data?: string };
        if (entry.type === "report" && typeof entry.data === "string") {
          reportJson = entry.data;
        }
      } catch {
        // ignore
      }
    }
  } catch (e) {
    return NextResponse.json({ error: `compare stream error: ${(e as Error).message}` }, { status: 500 });
  }

  if (!reportJson) {
    return NextResponse.json({ error: "compare did not emit a report" }, { status: 500 });
  }

  let report: CompareReport;
  try {
    report = JSON.parse(reportJson) as CompareReport;
  } catch (e) {
    return NextResponse.json({ error: `report parse error: ${(e as Error).message}` }, { status: 500 });
  }

  return NextResponse.json(summarizeReport(report));
}
