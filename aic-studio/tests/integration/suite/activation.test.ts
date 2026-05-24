// tests/integration/suite/activation.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Activation", () => {
  test("extension is present", () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext, "extension not found");
  });

  test("extension activates without error", async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test("registers all three env commands", async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    await ext?.activate();
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.env.add"));
    assert.ok(all.includes("aic-studio.env.setActive"));
    assert.ok(all.includes("aic-studio.env.remove"));
  });
});
