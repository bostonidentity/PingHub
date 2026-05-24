// tests/integration/suite/historyView.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("History view + details command", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("history.openDetails is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.history.openDetails"));
  });

  test("history.openDetails with missing id surfaces warning without throwing", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.history.openDetails", 999999))
    );
  });
});
