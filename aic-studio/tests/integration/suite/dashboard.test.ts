// tests/integration/suite/dashboard.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Dashboard", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("view.openDashboard is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.view.openDashboard"));
  });

  test("view.openDashboard does not reject", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.view.openDashboard"))
    );
  });
});
