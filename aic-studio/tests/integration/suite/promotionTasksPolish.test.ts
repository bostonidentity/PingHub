// tests/integration/suite/promotionTasksPolish.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Promotion tasks polish", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("promote.removeItem is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.promote.removeItem"));
  });

  test("promote.deleteTask is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.promote.deleteTask"));
  });
});
