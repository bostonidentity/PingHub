import { NextRequest, NextResponse } from "next/server";
import {
  getEnvironments,
  saveEnvironments,
  getEnvFileContent,
  saveEnvFile,
  deleteEnvFolder,
  getLogApiCredentials,
  saveLogApiCredentials,
} from "@/lib/fr-config";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const content = getEnvFileContent(name);
  const logApi = getLogApiCredentials(name);
  return NextResponse.json({ content, logApi });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const body = await req.json();
  const envs = getEnvironments();
  const idx = envs.findIndex((e) => e.name === name);
  if (idx === -1) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (body.label) envs[idx].label = body.label;
  if (body.color) envs[idx].color = body.color;
  if (body.type !== undefined) {
    envs[idx].type = body.type;
    if (body.type === "controlled") {
      envs[idx].devEnvironment = body.devEnvironment ?? false;
    } else {
      delete envs[idx].devEnvironment;
    }
  }
  if (body.pageSize !== undefined) {
    if (body.pageSize === null || body.pageSize === "") {
      delete envs[idx].pageSize;
    } else {
      const n = typeof body.pageSize === "number" ? body.pageSize : parseInt(String(body.pageSize), 10);
      if (Number.isFinite(n) && n > 0 && n <= 100000) {
        envs[idx].pageSize = n;
      }
    }
  }
  if (body.healthIntervalMinutes !== undefined) {
    if (body.healthIntervalMinutes === null || body.healthIntervalMinutes === "") {
      delete envs[idx].healthIntervalMinutes;
    } else {
      const n = typeof body.healthIntervalMinutes === "number"
        ? body.healthIntervalMinutes
        : parseInt(String(body.healthIntervalMinutes), 10);
      if (Number.isFinite(n) && n >= 1 && n <= 1440) {
        envs[idx].healthIntervalMinutes = n;
      }
    }
  }
  saveEnvironments(envs);

  if (body.envContent !== undefined) {
    saveEnvFile(name, body.envContent);
  }

  if (body.logApi !== undefined) {
    saveLogApiCredentials(name, body.logApi);
  }

  return NextResponse.json(envs[idx]);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const envs = getEnvironments();
  const filtered = envs.filter((e) => e.name !== name);
  if (filtered.length === envs.length) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  saveEnvironments(filtered);
  deleteEnvFolder(name);
  return NextResponse.json({ ok: true });
}
