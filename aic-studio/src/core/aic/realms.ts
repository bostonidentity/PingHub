import type { TokenCache } from "./auth";
import { createAuthedClient } from "./client";
import { realmsListUrl } from "./urls";

interface RealmsResponse {
  result: Array<{ _id: string; name: string; parentPath?: string }>;
  resultCount: number;
}

export async function listRealms(tenantUrl: string, cache: TokenCache): Promise<string[]> {
  const client = createAuthedClient(cache);
  const res = await client.get<RealmsResponse>(realmsListUrl(tenantUrl));
  return res.data.result.map((r) => r.name).filter((n) => n && n !== "/");
}
