import { SubTabNav } from "@/components/SubTabNav";

export default function DataLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Data</h1>
        <p className="text-slate-500 mt-1">
          Pull managed object records from a tenant and browse the snapshot.
        </p>
      </div>
      <SubTabNav
        tabs={[
          { href: "/data/browse", label: "Browse" },
          { href: "/data/pull",   label: "Pull" },
        ]}
      />
      {children}
    </div>
  );
}
