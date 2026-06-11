"use client";

import { useState, useRef, useEffect } from "react";
import { filterJourneyOptions } from "./journey-search";

interface Props {
  available: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** No config list for this env → allow typing arbitrary journey names. */
  freeText: boolean;
  disabled?: boolean;
}

/** Searchable multi-select for journeys: a combobox popover of checkboxes plus
 * removable chips for the current selection. Degrades to free-text entry when
 * the env has no pulled config. */
export function JourneyMultiSelect({ available, selected, onChange, freeText, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const toggle = (name: string) =>
    onChange(selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name]);
  const remove = (name: string) => onChange(selected.filter((n) => n !== name));
  const addFreeText = () => {
    const n = query.trim();
    if (n && !selected.includes(n)) onChange([...selected, n]);
    setQuery("");
  };

  const options = filterJourneyOptions(available, query);

  return (
    <div className="text-sm" ref={boxRef}>
      <span className="block text-slate-600 mb-1">Journeys (optional)</span>
      <div className="relative">
        <input
          type="text"
          value={query}
          disabled={disabled}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === "Enter" && freeText) { e.preventDefault(); addFreeText(); } }}
          placeholder={freeText ? "type a journey name, Enter to add" : "search journeys…"}
          className="w-64 rounded border border-slate-300 px-2 py-1.5 bg-white disabled:opacity-50"
        />
        {open && !freeText && options.length > 0 && (
          <div className="absolute z-10 mt-1 max-h-60 w-64 overflow-auto rounded border border-slate-300 bg-white shadow">
            {options.map((n) => (
              <label key={n} className="flex items-center gap-2 px-2 py-1 hover:bg-slate-50 cursor-pointer">
                <input type="checkbox" checked={selected.includes(n)} onChange={() => toggle(n)} />
                <span className="font-mono text-xs">{n}</span>
              </label>
            ))}
          </div>
        )}
        {open && !freeText && options.length === 0 && (
          <div className="absolute z-10 mt-1 w-64 rounded border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-500 shadow">
            No journeys match.
          </div>
        )}
      </div>
      {selected.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {selected.map((n) => (
            <span key={n} className="inline-flex items-center gap-1 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-800">
              <span className="font-mono">{n}</span>
              <button type="button" onClick={() => remove(n)} className="text-sky-600 hover:text-sky-900">{"×"}</button>
            </span>
          ))}
          <span className="text-xs text-slate-500">({selected.length})</span>
          <button type="button" onClick={() => onChange([])} className="text-xs text-slate-500 underline hover:text-slate-700">
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
