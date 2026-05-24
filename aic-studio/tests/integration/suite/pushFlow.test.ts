import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Push flow (command surface)", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("sync.push command is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.sync.push"));
  });

  test("sync.push without a node argument informs the user gracefully", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.sync.push"))
    );
  });
});
