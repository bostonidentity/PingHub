// tests/integration/suite/compareExtras.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Compare extras", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("compare.withRevision is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.compare.withRevision"));
  });

  test("compare.pickEnvs is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.compare.pickEnvs"));
  });

  test("compare.withRevision without node argument does not reject", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.compare.withRevision"))
    );
  });
});
