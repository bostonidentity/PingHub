import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Pull flow (command surface)", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("sync.pull command is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.sync.pull"));
  });

  test("sync.pull with no env configured does not reject (shows info message)", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.sync.pull"))
    );
  });
});
