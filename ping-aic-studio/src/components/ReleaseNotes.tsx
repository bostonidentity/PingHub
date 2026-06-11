"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * GitHub release notes for the update popups, rendered as markdown.
 * react-markdown renders to React elements (no innerHTML), so embedded raw
 * HTML in a release body is ignored rather than injected. Styling is mapped
 * per element — the app has no typography plugin.
 */
export function ReleaseNotes({ notes }: { notes: string }) {
    return (
        <div className="max-h-[60vh] overflow-y-auto rounded bg-slate-50 p-3 text-xs text-slate-700">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    h1: ({ children }) => <h3 className="mb-1 mt-2 text-sm font-semibold text-slate-800 first:mt-0">{children}</h3>,
                    h2: ({ children }) => <h4 className="mb-1 mt-2 text-xs font-semibold text-slate-800 first:mt-0">{children}</h4>,
                    h3: ({ children }) => <h5 className="mb-1 mt-2 text-xs font-semibold text-slate-700 first:mt-0">{children}</h5>,
                    p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                    ul: ({ children }) => <ul className="mb-2 list-disc space-y-0.5 pl-4 last:mb-0">{children}</ul>,
                    ol: ({ children }) => <ol className="mb-2 list-decimal space-y-0.5 pl-4 last:mb-0">{children}</ol>,
                    a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noreferrer" className="text-sky-700 underline">{children}</a>
                    ),
                    code: ({ children }) => <code className="rounded bg-slate-200 px-1 py-0.5 font-mono text-[11px]">{children}</code>,
                    pre: ({ children }) => <pre className="mb-2 overflow-x-auto rounded bg-slate-200 p-2 last:mb-0">{children}</pre>,
                    table: ({ children }) => <table className="mb-2 border-collapse text-[11px] last:mb-0">{children}</table>,
                    th: ({ children }) => <th className="border border-slate-300 px-2 py-0.5 text-left font-semibold">{children}</th>,
                    td: ({ children }) => <td className="border border-slate-300 px-2 py-0.5">{children}</td>,
                }}
            >
                {notes}
            </ReactMarkdown>
        </div>
    );
}
