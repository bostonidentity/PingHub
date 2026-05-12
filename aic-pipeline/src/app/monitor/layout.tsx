import { SubTabNav } from "@/components/SubTabNav";

export default function MonitorLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="space-y-2">
            <div>
                <h1 className="text-2xl font-bold text-slate-900">Monitor</h1>
                <p className="text-slate-500 mt-1">
                    Health and status across server endpoints and Remote Connector Server clusters.
                </p>
            </div>
            <SubTabNav
                tabs={[
                    { href: "/monitor/server-status", label: "Server Status" },
                    { href: "/monitor/rcs-status", label: "RCS Status" },
                ]}
            />
            {children}
        </div>
    );
}
