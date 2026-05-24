// scripts/smoke.mjs
// Pre-publish manual smoke test runner.
//
// Sets up a real VS Code instance with this extension loaded, then prompts the
// human runner to walk through key flows against a real AIC sandbox tenant.
//
// Required env vars (set before running):
//   SANDBOX_TENANT_URL     — https://your-sandbox.id.forgerock.io
//   SANDBOX_CLIENT_ID      — OAuth client id with realm + tree read/write scopes
//   SANDBOX_CLIENT_SECRET  — corresponding secret
//
// Usage:
//   cd aic-studio
//   SANDBOX_TENANT_URL=https://... SANDBOX_CLIENT_ID=... SANDBOX_CLIENT_SECRET=... \
//     node scripts/smoke.mjs

import { runTests } from "@vscode/test-electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED = ["SANDBOX_TENANT_URL", "SANDBOX_CLIENT_ID", "SANDBOX_CLIENT_SECRET"];
for (const v of REQUIRED) {
  if (!process.env[v]) {
    console.error(`Missing env var: ${v}`);
    console.error("See script header for full usage.");
    process.exit(2);
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionPath = join(__dirname, "..");

// For v1.0, the smoke harness just launches a real VS Code session with the extension.
// The human runner then walks through the steps documented in the script header.
// Full automated smoke (programmatic command execution + assertions) is v1.1.

try {
  await runTests({
    extensionDevelopmentPath: extensionPath,
    extensionTestsPath: join(__dirname, "smoke-suite.mjs"),
    launchArgs: []
  });
  console.log("\nSmoke launch complete. Human runner should:");
  console.log("  1. Add an env (sandbox tenant URL + creds)");
  console.log("  2. Pull from env");
  console.log("  3. Browse journeys in sidebar");
  console.log("  4. Compare two envs (need at least 2 envs configured)");
  console.log("  5. Add journey to promotion task");
  console.log("  6. Run promotion task");
  console.log("  7. Confirm op_history shows the operations");
  console.log("  8. Open dashboard");
  console.log("  9. Search for a journey via QuickPick");
  console.log("\nIf any step fails: file an issue with label aic-studio:v1-blocker.");
} catch (err) {
  console.error("Failed to launch:", err);
  process.exit(1);
}
