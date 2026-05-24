// tests/integration/runTest.ts
import * as path from "node:path";
import * as os from "node:os";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index.js");
    const cachePath = path.join(os.tmpdir(), "vscode-cache");

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ["--disable-extensions", `--user-data-dir=${path.join(os.tmpdir(), "vscode-data")}`],
      cachePath
    });
  } catch (err) {
    console.error("Failed to run tests:", err);
    process.exit(1);
  }
}

void main();
