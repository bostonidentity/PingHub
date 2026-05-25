"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface ScopeTagsInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function ScopeTagsInput({
  value,
  onChange,
  placeholder,
  disabled,
}: ScopeTagsInputProps) {
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const tags = value ? value.trim().split(/\s+/) : [];

  const addTag = (raw: string) => {
    const tag = raw.trim();
    if (!tag || tags.includes(tag)) return;
    onChange([...tags, tag].join(" "));
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag).join(" "));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === " " || e.key === "Tab") {
      e.preventDefault();
      addTag(input);
      setInput("");
    } else if (e.key === "Backspace" && input === "" && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  };

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className={cn(
        "flex flex-wrap gap-1.5 min-h-[38px] w-full rounded border border-slate-300 px-2 py-1.5 focus-within:ring-2 focus-within:ring-sky-500 focus-within:border-sky-500 cursor-text",
        disabled && "opacity-50 cursor-not-allowed bg-slate-50"
      )}
    >
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-sky-100 border border-sky-300 text-sky-800 font-mono"
        >
          {tag}
          {!disabled && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeTag(tag); }}
              className="text-sky-500 hover:text-sky-800 leading-none"
              aria-label={`Remove ${tag}`}
            >
              ×
            </button>
          )}
        </span>
      ))}
      <input
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (input.trim()) { addTag(input); setInput(""); } }}
        disabled={disabled}
        placeholder={tags.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[120px] text-xs font-mono outline-none bg-transparent placeholder:text-slate-400"
      />
    </div>
  );
}
