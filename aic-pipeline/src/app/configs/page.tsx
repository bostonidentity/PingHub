import { getEnvironments } from "@/lib/fr-config";
import { ConfigsViewer } from "./ConfigsViewer";

export default function ConfigsPage() {
  const environments = getEnvironments();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">Browse</h1>
        <p className="section-subtitle mt-1">Explore the pulled configuration tree.</p>
      </header>
      <ConfigsViewer environments={environments} />
    </div>
  );
}
