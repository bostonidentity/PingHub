// scripts/smoke-suite.mjs
// Minimal entry point — for v1.0 the smoke runner just launches VS Code and
// expects the human to walk through steps manually. v1.1 will add programmatic
// assertions here.

export function run() {
  console.log("AIC Studio smoke session launched. Switch to the VS Code window.");
  return Promise.resolve();
}
