import * as assert from "node:assert";
import * as vscode from "vscode";

suite("Virtual aic:// documents", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension("bostonidentity.aic-studio");
    assert.ok(ext);
    await ext.activate();
  });

  test("opening an aic:// URI with no snapshot returns a friendly placeholder", async () => {
    const uri = vscode.Uri.parse("aic://prod-tenant/alpha/journey/Login");
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    assert.ok(text.includes("no snapshot") || text.includes("// "));
  });

  test("opening an aic:// URI with an unsupported resource type returns a note", async () => {
    const uri = vscode.Uri.parse("aic://prod-tenant/alpha/script/foo");
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.ok(doc.getText().includes("not supported"));
  });
});
