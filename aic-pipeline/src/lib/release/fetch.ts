import axios from "axios";
import type { ReleaseChannel, ReleaseInfo } from "./types";

export interface ReleaseFetcherOpts {
  method: "GET";
  token: string;
  timeoutMs: number;
}

export interface ReleaseFetcherResponse {
  status: number;
  ok: boolean;
  body?: unknown;
}

export type ReleaseFetcher = (url: string, opts: ReleaseFetcherOpts) => Promise<ReleaseFetcherResponse>;

export interface FetchArgs {
  tenantUrl: string;
  token: string;
  timeoutMs: number;
}

export const defaultReleaseFetcher: ReleaseFetcher = async (url, opts) => {
  try {
    const res = await axios({
      url,
      method: opts.method,
      timeout: opts.timeoutMs,
      headers: { Authorization: `Bearer ${opts.token}` },
      validateStatus: () => true,
    });
    return { status: res.status, ok: res.status >= 200 && res.status < 300, body: res.data };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    throw new Error(e.code ? `${e.code}: ${e.message ?? "request failed"}` : (e.message ?? String(err)));
  }
};

export async function fetchReleaseInfo(
  args: FetchArgs,
  fetcher: ReleaseFetcher = defaultReleaseFetcher,
): Promise<ReleaseInfo> {
  const url = `${args.tenantUrl}/environment/release`;
  const res = await fetcher(url, { method: "GET", token: args.token, timeoutMs: args.timeoutMs });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from /environment/release`);
  }
  const body = res.body as { channel?: unknown; currentVersion?: unknown; nextUpgrade?: unknown } | undefined;
  const channel = body?.channel;
  const currentVersion = body?.currentVersion;
  if (channel !== "regular" && channel !== "rapid") {
    throw new Error(`Unexpected release shape: missing/invalid "channel"`);
  }
  if (typeof currentVersion !== "string" || currentVersion.length === 0) {
    throw new Error(`Unexpected release shape: missing "currentVersion"`);
  }
  const nextUpgrade = typeof body?.nextUpgrade === "string" ? body.nextUpgrade : null;
  return { channel: channel as ReleaseChannel, currentVersion, nextUpgrade };
}
