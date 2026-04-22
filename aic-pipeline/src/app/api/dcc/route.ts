import { NextRequest } from "next/server";
import {
  getDirectControlState,
  initDirectControl,
  applyDirectControl,
  abortDirectControl,
} from "@/lib/tenant-control";

export async function POST(req: NextRequest) {
  const { environment, subcommand } = await req.json() as {
    environment: string;
    subcommand: string;
    args?: string[];
  };

  if (!environment || !subcommand) {
    return Response.json({ error: "Missing environment or subcommand" }, { status: 400 });
  }

  switch (subcommand) {
    case "direct-control-state":
      return Response.json(await getDirectControlState(environment));
    case "direct-control-init":
      return Response.json(await initDirectControl(environment));
    case "direct-control-apply":
      return Response.json(await applyDirectControl(environment));
    case "direct-control-abort":
      return Response.json(await abortDirectControl(environment));
    default:
      return Response.json({
        stdout: "",
        stderr: `Unsupported dcc subcommand: ${subcommand}`,
        exitCode: 1,
      });
  }
}
