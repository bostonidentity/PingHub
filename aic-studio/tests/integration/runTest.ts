// tests/integration/runTest.ts
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index.js");

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ["--disable-extensions"]
    });
  } catch (err) {
    console.error("Failed to run tests:", err);
    process.exit(1);
  }
}

void main();
