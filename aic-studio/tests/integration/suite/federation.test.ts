import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Federation", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("federation.openEditor is registered", async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes("aic-studio.federation.openEditor"));
  });

  test("federation.openEditor without node argument does not reject", async () => {
    await assert.doesNotReject(
      Promise.resolve(vscode.commands.executeCommand("aic-studio.federation.openEditor"))
    );
  });

  test("opening aic://env/realm/federation/saml2/id virtual doc returns placeholder", async () => {
    const uri = vscode.Uri.parse("aic://prod/alpha/federation/saml2/sp-acme");
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    assert.ok(text.includes("no snapshot") || text.includes("// "));
  });
});
