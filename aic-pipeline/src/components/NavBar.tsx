"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useBusyState } from "@/hooks/useBusyState";
import { useWorkingEnv } from "@/hooks/useWorkingEnv";
import { useDialog } from "@/components/ConfirmDialog";
import { cn } from "@/lib/utils";
import type { Environment } from "@/lib/fr-config";

const NAV_ITEMS = [
  { href: "/",             label: "Dashboard" },
  { href: "/sync",         label: "Sync" },
  { href: "/configs",      label: "Browse" },
  { href: "/compare",      label: "Compare" },
  { href: "/promote",      label: "Promote" },
  { href: "/analyze",      label: "Analyze" },
  { href: "/logs",         label: "Logs" },
  { href: "/search",       label: "Search" },
  { href: "/history",      label: "History" },
  { href: "/environments", label: "Environments" },
  { href: "/settings",     label: "Settings" },
];

const COLOR_RING: Record<string, string> = {
  blue:   "bg-blue-400",
  green:  "bg-emerald-400",
  yellow: "bg-amber-400",
  red:    "bg-rose-400",
  slate:  "bg-slate-400",
};

export function NavBar() {
  const { busy, dirty } = useBusyState();
  const warnOnLeave = busy || dirty;
  const pathname = usePathname();
  const router = useRouter();
  const { confirm } = useDialog();
  const [workingEnv] = useWorkingEnv();
  const [envs, setEnvs] = useState<Environment[]>([]);

  useEffect(() => {
    fetch("/api/environments").then((r) => r.ok ? r.json() : []).then(setEnvs).catch(() => {});
  }, []);

  const active = envs.find((e) => e.name === workingEnv);
  const dot = active ? COLOR_RING[active.color] ?? COLOR_RING.slate : "bg-slate-300";

  return (
    <header className="bg-white/80 backdrop-blur border-b border-slate-200/60 sticky top-0 z-50">
      <div className="max-w-[1600px] mx-auto px-6 sm:px-10 lg:px-16">
        <div className="flex items-center justify-between h-14">
          <div className="flex items-center gap-6 min-w-0">
            <Link
              href="/"
              onClick={warnOnLeave ? async (e) => {
                e.preventDefault();
                const ok = await confirm({
                  title: "Leave this page? Progress will be lost.",
                  message: "You have an operation in progress or unsaved task state. Navigating away will discard it.",
                  confirmLabel: "Leave",
                  variant: "warning",
                });
                if (ok) router.push("/");
              } : undefined}
              className="font-semibold text-[15px] tracking-tight shrink-0 text-slate-900"
            >
              AIC Pipeline
            </Link>
            <nav className="flex items-center gap-0.5 overflow-x-auto">
              {NAV_ITEMS.map(({ href, label }) => {
                const isActive = href === "/" ? pathname === "/" : pathname.startsWith(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    onClick={warnOnLeave ? async (e) => {
                      e.preventDefault();
                      const ok = await confirm({
                        title: "Leave this page? Progress will be lost.",
                        message: "You have an operation in progress or unsaved task state. Navigating away will discard it.",
                        confirmLabel: "Leave",
                        variant: "warning",
                      });
                      if (ok) router.push(href);
                    } : undefined}
                    className={cn(
                      "px-3 py-1.5 rounded-lg text-sm transition-colors whitespace-nowrap",
                      isActive
                        ? "bg-indigo-50 text-indigo-700 font-medium"
                        : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
                    )}
                  >
                    {label}
                  </Link>
                );
              })}
            </nav>
          </div>

          {active && (
            <div className="flex items-center gap-2 px-2.5 py-1 border border-slate-200 rounded-lg bg-white text-xs text-slate-600 shrink-0">
              <span className={cn("w-1.5 h-1.5 rounded-full", dot)} />
              <span className="hidden sm:inline text-slate-400">working env</span>
              <span className="font-medium text-slate-700">{active.label}</span>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
