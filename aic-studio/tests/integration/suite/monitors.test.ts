import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Monitors", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("monitor.pollNow is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.monitor.pollNow"));
  });

  test("monitor.openDashboard is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.monitor.openDashboard"));
  });

  test("monitor.acknowledgeAlert is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.monitor.acknowledgeAlert"));
  });

  test("monitor.pollNow with no envs does not reject", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.monitor.pollNow"))
    );
  });

  test("monitor.acknowledgeAlert without node does not reject", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.monitor.acknowledgeAlert"))
    );
  });
});
