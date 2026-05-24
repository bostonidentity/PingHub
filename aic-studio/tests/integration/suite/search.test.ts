// tests/integration/suite/search.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Search", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("search.configs is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.search.configs"));
  });
});
