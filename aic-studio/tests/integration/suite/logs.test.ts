// tests/integration/suite/logs.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Logs", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("logs.openQueryEditor is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.logs.openQueryEditor"));
  });

  test("logs.runSavedQuery is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.logs.runSavedQuery"));
  });

  test("logs.deleteSavedQuery is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.logs.deleteSavedQuery"));
  });

  test("logs.openQueryEditor with no envs does not reject", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.logs.openQueryEditor"))
    );
  });

  test("logs.runSavedQuery without id does not reject", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.logs.runSavedQuery"))
    );
  });
});
