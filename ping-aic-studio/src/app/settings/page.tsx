import { loadSettings, resolveTargetDir, targetHasGit } from "@/lib/git-settings";
import { SettingsForm } from "./SettingsForm";

// Read git-settings.json on every request — otherwise Next.js prerenders the
// page once (at build time for `next start`) and never picks up edits to the
// settings file.
export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const settings = loadSettings();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">Repo</h1>
        <p className="section-subtitle mt-1">
          Git repository for environment snapshots and history.
        </p>
      </header>
      <SettingsForm
        initialSettings={settings}
        targetDirAbsolute={resolveTargetDir(settings)}
        initialHasGit={targetHasGit(settings)}
      />
    </div>
  );
}
