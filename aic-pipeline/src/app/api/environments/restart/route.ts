import { NextRequest } from "next/server";
import { restartTenant, getRestartStatus } from "@/lib/tenant-control";

export async function POST(req: NextRequest) {
  const { environment, action } = await req.json() as {
    environment: string;
    action: "restart" | "status";
  };

  if (!environment) {
    return Response.json({ error: "Missing environment" }, { status: 400 });
  }

  const result = action === "status"
    ? await getRestartStatus(environment)
    : await restartTenant(environment);

  return Response.json(result);
}
