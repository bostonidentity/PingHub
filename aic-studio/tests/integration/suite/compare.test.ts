import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Compare command", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("compare.withEnv command is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.compare.withEnv"));
  });

  test("compare.withEnv without a node argument informs the user gracefully", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.compare.withEnv"))
    );
  });
});
