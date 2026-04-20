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

export async function POST(req: NextRequest) {
  const body = await req.json();
  const envs = getEnvironments();
  const newEnv: Environment = {
    name: body.name,
    label: body.label,
    color: body.color || "blue",
    type: body.type || "sandbox",
    ...(body.type === "controlled" && body.devEnvironment !== undefined
      ? { devEnvironment: body.devEnvironment }
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
