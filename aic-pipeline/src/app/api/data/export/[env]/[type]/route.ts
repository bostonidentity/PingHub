// src/app/api/data/export/[env]/[type]/route.ts
import { NextRequest } from "next/server";
import path from "path";
import fs from "fs";
import { cwd } from "process";

export const dynamic = "force-dynamic";

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tsStamp(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ env: string; type: string }> },
) {
  const { env, type } = await params;
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const format = url.searchParams.get("format") === "csv" ? "csv" : "json";

  const envsRoot = path.join(cwd(), "environments");
  const dir = path.join(envsRoot, env, "managed-data", type);
  if (!fs.existsSync(dir)) return new Response("snapshot not found", { status: 404 });

  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "_manifest.json")
    .sort();

  const matching: Record<string, unknown>[] = [];
  const scalarKeys = new Set<string>();
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf-8");
      if (q && !raw.toLowerCase().includes(q)) continue;
      const record = JSON.parse(raw) as Record<string, unknown>;
      matching.push(record);
      if (format === "csv") {
        for (const [k, v] of Object.entries(record)) {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v == null) {
            scalarKeys.add(k);
          }
        }
      }
    } catch { /* skip */ }
  }

  const filename = `${env}-${type}-${tsStamp()}.${format}`;
  const headers = {
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Type": format === "csv" ? "text/csv" : "application/json",
  };

  if (format === "json") {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("[\n"));
        matching.forEach((r, i) => {
          controller.enqueue(enc.encode(JSON.stringify(r) + (i === matching.length - 1 ? "\n" : ",\n")));
        });
        controller.enqueue(enc.encode("]\n"));
        controller.close();
      },
    });
    return new Response(stream, { headers });
  }

  // CSV
  const cols = [...scalarKeys];
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(cols.map(csvCell).join(",") + "\n"));
      for (const r of matching) {
        controller.enqueue(enc.encode(cols.map((k) => csvCell(r[k])).join(",") + "\n"));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers });
}
