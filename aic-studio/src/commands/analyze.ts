import * as vscode from "vscode";
import type { AnalyzeHost } from "../webviews/host/analyzeHost";
import type { JourneyNode, FederationItemNode } from "../providers/envTree";

type TargetNode = JourneyNode | FederationItemNode;

export function registerAnalyzeCommands(
  ctx: vscode.ExtensionContext,
  host: AnalyzeHost
): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.analyze.findUsage", (node?: TargetNode) => {
      if (!node) {
        void vscode.window.showInformationMessage(
          "Right-click a journey or federation item in the Environments tree to find its usages."
        );
        return;
      }
      if ("journeyId" in node) {
        host.open({
          kind: "analyze-open",
          envName: node.envName,
          target: { realm: node.realm, resourceType: "journey", id: node.journeyId }
        });
      } else if ("itemId" in node && "fedType" in node) {
        const rtype = node.fedType === "saml2" || node.fedType === "OAuth2Client"
          ? node.fedType
          : undefined;
        if (!rtype) {
          void vscode.window.showInformationMessage(
            `Find Usage is not supported for federation type "${node.fedType}".`
          );
          return;
        }
        host.open({
          kind: "analyze-open",
          envName: node.envName,
          target: { realm: node.realm, resourceType: rtype, id: node.itemId }
        });
      }
    })
  );
}
