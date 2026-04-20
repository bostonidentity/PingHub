import { NextRequest } from "next/server";
import { spawn } from "child_process";
import path from "path";

export async function POST(req: NextRequest) {
  const { environment, action } = await req.json() as {
    environment: string;
    action: "restart" | "status";
  };

  if (!environment) {
    return Response.json({ error: "Missing environment" }, { status: 400 });
  }

  const cwd = path.join(process.cwd(), "environments", environment);
  const args = action === "status"
    ? ["restart", "--status"]
    : ["restart"];

  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn("fr-config-push", args, { shell: true, cwd });
    proc.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
    proc.on("error", (err) => resolve({ stdout, stderr: stderr + err.message, exitCode: 1 }));
  });

  return Response.json(result);
}
