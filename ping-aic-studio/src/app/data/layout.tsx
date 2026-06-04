import { SubTabNav } from "@/components/SubTabNav";
import { RunningJobsPanel } from "./pull/RunningJobsPanel";

export default function DataLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Data</h1>
        <p className="text-slate-500 mt-1">
          Pull managed object records or log records. After that, you can browse pulled managed objects here, or search local logs in the &ldquo;Logs&rdquo; tab.
        </p>
      </div>
      <RunningJobsPanel />
      <SubTabNav
        variant="segmented"
        tabs={[
          { href: "/data/browse", label: "Browse" },
          { href: "/data/pull",   label: "Pull" },
        ]}
      />
      <hr className="border-slate-200 mb-4" />
      {children}
    </div>
  );
}
