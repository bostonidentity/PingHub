// src/app/data/browse/page.tsx
import { getEnvironments } from "@/lib/fr-config";
import { BrowsePanel } from "./BrowsePanel";

export default function DataBrowsePage() {
  const environments = getEnvironments();
  return <BrowsePanel environments={environments} />;
}
