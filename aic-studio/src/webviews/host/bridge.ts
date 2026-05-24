// src/webviews/host/bridge.ts
import { z } from "zod";

// Host → Webview
export const OpenRequestSchema = z.object({
  kind: z.literal("open"),
  envName: z.string(),
  realm: z.string(),
  federationType: z.string(),
  id: z.string()
});
export type OpenRequest = z.infer<typeof OpenRequestSchema>;

export const LoadResponseSchema = z.object({
  kind: z.literal("load"),
  envName: z.string(),
  realm: z.string(),
  federationType: z.string(),
  id: z.string(),
  body: z.record(z.unknown()).nullable()
});
export type LoadResponse = z.infer<typeof LoadResponseSchema>;

export const SaveResponseSchema = z.union([
  z.object({ kind: z.literal("save-result"), ok: z.literal(true) }),
  z.object({ kind: z.literal("save-result"), ok: z.literal(false), error: z.string() })
]);
export type SaveResponse = z.infer<typeof SaveResponseSchema>;

export const HostMessageSchema = z.union([OpenRequestSchema, LoadResponseSchema, SaveResponseSchema]);
export type HostMessage = z.infer<typeof HostMessageSchema>;

// Webview → Host
export const SaveRequestSchema = z.object({
  kind: z.literal("save"),
  envName: z.string(),
  realm: z.string(),
  federationType: z.string(),
  id: z.string(),
  body: z.record(z.unknown())
});
export type SaveRequest = z.infer<typeof SaveRequestSchema>;

export const ReadyRequestSchema = z.object({
  kind: z.literal("ready")
});
export type ReadyRequest = z.infer<typeof ReadyRequestSchema>;

export const WebviewMessageSchema = z.union([SaveRequestSchema, ReadyRequestSchema]);
export type WebviewMessage = z.infer<typeof WebviewMessageSchema>;

// Monitor Dashboard — Host → Webview
export const MonitorSummaryItemSchema = z.object({
  envName: z.string(),
  envLabel: z.string(),
  tls: z.object({
    status: z.string(),
    daysRemaining: z.number().optional(),
    detail: z.string().optional(),
    checkedAt: z.number().optional()
  }).optional(),
  ping: z.object({
    status: z.string(),
    latencyMs: z.number().optional(),
    detail: z.string().optional(),
    checkedAt: z.number().optional()
  }).optional(),
  alertCount: z.number()
});
export type MonitorSummaryItem = z.infer<typeof MonitorSummaryItemSchema>;

export const MonitorSummaryResponseSchema = z.object({
  kind: z.literal("monitor-summary"),
  items: z.array(MonitorSummaryItemSchema)
});
export type MonitorSummaryResponse = z.infer<typeof MonitorSummaryResponseSchema>;

// Monitor Dashboard — Webview → Host
export const MonitorRefreshRequestSchema = z.object({
  kind: z.literal("monitor-refresh")
});
export type MonitorRefreshRequest = z.infer<typeof MonitorRefreshRequestSchema>;

// Logs Query Webview — Host → Webview
export const LogsOpenRequestSchema = z.object({
  kind: z.literal("logs-open"),
  envName: z.string(),
  savedQuery: z.object({
    id: z.number(),
    name: z.string(),
    source: z.string(),
    filterExpr: z.string().optional()
  }).optional()
});
export type LogsOpenRequest = z.infer<typeof LogsOpenRequestSchema>;

export const LogsQueryResultEntrySchema = z.object({
  timestamp: z.string(),
  source: z.string(),
  type: z.string(),
  payload: z.record(z.unknown())
});
export type LogsQueryResultEntry = z.infer<typeof LogsQueryResultEntrySchema>;

export const LogsQueryResponseSchema = z.union([
  z.object({
    kind: z.literal("logs-result"),
    ok: z.literal(true),
    entries: z.array(LogsQueryResultEntrySchema)
  }),
  z.object({
    kind: z.literal("logs-result"),
    ok: z.literal(false),
    error: z.string()
  })
]);
export type LogsQueryResponse = z.infer<typeof LogsQueryResponseSchema>;

export const LogsSaveResponseSchema = z.union([
  z.object({ kind: z.literal("logs-save-result"), ok: z.literal(true), id: z.number() }),
  z.object({ kind: z.literal("logs-save-result"), ok: z.literal(false), error: z.string() })
]);
export type LogsSaveResponse = z.infer<typeof LogsSaveResponseSchema>;

// Logs Query Webview — Webview → Host
export const LogsRunQueryRequestSchema = z.object({
  kind: z.literal("logs-run"),
  envName: z.string(),
  source: z.string(),
  filterExpr: z.string().optional(),
  pageSize: z.number().optional(),
  beginTime: z.string().optional(),
  endTime: z.string().optional()
});
export type LogsRunQueryRequest = z.infer<typeof LogsRunQueryRequestSchema>;

export const LogsSaveQueryRequestSchema = z.object({
  kind: z.literal("logs-save"),
  envName: z.string(),
  name: z.string(),
  source: z.string(),
  filterExpr: z.string().optional()
});
export type LogsSaveQueryRequest = z.infer<typeof LogsSaveQueryRequestSchema>;

export const LogsWebviewMessageSchema = z.union([
  LogsRunQueryRequestSchema,
  LogsSaveQueryRequestSchema
]);
export type LogsWebviewMessage = z.infer<typeof LogsWebviewMessageSchema>;
