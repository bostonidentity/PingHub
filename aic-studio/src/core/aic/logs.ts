// src/core/aic/logs.ts
import axios from "axios";
import { logsQueryUrl } from "./urls";

export interface LogQueryParams {
  tenantUrl: string;
  apiKey: string;
  apiSecret: string;
  source: string;
  filterExpr?: string;
  pageSize?: number;
  beginTime?: string;
  endTime?: string;
}

export interface LogEntry {
  timestamp: string;
  source: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface LogQueryResult {
  entries: LogEntry[];
  pagedResultsCookie?: string;
}

interface RawLogResponse {
  result: Array<{
    timestamp: string;
    source: string;
    type: string;
    payload: Record<string, unknown>;
  }>;
  pagedResultsCookie?: string;
}

export async function queryLogs(params: LogQueryParams): Promise<LogQueryResult> {
  const url = logsQueryUrl(params.tenantUrl, {
    source: params.source,
    filterExpr: params.filterExpr,
    pageSize: params.pageSize,
    beginTime: params.beginTime,
    endTime: params.endTime
  });
  try {
    const res = await axios.get<RawLogResponse>(url, {
      headers: {
        "x-api-key": params.apiKey,
        "x-api-secret": params.apiSecret,
        Accept: "application/json"
      }
    });
    return {
      entries: res.data.result.map((r) => ({
        timestamp: r.timestamp,
        source: r.source,
        type: r.type,
        payload: r.payload
      })),
      pagedResultsCookie: res.data.pagedResultsCookie
    };
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      const detail = typeof err.response.data === "object"
        ? JSON.stringify(err.response.data)
        : String(err.response.data);
      throw new Error(`AIC logs query returned ${err.response.status}: ${detail}`);
    }
    throw err;
  }
}
