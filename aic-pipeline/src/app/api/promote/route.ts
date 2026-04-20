import { NextRequest } from "next/server";
import { spawn } from "child_process";
import { getEnvFileContent } from "@/lib/fr-config";
import { parseEnvFile } from "@/lib/env-parser";
import type { PromoteSubcommand } from "@/lib/fr-config-types";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { environment, subcommand } = body as {
    environment: string;
    subcommand: PromoteSubcommand;
  };

  if (!environment || !subcommand) {
    return new Response("Missing environment or subcommand", { status: 400 });
  }

  const fileVars = parseEnvFile(getEnvFileContent(environment));
  const env = { ...process.env, ...fileVars };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const encode = (data: string, type: "stdout" | "stderr") => {
        controller.enqueue(enc.encode(JSON.stringify({ type, data, ts: Date.now() }) + "\n"));
      };

      const proc = spawn("fr-config-promote", [subcommand], { env, shell: true });

      proc.stdout.on("data", (chunk: Buffer) => encode(chunk.toString(), "stdout"));
      proc.stderr.on("data", (chunk: Buffer) => encode(chunk.toString(), "stderr"));

      proc.on("close", (code) => {
        controller.enqueue(
          enc.encode(JSON.stringify({ type: "exit", code, ts: Date.now() }) + "\n")
        );
        controller.close();
      });

      proc.on("error", (err) => {
        controller.enqueue(
          enc.encode(JSON.stringify({ type: "error", data: err.message, ts: Date.now() }) + "\n")
        );
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
