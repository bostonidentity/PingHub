import { getEnvironments } from "@/lib/fr-config";

import { FederationSamlConsole } from "./FederationSamlConsole";

export default function FederationPage() {
  const environments = getEnvironments();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">Federation</h1>
        <p className="section-subtitle mt-1">
          Review SAML entity providers, metadata, and certificate validity.
        </p>
      </header>
      <FederationSamlConsole environments={environments} />
    </div>
  );
}
