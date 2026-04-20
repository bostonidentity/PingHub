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
    <header className="bg-slate-900/95 backdrop-blur border-b border-slate-800 sticky top-0 z-50">
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
              className="font-semibold text-[15px] tracking-tight shrink-0 text-white"
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
                        ? "bg-indigo-500/15 text-indigo-200 font-medium ring-1 ring-inset ring-indigo-400/20"
                        : "text-slate-300 hover:text-white hover:bg-slate-800/80"
                    )}
                  >
                    {label}
                  </Link>
                );
              })}
            </nav>
          </div>

          {active && (
            <div className="flex items-center gap-2 px-2.5 py-1 border border-slate-700 rounded-lg bg-slate-800/60 text-xs shrink-0">
              <span className={cn("w-1.5 h-1.5 rounded-full", dot)} />
              <span className="hidden sm:inline text-slate-500">working env</span>
              <span className="font-medium text-slate-100">{active.label}</span>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
