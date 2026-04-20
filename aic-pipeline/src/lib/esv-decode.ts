/**
 * Utilities for toggling ESV (variables/secrets) display between the raw
 * `valueBase64` form stored on disk and a `value` field with the base64
 * decoded as UTF-8 — used by the browse, compare, and dry-run views.
 */

import { useEffect, useState } from "react";

export type EsvDisplayMode = "base64" | "decoded";

const STORAGE_KEY = "esv:displayMode";

/** True for paths like `esvs/variables/foo.json` or `esvs/secrets/bar.json`. */
export function isEsvPath(relPath: string | undefined | null): boolean {
  if (!relPath) return false;
  return /(^|\/)esvs\/(variables|secrets)\//.test(relPath);
}

/** True for scope keys that display ESVs in the browse viewer. */
export function isEsvScope(scope: string | undefined | null): boolean {
  return scope === "variables" || scope === "secrets";
}

function base64Utf8Decode(b64: string): string | null {
  try {
    if (typeof atob === "function") {
      const bin = atob(b64);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    }
    // Node fallback (SSR path)
    return Buffer.from(b64, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * Transform an ESV JSON so `valueBase64` is replaced with a `value` field
 * containing the UTF-8 decoded text. Placeholders like `${...}` (fr-config-
 * manager substitution tokens) are left alone. Non-JSON input, or JSON
 * without `valueBase64`, is returned unchanged.
 */
export function decodeEsvContent(content: string): string {
  if (!content) return content;
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    return content;
  }
  if (!obj || typeof obj !== "object") return content;
  const rec = obj as Record<string, unknown>;
  const b64 = rec.valueBase64;
  if (typeof b64 !== "string") return content;
  if (b64.startsWith("${")) return content; // unresolved placeholder
  const decoded = base64Utf8Decode(b64);
  if (decoded == null) return content;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (k === "valueBase64") out.value = decoded;
    else out[k] = v;
  }
  return JSON.stringify(out, null, 2);
}

/** Apply `decodeEsvContent` conditionally based on a display mode. */
export function applyEsvDecoding(content: string, mode: EsvDisplayMode): string {
  return mode === "decoded" ? decodeEsvContent(content) : content;
}

/**
 * React hook storing the chosen display mode in localStorage so the toggle
 * is remembered across pages (browse ↔ compare ↔ dry-run) and sessions.
 * Default is `"base64"` (what's on disk).
 */
export function useEsvDisplayMode(): [EsvDisplayMode, (m: EsvDisplayMode) => void] {
  const [mode, setModeState] = useState<EsvDisplayMode>(() => {
    if (typeof window === "undefined") return "base64";
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "decoded" ? "decoded" : "base64";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setModeState(e.newValue === "decoded" ? "decoded" : "base64");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setMode = (m: EsvDisplayMode) => {
    setModeState(m);
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, m);
  };

  return [mode, setMode];
}
