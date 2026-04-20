import { NextRequest, NextResponse } from "next/server";
import { getEnvironments, saveEnvironments } from "@/lib/fr-config";

export async function PUT(req: NextRequest) {
  const { order } = (await req.json()) as { order: string[] };
  if (!Array.isArray(order)) {
    return NextResponse.json({ error: "order must be an array" }, { status: 400 });
  }

  const envs = getEnvironments();
  const envMap = new Map(envs.map((e) => [e.name, e]));

  // Reorder based on the provided name order
  const reordered = order
    .map((name) => envMap.get(name))
    .filter((e): e is NonNullable<typeof e> => !!e);

  // Append any envs not in the order list (safety)
  for (const e of envs) {
    if (!order.includes(e.name)) reordered.push(e);
  }

  saveEnvironments(reordered);
  return NextResponse.json({ ok: true });
}
