// src/components/SubTabNav.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export interface SubTab {
  href: string;
  label: string;
}

// "tabs"      — subtle underlined text tabs (default).
// "segmented" — a prominent segmented control with clearly button-like
//               controls; use when the sub-tabs are primary actions that
//               should stand out (e.g. the Data tab's Browse / Pull).
export type SubTabVariant = "tabs" | "segmented";

export function SubTabNav({
  tabs,
  variant = "tabs",
}: {
  tabs: SubTab[];
  variant?: SubTabVariant;
}) {
  const pathname = usePathname();

  if (variant === "segmented") {
    return (
      <nav className="inline-flex items-center gap-1 rounded-xl bg-slate-100 p-1 ring-1 ring-inset ring-slate-200 mb-4">
        {tabs.map(({ href, label }) => {
          const isActive = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "px-4 py-2 rounded-lg text-sm font-medium transition-colors",
                isActive
                  ? "bg-white text-indigo-700 shadow-sm ring-1 ring-inset ring-slate-200"
                  : "text-slate-600 hover:text-slate-900 hover:bg-white/70",
              )}
            >
              {label}
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    <nav className="flex items-center gap-0.5 border-b border-slate-200 pb-2 mb-4">
      {tabs.map(({ href, label }) => {
        const isActive = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "px-3 py-1.5 rounded-lg text-sm transition-colors",
              isActive
                ? "bg-indigo-50 text-indigo-700 font-medium ring-1 ring-inset ring-indigo-200"
                : "text-slate-600 hover:text-slate-900 hover:bg-slate-100",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
