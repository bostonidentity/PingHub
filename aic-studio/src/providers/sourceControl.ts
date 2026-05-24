import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../core/db/environments";

export class EnvSourceControlRegistry {
  private readonly scms = new Map<string, vscode.SourceControl>();

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly db: Database) {}

  /** Create or refresh SourceControl entries for all current envs. */
  syncFromDb(): void {
    const envs = listEnvironments(this.db);
    const envNames = new Set(envs.map((e) => e.name));

    for (const [name, scm] of this.scms.entries()) {
      if (!envNames.has(name)) {
        scm.dispose();
        this.scms.delete(name);
      }
    }
    for (const env of envs) {
      if (!this.scms.has(env.name)) {
        const scm = vscode.scm.createSourceControl(
          `aic-env-${env.name}`,
          `AIC: ${env.label}`,
          vscode.Uri.parse(`aic://${env.name}`)
        );
        scm.acceptInputCommand = {
          command: "aic-studio.sync.push",
          title: "Push to env"
        };
        scm.createResourceGroup("changes", "Changes");
        this.ctx.subscriptions.push(scm);
        this.scms.set(env.name, scm);
      }
    }
  }
}
