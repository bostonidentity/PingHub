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
