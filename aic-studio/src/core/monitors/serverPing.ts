// src/core/monitors/serverPing.ts
import { fetchAccessToken } from "../aic/auth";

export interface ServerPingParams {
  tenantUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface ServerPingResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export async function checkServerPing(params: ServerPingParams): Promise<ServerPingResult> {
  const t0 = Date.now();
  try {
    await fetchAccessToken({
      tenantUrl: params.tenantUrl,
      clientId: params.clientId,
      clientSecret: params.clientSecret
    });
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
