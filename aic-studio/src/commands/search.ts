// src/commands/search.ts
import * as vscode from "vscode";
import type { Database } from "better-sqlite3";
import { buildSearchIndex, queryIndex, type SearchItem } from "../core/search/searchIndex";

type Deps = {
  db: Database;
  globalStoragePath: string;
};

interface QPItem extends vscode.QuickPickItem {
  item: SearchItem;
}

function iconFor(kind: SearchItem["kind"]): string {
  switch (kind) {
    case "env": return "$(globe) ";
    case "journey": return "$(symbol-event) ";
    case "federation": return "$(link) ";
    case "promotionTask": return "$(rocket) ";
  }
}

export function registerSearchCommands(ctx: vscode.ExtensionContext, deps: Deps): void {
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aic-studio.search.configs", async () => {
      const index = buildSearchIndex(deps.db, deps.globalStoragePath);
      if (index.length === 0) {
        void vscode.window.showInformationMessage("Nothing to search yet. Add an environment and run pull.");
        return;
      }
      const qp = vscode.window.createQuickPick<QPItem>();
      qp.placeholder = "Search envs / journeys / federation / promotion tasks…";
      qp.matchOnDescription = true;
      qp.items = index.map((i) => ({
        label: `${iconFor(i.kind)}${i.label}`,
        description: i.detail,
        item: i
      }));
      qp.onDidChangeValue((q) => {
        const filtered = queryIndex(index, q);
        qp.items = filtered.map((i) => ({
          label: `${iconFor(i.kind)}${i.label}`,
          description: i.detail,
          item: i
        }));
      });
      qp.onDidAccept(async () => {
        const picked = qp.selectedItems[0];
        qp.hide();
        if (!picked) return;
        const it = picked.item;
        if (it.uri) {
          await vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(it.uri));
        } else if (it.kind === "env") {
          await vscode.commands.executeCommand("workbench.view.extension.aic-studio");
        } else if (it.kind === "promotionTask") {
          await vscode.commands.executeCommand("workbench.view.extension.aic-studio");
        }
      });
      qp.show();
    })
  );
}
