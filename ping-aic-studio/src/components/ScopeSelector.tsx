"use client";

import { useState, useCallback } from "react";
import { CONFIG_SCOPES, ESSENTIALS_SCOPES, ConfigScope, ScopeDisplayEntry } from "@/lib/fr-config-types";
import { cn } from "@/lib/utils";

interface ScopeSelectorProps {
  selected: ConfigScope[];
  onChange: (scopes: ConfigScope[]) => void;
  disabled?: boolean;
  action?: "pull" | "push" | "compare";
}

/** Only scopes fr-config-manager can actually run */
const CLI_SCOPES = CONFIG_SCOPES.filter((s) => s.cliSupported !== false);

/** Essentials is a virtual group whose items mirror real scopes in other groups. */
const ESSENTIALS_GROUP = "Essentials";
const ESSENTIALS_VALUES = new Set(ESSENTIALS_SCOPES.map((s) => s.value));

const GROUPS: Record<string, ScopeDisplayEntry[]> = {
  // Essentials first — entries map to real scopes elsewhere
  [ESSENTIALS_GROUP]: ESSENTIALS_SCOPES.map((s) => {
    const real = CONFIG_SCOPES.find((c) => c.value === s.value)!;
    return { ...real, label: s.label, group: ESSENTIALS_GROUP };
  }),
  // Then the normal groups
  ...CONFIG_SCOPES.reduce<Record<string, ScopeDisplayEntry[]>>((acc, scope) => {
    (acc[scope.group] ??= []).push(scope);
    return acc;
  }, {}),
};

type Mode = "basic" | "advanced";

const GROUP_NAMES = Object.keys(GROUPS);

