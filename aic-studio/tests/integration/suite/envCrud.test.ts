// tests/integration/suite/envCrud.test.ts
import * as assert from "node:assert";
import * as vscode from "vscode";

/**
 * The multi-prompt InputBox flow is exercised manually in dev (Task 20).
 * These tests confirm the data layer integration with the running extension
 * host (DB opens, commands are reachable, no crashes on empty state).
 * Full data-layer round-trip is covered by vitest in src/core/db/environments.test.ts.
 */

suite("Env CRUD (command surface)", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("env.setActive command does not reject when no envs exist", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.env.setActive"))
    );
  });

  test("env.remove command does not reject when no envs exist", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.env.remove"))
    );
  });

  test("Environments view registered in PingHub container", async () => {
    // Indirectly verify via the views API — if the view container didn't
    // register, opening it would error out.
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("workbench.view.extension.aic-studio"))
    );
  });
});
