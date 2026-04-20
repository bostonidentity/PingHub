"use client";

import { useEffect, useState, useCallback } from "react";
import type { ViewableFile } from "@/app/api/push/item/route";
import { FileContentViewer } from "@/components/FileContentViewer";
import { cn } from "@/lib/utils";

interface AuditItem {
  id: string;
  label: string;
}

interface ItemViewerProps {
  environment: string;
  scope: string;
  item: AuditItem;
  onClose: () => void;
}

export function ItemViewer({ environment, scope, item, onClose }: ItemViewerProps) {
  const [files, setFiles] = useState<ViewableFile[] | null>(null);
  const [activeTab, setActiveTab] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setFiles(null);
    setActiveTab(0);
    const params = new URLSearchParams({ environment, scope, item: item.id });
    fetch(`/api/push/item?${params}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data: { files: ViewableFile[] }) => setFiles(data.files))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [environment, scope, item.id]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (fullscreen) setFullscreen(false);
        else onClose();
      }
    },
    [onClose, fullscreen]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const activeFile = files?.[activeTab];

  const handleCopy = () => {
    if (!activeFile) return;
    navigator.clipboard.writeText(activeFile.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex",
        fullscreen ? "" : "items-center justify-center bg-black/40"
      )}
      onClick={(e) => { if (e.target === e.currentTarget && !fullscreen) onClose(); }}
    >
      <div
        className={cn(
          "relative flex flex-col overflow-hidden",
          fullscreen
            ? "w-full h-full bg-slate-950"
            : "bg-slate-950 rounded-lg shadow-xl w-[840px] max-w-[95vw] max-h-[85vh]"
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-800 bg-slate-900 shrink-0">
          <div className="flex-1 min-w-0">
            <p className="text-[10px] text-slate-500 uppercase tracking-wide">{scope}</p>
            <p className="text-sm font-mono font-medium text-slate-200 truncate">{item.label}</p>
          </div>

          {/* Copy button */}
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors shrink-0"
          >
            {copied ? (
              <>
                <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-emerald-400">Copied</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                </svg>
                <span>Copy</span>
              </>
            )}
          </button>

          {/* Fullscreen toggle */}
          <button
            type="button"
            onClick={() => setFullscreen((f) => !f)}
            title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            className="text-slate-400 hover:text-slate-200 transition-colors shrink-0"
          >
            {fullscreen ? (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
              </svg>
            )}
          </button>

          {/* Close button */}
          <button
            type="button"
            onClick={fullscreen ? () => setFullscreen(false) : onClose}
            title="Close (Esc)"
            className="text-slate-400 hover:text-slate-200 transition-colors shrink-0"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs (only when multiple files) */}
        {files && files.length > 1 && (
          <div className="flex gap-0 border-b border-slate-800 bg-slate-900 shrink-0 overflow-x-auto">
            {files.map((f, i) => (
              <button
                key={f.name}
                type="button"
                onClick={() => { setActiveTab(i); setCopied(false); }}
                className={cn(
                  "px-4 py-2 text-xs font-mono shrink-0 border-b-2 transition-colors",
                  i === activeTab
                    ? "text-sky-400 border-sky-500"
                    : "text-slate-500 hover:text-slate-300 border-transparent"
                )}
              >
                {f.name}
              </button>
            ))}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto min-h-0">
          {loading && (
            <div className="flex items-center justify-center h-40 text-sm text-slate-500">
              Loading…
            </div>
          )}
          {error && (
            <div className="flex items-center justify-center h-40 text-sm text-red-400">
              {error}
            </div>
          )}
          {activeFile && (
            <FileContentViewer
              content={activeFile.content}
              fileName={activeFile.name}
              language={
                activeFile.language === "json" ? "json"
                : activeFile.language === "javascript" ? "js"
                : activeFile.language === "groovy" ? "groovy"
                : "text"
              }
              className="min-h-full"
            />
          )}
        </div>

        {/* Footer */}
        {activeFile && (
          <div className="flex items-center gap-2 px-4 py-2 border-t border-slate-800 bg-slate-900 shrink-0">
            <span className="text-[10px] text-slate-500 font-mono">{activeFile.name}</span>
            <span className="text-[10px] text-slate-700">·</span>
            <span className="text-[10px] text-slate-500">{activeFile.language}</span>
            <span className="text-[10px] text-slate-600 ml-auto">ESC to {fullscreen ? "exit fullscreen" : "close"}</span>
          </div>
        )}
      </div>
    </div>
  );
}
