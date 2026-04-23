import { NextResponse } from "next/server";
import { getEnvironments } from "@/lib/fr-config";
import { pLimit } from "@/lib/rcs/p-limit";
import { refreshOne } from "../refresh/route";

const ENV_CONCURRENCY = 3;

export async function POST() {
  const envs = getEnvironments();
  const limit = pLimit(ENV_CONCURRENCY);
  const results = await Promise.all(
    envs.map((e) =>
      limit(async () => {
        const entry = await refreshOne(e.name);
        return { env: e.name, entry };
      }),
    ),
  );
  return NextResponse.json({ results });
}
