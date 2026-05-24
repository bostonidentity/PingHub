// src/commands/compare.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../core/db/environments";
import { makeAicUri } from "../providers/virtualDocs";
import type { JourneyNode } from "../providers/envTree";
import { listAllSnapshotsForEnv } from "../core/snapshots/paths";

type Deps = { db: Database; globalStoragePath: string };

export function registerCompareCommands(ctx: vscode.ExtensionContext, deps: Deps): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.compare.withEnv", (node?: JourneyNode) =>
      compareWithEnv(deps, node)
    ),
    vscode.commands.registerCommand("aic-studio.compare.withRevision", (node?: JourneyNode) =>
      compareWithRevision(deps, node)
    ),
    vscode.commands.registerCommand("aic-studio.compare.pickEnvs", () =>
      comparePickEnvs(deps)
    )
  );
}

async function compareWithEnv(deps: Deps, node?: JourneyNode): Promise<void> {
  if (!node) {
    void vscode.window.showInformationMessage(
      "Right-click a journey in the Environments tree to compare with another env."
    );
    return;
  }
  const others = listEnvironments(deps.db).filter((e) => e.name !== node.envName);
  if (others.length === 0) {
    void vscode.window.showInformationMessage("No other environment to compare against.");
    return;
  }
  const pick = await vscode.window.showQuickPick(
    others.map((e) => ({ label: e.label, description: e.name, name: e.name })),
    { placeHolder: `Compare ${node.envName}/${node.realm}/${node.journeyId} with…` }
  );
  if (!pick) return;
  const leftUri = makeAicUri(node.envName, node.realm, "journey", node.journeyId);
  const rightUri = makeAicUri(pick.name, node.realm, "journey", node.journeyId);
  await vscode.commands.executeCommand(
    "vscode.diff", leftUri, rightUri,
    `${node.journeyId}: ${node.envName} ↔ ${pick.name}`
  );
}

async function compareWithRevision(deps: Deps, node?: JourneyNode): Promise<void> {
  if (!node) {
    void vscode.window.showInformationMessage(
      "Right-click a journey in the Environments tree to compare with an older revision."
    );
    return;
  }
  const stamps = listAllSnapshotsForEnv(deps.globalStoragePath, node.envName);
  if (stamps.length < 2) {
    void vscode.window.showInformationMessage(
      `Only ${stamps.length} snapshot${stamps.length === 1 ? "" : "s"} for "${node.envName}". Pull at least twice to compare revisions.`
    );
    return;
  }
  const prior = stamps.slice(1);
  const pick = await vscode.window.showQuickPick(
    prior.map((p) => ({
      label: p.split("/").pop()!,
      description: "older snapshot",
      stampDir: p
    })),
    { placeHolder: `Compare ${node.realm}/${node.journeyId} (latest) against which prior snapshot?` }
  );
  if (!pick) return;

  const leftUri = makeAicUri(node.envName, node.realm, "journey", node.journeyId);
  const rightUri = vscode.Uri.from({
    scheme: "aic",
    authority: node.envName,
    path: `/${node.realm}/journey/${node.journeyId}`,
    query: `rev=${encodeURIComponent(pick.label)}`
  });
  await vscode.commands.executeCommand(
    "vscode.diff", rightUri, leftUri,
    `${node.journeyId}: ${pick.label} → latest`
  );
}

async function comparePickEnvs(deps: Deps): Promise<void> {
  const envs = listEnvironments(deps.db);
  if (envs.length < 2) {
    void vscode.window.showInformationMessage("Need at least 2 environments to compare.");
    return;
  }
  const leftPick = await vscode.window.showQuickPick(
    envs.map((e) => ({ label: e.label, description: e.name, name: e.name })),
    { placeHolder: "Left env" }
  );
  if (!leftPick) return;
  const rightPick = await vscode.window.showQuickPick(
    envs.filter((e) => e.name !== leftPick.name).map((e) => ({ label: e.label, description: e.name, name: e.name })),
    { placeHolder: `Right env (vs ${leftPick.name})` }
  );
  if (!rightPick) return;
  const realm = await vscode.window.showInputBox({ prompt: "Realm", placeHolder: "alpha" });
  if (!realm) return;
  const journeyId = await vscode.window.showInputBox({ prompt: "Journey ID", placeHolder: "Login" });
  if (!journeyId) return;
  const leftUri = makeAicUri(leftPick.name, realm, "journey", journeyId);
  const rightUri = makeAicUri(rightPick.name, realm, "journey", journeyId);
  await vscode.commands.executeCommand(
    "vscode.diff", leftUri, rightUri,
    `${journeyId}: ${leftPick.name} ↔ ${rightPick.name}`
  );
}
