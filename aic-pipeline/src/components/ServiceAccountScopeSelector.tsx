"use client";

import { cn } from "@/lib/utils";
import { ScopeTagsInput } from "./ScopeTagsInput";

export const KNOWN_SA_SCOPES = [
  "fr:am:*",
  "fr:autoaccess:*",
  "fr:idc:analytics:*",
  "fr:idc:certificate:*",
  "fr:idc:content-security-policy:*",
  "fr:idc:cookie-domain:*",
  "fr:idc:custom-domain:*",
  "fr:idc:dataset:*",
  "fr:idc:esv:*",
  "fr:idc:promotion:*",
  "fr:idc:release:*",
  "fr:idc:sso-cookie:*",
  "fr:idc:telemetry:*",
  "fr:idm:*",
  "fr:iga:*",
] as const;

const KNOWN_SET = new Set<string>(KNOWN_SA_SCOPES);

function parse(value: string): { known: Set<string>; custom: string[] } {
  const tags = value ? value.trim().split(/\s+/) : [];
  return {
    known: new Set(tags.filter((t) => KNOWN_SET.has(t))),
    custom: tags.filter((t) => !KNOWN_SET.has(t)),
  };
}

function combine(known: Set<string>, custom: string[]): string {
  return [
    ...KNOWN_SA_SCOPES.filter((s) => known.has(s)),
    ...custom,
  ].join(" ");
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}

export function ServiceAccountScopeSelector({ value, onChange, disabled }: Props) {
  const { known, custom } = parse(value);

  const toggle = (scope: string) => {
    const next = new Set(known);
    next.has(scope) ? next.delete(scope) : next.add(scope);
    onChange(combine(next, custom));
  };

  const selectAll = () => onChange(combine(new Set(KNOWN_SA_SCOPES), custom));
  const clearAll  = () => onChange(combine(new Set(), custom));

  const setCustom = (v: string) => {
    const customTags = v ? v.trim().split(/\s+/) : [];
    onChange(combine(known, customTags));
  };

  const allSelected = KNOWN_SA_SCOPES.every((s) => known.has(s));

  return (
    <div className="space-y-2">
      {/* Select all / Clear */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-500">Known scopes</span>
        <button
          type="button"
          onClick={allSelected ? clearAll : selectAll}
          disabled={disabled}
          className="text-xs text-sky-600 hover:text-sky-800 disabled:opacity-40"
        >
          {allSelected ? "Clear all" : "Select all"}
        </button>
      </div>

      {/* Known scope pills */}
      <div className="flex flex-wrap gap-1.5">
        {KNOWN_SA_SCOPES.map((scope) => {
          const selected = known.has(scope);
          return (
            <button
              key={scope}
              type="button"
              onClick={() => toggle(scope)}
              disabled={disabled}
              className={cn(
                "px-2 py-0.5 rounded text-xs font-mono border transition-colors select-none disabled:opacity-40",
                selected
                  ? "bg-sky-600 border-sky-600 text-white"
                  : "bg-white border-slate-300 text-slate-600 hover:border-sky-400 hover:text-sky-700"
              )}
            >
              {scope}
            </button>
          );
        })}
      </div>

      {/* Custom scopes */}
      <div className="space-y-1">
        <span className="text-xs text-slate-500">Custom scopes</span>
        <ScopeTagsInput
          value={custom.join(" ")}
          onChange={setCustom}
          placeholder="Add custom scope…"
          disabled={disabled}
        />
      </div>
    </div>
  );
}
