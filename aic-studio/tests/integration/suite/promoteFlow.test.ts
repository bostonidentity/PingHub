import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Promote command lifecycle", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("promote.addToTask is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.promote.addToTask"));
  });

  test("promote.runTask is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.promote.runTask"));
  });

  test("promote.archiveTask is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.promote.archiveTask"));
  });

  test("promote.runTask with no tasks does not reject", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.promote.runTask"))
    );
  });

  test("promote.archiveTask with no tasks does not reject", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.promote.archiveTask"))
    );
  });
});