export function ScopeSelector({ selected, onChange, disabled, action }: ScopeSelectorProps) {
  const [mode, setMode] = useState<Mode>("basic");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const selectedSet = new Set(selected);
  const allSelected = selected.length === CLI_SCOPES.length;

  const q = query.trim().toLowerCase();
  const matchesScope = (s: ScopeDisplayEntry): boolean => {
    if (!q) return true;
    if (s.label.toLowerCase().includes(q)) return true;
    if (s.value.toLowerCase().includes(q)) return true;
    if (s.description?.toLowerCase().includes(q)) return true;
    return false;
  };
  const matchesGroup = (groupName: string, scopes: ScopeDisplayEntry[]): boolean => {
    if (!q) return true;
    if (groupName.toLowerCase().includes(q)) return true;
    return scopes.some(matchesScope);
  };

  // While a search query is active, force advanced view so the user can see
  // matching rows (basic mode only shows group pills). Persisted mode is
  // restored when the query is cleared.
  const effectiveMode: Mode = q ? "advanced" : mode;

  const toggleGroupExpand = useCallback((name: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const expandAllGroups = useCallback(() => setExpandedGroups(new Set(GROUP_NAMES)), []);
  const collapseAllGroups = useCallback(() => setExpandedGroups(new Set()), []);

  const toggle = (value: ConfigScope) => {
    onChange(
      selectedSet.has(value)
        ? selected.filter((s) => s !== value)
        : [...selected, value]
    );
  };

  const toggleGroup = (groupScopes: ScopeDisplayEntry[]) => {
    const groupValues = groupScopes
      .filter((s) => s.cliSupported !== false)
      .map((s) => s.value as ConfigScope);
    const allGroupSelected = groupValues.every((v) => selectedSet.has(v));
    onChange(
      allGroupSelected
        ? selected.filter((s) => !groupValues.includes(s))
        : [...selected, ...groupValues.filter((v) => !selectedSet.has(v))]
    );
  };

  const toggleAll = () => {
    onChange(allSelected ? [] : CLI_SCOPES.map((s) => s.value as ConfigScope));
  };

  return (
    <div className="space-y-2.5">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-slate-700">Config Scopes</span>

        <div className="flex items-center rounded border border-slate-200 overflow-hidden text-xs">
          {(["basic", "advanced"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              disabled={disabled}
              className={cn(
                "px-2 py-0.5 transition-colors capitalize disabled:opacity-40",
                mode === m ? "bg-sky-600 text-white" : "text-slate-500 hover:bg-slate-100"
              )}
            >
              {m}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 ml-1">
          <svg className="w-3 h-3 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find scope…"
            disabled={disabled}
            className="text-[11px] px-2 py-0.5 rounded border border-slate-200 bg-white text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-40 w-44"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-slate-400 hover:text-slate-600 text-xs"
              title="Clear scope filter"
            >
              ✕
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {(selected.length > 0 || query) && (
            <button
              type="button"
              onClick={() => { onChange([]); setQuery(""); }}
              disabled={disabled}
              className="text-xs text-slate-500 hover:text-slate-700 disabled:opacity-40"
              title="Clear selected scopes and the filter input"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={toggleAll}
            disabled={disabled}
            className="text-xs text-sky-600 hover:text-sky-800 disabled:opacity-40"
          >
            {allSelected ? "Deselect all" : "Select all"}
          </button>
        </div>
      </div>

      <p className={cn("text-xs text-slate-400", selected.length > 0 && "invisible")}>
        {action === "push" ? "Select scopes to push." : action === "compare" ? "Select scopes to compare." : "Select scopes to pull."}
      </p>

      {/* Basic mode: group-level pills */}
      {effectiveMode === "basic" && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(GROUPS).filter(([gn, sc]) => matchesGroup(gn, sc)).map(([groupName, scopes]) => {
            const cliGroupValues = scopes
              .filter((s) => s.cliSupported !== false)
              .map((s) => s.value as ConfigScope);
            const allGroupSelected = cliGroupValues.length > 0 && cliGroupValues.every((v) => selectedSet.has(v));
            const someGroupSelected = cliGroupValues.some((v) => selectedSet.has(v));
            const hasCliScopes = cliGroupValues.length > 0;
            return (
              <button
                key={groupName}
                type="button"
                onClick={() => hasCliScopes ? toggleGroup(scopes) : undefined}
                disabled={disabled || !hasCliScopes}
                className={cn(
                  "inline-flex items-center gap-1.5 transition-colors select-none disabled:opacity-40",
                  allGroupSelected
                    ? "px-2.5 py-1 text-[11px] rounded-full bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100 cursor-pointer"
                    : someGroupSelected
                    ? "px-2.5 py-1 text-[11px] rounded-full bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100 cursor-pointer"
                    : "px-2.5 py-1 text-[11px] rounded-full bg-slate-50 text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100 cursor-pointer"
                )}
              >
                {groupName}
                {someGroupSelected && (
                  <span className="text-[10px] text-slate-400">
                    {cliGroupValues.filter((v) => selectedSet.has(v)).length}/{cliGroupValues.length}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Advanced mode: grouped list with descriptions */}
      {effectiveMode === "advanced" && (
      <>
        <div className="flex items-center gap-2 mb-1">
          <button type="button" onClick={expandAllGroups} className="text-xs text-slate-500 hover:text-slate-700 transition-colors">
            Expand All
          </button>
          <button type="button" onClick={collapseAllGroups} className="text-xs text-slate-500 hover:text-slate-700 transition-colors">
            Collapse All
          </button>
        </div>
        <div className="space-y-2.5">
          {Object.entries(GROUPS).filter(([gn, sc]) => matchesGroup(gn, sc)).map(([groupName, scopes]) => {
            const cliGroupValues = scopes
              .filter((s) => s.cliSupported !== false)
              .map((s) => s.value as ConfigScope);
            const allGroupSelected = cliGroupValues.length > 0 && cliGroupValues.every((v) => selectedSet.has(v));
            const someGroupSelected = cliGroupValues.some((v) => selectedSet.has(v));
            const selectedCount = cliGroupValues.filter((v) => selectedSet.has(v)).length;
            // Auto-expand any matching group while a query is active, so the
            // user immediately sees the rows that matched.
            const isExpanded = q ? true : expandedGroups.has(groupName);
            const hasCliScopes = cliGroupValues.length > 0;

            return (
              <div key={groupName} className="border border-slate-200 rounded-xl p-3">
                {/* Group header */}
                <div className="flex items-center justify-between text-[12px] font-semibold text-slate-800 mb-2">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleGroupExpand(groupName)}
                      className="text-slate-400 hover:text-slate-600 transition-colors"
                    >
                      <span className={cn("inline-block text-[10px] transition-transform", isExpanded ? "" : "-rotate-90")}>▼</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => hasCliScopes ? toggleGroup(scopes) : undefined}
                      disabled={disabled || !hasCliScopes}
                      className="flex items-center gap-2 disabled:opacity-40"
                    >
                      <span
                        className={cn(
                          "w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors",
                          allGroupSelected
                            ? "bg-sky-600 border-sky-600"
                            : someGroupSelected
                            ? "bg-sky-200 border-sky-400"
                            : "bg-white border-slate-300"
                        )}
                      >
                        {allGroupSelected && (
                          <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                        {someGroupSelected && !allGroupSelected && (
                          <span className="w-2 h-0.5 bg-sky-600 rounded" />
                        )}
                      </span>
                      <span className={cn(
                        "text-xs font-semibold",
                        allGroupSelected ? "text-sky-700" : someGroupSelected ? "text-sky-600" : "text-slate-600"
                      )}>
                        {groupName}
                      </span>
                    </button>
                  </div>
                  {someGroupSelected && (
                    <span className="text-[10px] text-slate-400">
                      {selectedCount}/{cliGroupValues.length}
                    </span>
                  )}
                </div>
                {groupName === ESSENTIALS_GROUP && isExpanded && (
                  <p className="px-9 pb-1 -mt-0.5 text-[10px] text-slate-400 italic">Quick access — mirrors scopes below</p>
                )}

                {/* Scope rows (collapsible) */}
                {isExpanded && (
                  <div className="divide-y divide-slate-50">
                    {scopes.filter(matchesScope).map((scopeEntry) => {
                      const { value, label, description, cliSupported, commandType } = scopeEntry;
                      const isUnsupported = cliSupported === false;
                      const checked = !isUnsupported && selectedSet.has(value as ConfigScope);
                      return (
                        <label
                          key={value}
                          className={cn(
                            "flex items-start gap-3 px-3 py-2.5 transition-colors select-none",
                            isUnsupported
                              ? "opacity-50 cursor-default"
                              : disabled
                              ? "opacity-40 cursor-not-allowed"
                              : "cursor-pointer hover:bg-slate-50",
                            checked && "bg-sky-50/50"
                          )}
                        >
                          <span
                            className={cn(
                              "mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors",
                              isUnsupported
                                ? "bg-slate-100 border-slate-200"
                                : checked
                                ? "bg-sky-600 border-sky-600"
                                : "bg-white border-slate-300"
                            )}
                            onClick={() => !disabled && !isUnsupported && toggle(value as ConfigScope)}
                          >
                            {checked && (
                              <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </span>
                          <div
                            className="flex-1 min-w-0"
                            onClick={() => !disabled && !isUnsupported && toggle(value as ConfigScope)}
                          >
                            <div className="flex items-center gap-1.5">
                              <span className={cn("text-xs font-medium", checked ? "text-sky-800" : "text-slate-700")}>
                                {label}
                              </span>
                              {isUnsupported && (
                                <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200 leading-none">
                                  No CLI
                                </span>
                              )}
                              {!isUnsupported && commandType === "iga-api" && (
                                <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-teal-100 text-teal-700 border border-teal-200 leading-none">
                                  IGA API
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-400 leading-snug mt-0.5">
                              {description}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </>
      )}
    </div>
  );
}
