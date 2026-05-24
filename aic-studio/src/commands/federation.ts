import * as vscode from "vscode";
import type { FederationEditorHost } from "../webviews/host/federationHost";
import type { FederationItemNode } from "../providers/envTree";

export function registerFederationCommands(
  ctx: vscode.ExtensionContext,
  host: FederationEditorHost
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      "aic-studio.federation.openEditor",
      (node?: FederationItemNode) => {
        if (!node) {
          void vscode.window.showInformationMessage(
            "Right-click a federation item in the Environments tree to open the editor."
          );
          return;
        }
        host.open({
          kind: "open",
          envName: node.envName,
          realm: node.realm,
          federationType: node.fedType,
          id: node.itemId
        });
      }
    )
  );
}
