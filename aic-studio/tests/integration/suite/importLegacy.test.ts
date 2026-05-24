// tests/integration/suite/importLegacy.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Legacy import", () => {
  test("env.importFromLegacy is registered", async () => {
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(
      cmds.includes("aic-studio.env.importFromLegacy"),
      "command not registered"
    );
  });
});
