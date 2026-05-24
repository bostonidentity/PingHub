// src/providers/sourceControl.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../core/db/environments";
import { findLocallyModifiedJourneys, type ChangedItem } from "../core/diff/snapshotDiff";
import { makeAicUri } from "./virtualDocs";

interface EnvScm {
  scm: vscode.SourceControl;
  changes: vscode.SourceControlResourceGroup;
}

export class EnvSourceControlRegistry {
  private readonly scms = new Map<string, EnvScm>();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly db: Database,
    private readonly globalStoragePath: string
  ) {}

  syncFromDb(): void {
    const envs = listEnvironments(this.db);
    const envNames = new Set(envs.map((e) => e.name));

    for (const [name, entry] of this.scms.entries()) {
      if (!envNames.has(name)) {
        entry.scm.dispose();
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
        const changes = scm.createResourceGroup("changes", "Changes");
        this.ctx.subscriptions.push(scm);
        this.scms.set(env.name, { scm, changes });
      }
    }

    this.refreshChanges();
  }

  /** Recompute Changes group resources for every env. */
  refreshChanges(): void {
    for (const [envName, entry] of this.scms.entries()) {
      const diffs: ChangedItem[] = findLocallyModifiedJourneys(this.globalStoragePath, envName);
      entry.changes.resourceStates = diffs.map((d) => ({
        resourceUri: makeAicUri(envName, d.realm, d.resourceType, d.resourceId),
        decorations: { strikeThrough: false }
      }));
      entry.scm.count = diffs.length;
    }
  }
}
