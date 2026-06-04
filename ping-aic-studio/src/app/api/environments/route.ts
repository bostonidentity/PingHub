import { NextRequest, NextResponse } from "next/server";
import {
  getEnvironments,
  saveEnvironments,
  getEnvFileContent,
  saveEnvFile,
  Environment,
} from "@/lib/fr-config";

export const dynamic = "force-dynamic";

export async function GET() {
  const envs = getEnvironments();
  return NextResponse.json(envs);
}

// An env name becomes a folder name and a `/api/environments/<name>` path
// segment, so it must be a safe single segment. (The action endpoints live
// under `/api/environment-ops/*`, so common names like "test" no longer
// collide with API routes.)
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function nameError(name: unknown): string | null {
  if (typeof name !== "string" || name.trim() === "") return "Environment name is required.";
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    return "Environment name cannot contain path separators or be '.'/'..'.";
  }
  if (!NAME_RE.test(name)) {
    return "Environment name may only contain letters, digits, '.', '_' or '-', and must start with a letter or digit.";
  }
  return null;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const nameErr = nameError(body.name);
  if (nameErr) return NextResponse.json({ error: nameErr }, { status: 400 });
  const envs = getEnvironments();
  const newEnv: Environment = {
    name: body.name,
    label: body.label,
    color: body.color || "blue",
    type: body.type || "sandbox",
    ...(body.type === "controlled" && body.devEnvironment !== undefined
      ? { devEnvironment: body.devEnvironment }
      : {}),
    ...(typeof body.pageSize === "number" && body.pageSize > 0 && body.pageSize <= 100000
      ? { pageSize: body.pageSize }
      : {}),
  };

  if (envs.find((e) => e.name === newEnv.name)) {
    return NextResponse.json({ error: "Environment already exists" }, { status: 409 });
  }

  envs.push(newEnv);
  saveEnvironments(envs);
  saveEnvFile(newEnv.name, body.envContent || "");
  return NextResponse.json(newEnv, { status: 201 });
}
