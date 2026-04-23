import axios from "axios";
import { pLimit } from "./p-limit";
import type { MemberStatus, ProbeResult } from "./types";

export interface FetcherOpts {
  method: "POST";
  token: string;
  timeoutMs: number;
  body?: unknown;
}

export interface FetcherResponse {
  status: number;
  ok: boolean;
  body?: unknown;
}

export type Fetcher = (url: string, opts: FetcherOpts) => Promise<FetcherResponse>;

export const defaultFetcher: Fetcher = async (url, opts) => {
  try {
    const res = await axios({
      url,
      method: opts.method,
      data: opts.body ?? {},
      timeout: opts.timeoutMs,
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
    });
    return { status: res.status, ok: res.status >= 200 && res.status < 300, body: res.data };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    throw new Error(e.code ? `${e.code}: ${e.message ?? "request failed"}` : (e.message ?? String(err)));
  }
};

export interface ProbeConnectorArgs {
  tenantUrl: string;
  name: string;
  token: string;
  timeoutMs: number;
}

export async function probeConnector(args: ProbeConnectorArgs, fetcher: Fetcher = defaultFetcher): Promise<ProbeResult> {
  const start = Date.now();
  const url = `${args.tenantUrl}/openidm/system/${encodeURIComponent(args.name)}?_action=test`;
  try {
    const res = await fetcher(url, { method: "POST", token: args.token, timeoutMs: args.timeoutMs, body: {} });
    const latencyMs = Date.now() - start;
    if (res.ok) return { name: args.name, ok: true, latencyMs, httpStatus: res.status };
    return { name: args.name, ok: false, latencyMs, httpStatus: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return { name: args.name, ok: false, latencyMs, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ProbeAllArgs {
  tenantUrl: string;
  token: string;
  timeoutMs: number;
  concurrency: number;
  connectors: string[];
  fetcher?: Fetcher;
  onResult?: (r: ProbeResult) => void;
}

export interface ProbeConnectorServersArgs {
  tenantUrl: string;
  token: string;
  timeoutMs: number;
}

export async function probeConnectorServers(
  args: ProbeConnectorServersArgs,
  fetcher: Fetcher = defaultFetcher,
): Promise<Record<string, MemberStatus>> {
  const start = Date.now();
  const url = `${args.tenantUrl}/openidm/system?_action=testConnectorServers`;
  const res = await fetcher(url, { method: "POST", token: args.token, timeoutMs: args.timeoutMs, body: {} });
  const latencyMs = Date.now() - start;
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from testConnectorServers`);
  }
  const body = res.body as { openicf?: Array<{ name?: string; ok?: boolean; error?: string }> } | undefined;
  const list = Array.isArray(body?.openicf) ? body!.openicf! : [];
  const out: Record<string, MemberStatus> = {};
  for (const entry of list) {
    if (typeof entry?.name !== "string") continue;
    out[entry.name] = {
      name: entry.name,
      ok: entry.ok === true,
      latencyMs,
      ...(typeof entry.error === "string" ? { error: entry.error } : {}),
    };
  }
  return out;
}

export async function probeAll(args: ProbeAllArgs): Promise<ProbeResult[]> {
  const limit = pLimit(args.concurrency);
  const fetcher = args.fetcher ?? defaultFetcher;
  return Promise.all(
    args.connectors.map((name) =>
      limit(async () => {
        const r = await probeConnector(
          { tenantUrl: args.tenantUrl, name, token: args.token, timeoutMs: args.timeoutMs },
          fetcher,
        );
        args.onResult?.(r);
        return r;
      }),
    ),
  );
}
