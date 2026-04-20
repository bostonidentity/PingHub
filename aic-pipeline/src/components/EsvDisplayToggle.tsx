"use client";

import { cn } from "@/lib/utils";
import type { EsvDisplayMode } from "@/lib/esv-decode";

interface Props {
  mode: EsvDisplayMode;
  onChange: (m: EsvDisplayMode) => void;
  className?: string;
}

/**
 * Two-segment pill toggling how ESV (variables / secrets) values render:
 *   • base64  — what's on disk
 *   • decoded — base64 decoded as UTF-8 and shown under a `value` field
 * Preference is shared across browse, compare, and dry-run via localStorage.
 */
export function EsvDisplayToggle({ mode, onChange, className }: Props) {
  return (
    <div
      className={cn(
        "flex rounded border border-slate-300 overflow-hidden text-[11px] shrink-0",
        className,
      )}
      title="Toggle how ESV values are displayed"
    >
      {(["base64", "decoded"] as const).map((m, i) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={cn(
            "px-2.5 py-1 transition-colors",
            i > 0 && "border-l border-slate-300",
            mode === m
              ? "bg-sky-600 text-white"
              : "text-slate-500 hover:text-slate-700 hover:bg-slate-100",
          )}
        >
          {m === "base64" ? "Base64" : "Decoded"}
        </button>
      ))}
    </div>
  );
}
