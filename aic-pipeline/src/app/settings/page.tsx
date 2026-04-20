import { loadSettings, resolveTargetDir, targetHasGit } from "@/lib/git-settings";
import { SettingsForm } from "./SettingsForm";

export default function SettingsPage() {
  const settings = loadSettings();
  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">Settings</h1>
        <p className="section-subtitle mt-1">App-level preferences.</p>
      </header>
      <SettingsForm
        initialSettings={settings}
        targetDirAbsolute={resolveTargetDir(settings)}
        initialHasGit={targetHasGit(settings)}
      />
    </div>
  );
}
