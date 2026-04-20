import { getEnvironments } from "@/lib/fr-config";
import { SearchExplorer } from "./SearchExplorer";

export default function SearchPage() {
  const environments = getEnvironments();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">Search</h1>
        <p className="section-subtitle mt-1">Find code snippets across scripts, endpoints, and other config files.</p>
      </header>
      <SearchExplorer environments={environments} />
    </div>
  );
}
