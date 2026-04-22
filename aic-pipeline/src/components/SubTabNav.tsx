// src/components/SubTabNav.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export interface SubTab {
  href: string;
  label: string;
}

export function SubTabNav({ tabs }: { tabs: SubTab[] }) {
  const pathname = usePathname();
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
