// src/commands/compare.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { listEnvironments } from "../core/db/environments";
import { makeAicUri } from "../providers/virtualDocs";
import type { JourneyNode } from "../providers/envTree";

type Deps = { db: Database };

export function registerCompareCommands(ctx: vscode.ExtensionContext, deps: Deps): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.compare.withEnv", (node?: JourneyNode) =>
      compareWithEnv(deps, node)
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
    "vscode.diff",
    leftUri,
    rightUri,
    `${node.journeyId}: ${node.envName} ↔ ${pick.name}`
  );
}
