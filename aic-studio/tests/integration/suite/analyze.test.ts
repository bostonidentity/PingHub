// tests/integration/suite/analyze.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Analyze (find usage)", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("analyze.findUsage is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.analyze.findUsage"));
  });

  test("analyze.findUsage without node argument does not reject", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.analyze.findUsage"))
    );
  });
});
